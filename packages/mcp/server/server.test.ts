import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "@modelcontextprotocol/sdk/types.js";

const toolHandlers = new Map<string, () => Promise<unknown>>();

vi.mock("@modelcontextprotocol/ext-apps/server", () => ({
  RESOURCE_MIME_TYPE: "text/html",
  registerAppTool: (_server: unknown, name: string, _config: unknown, handler: () => Promise<unknown>) => {
    toolHandlers.set(name, handler);
  },
  registerAppResource: vi.fn(),
}));

describe("server configuration", () => {
  let tempDir: string;

  beforeEach(async () => {
    toolHandlers.clear();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "event-artillery-mcp-"));
    process.env.AWS_REGION = "us-east-1";
    delete process.env.EVENTS_YAML_PATH;
    delete process.env.EXAMPLES_DIR;
    process.env.INIT_CWD = tempDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.INIT_CWD;
  });

  it("rejects relative defaults in multi-root workspaces", async () => {
    const rootA = path.join(tempDir, "a");
    const rootB = path.join(tempDir, "b");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeFile(path.join(rootA, "events.yaml"), "asyncapi: 3.0.0\ninfo:\n  title: A\n  version: 1.0.0\noperations: {}\n", "utf8");
    await writeFile(path.join(rootB, "events.yaml"), "asyncapi: 3.0.0\ninfo:\n  title: B\n  version: 1.0.0\noperations: {}\n", "utf8");

    const roots: Root[] = [
      { uri: `file://${rootA}`, name: "a" },
      { uri: `file://${rootB}`, name: "b" },
    ];

    const { createServer } = await import("./server.js");
    const server = createServer();
    vi.spyOn(server.server, "listRoots").mockResolvedValue({ roots });

    const sendEvent = toolHandlers.get("send-event");
    expect(sendEvent).toBeDefined();

    await expect(sendEvent!()).rejects.toThrow(
      "Multiple MCP workspace roots were provided. Set EVENTS_YAML_PATH and EXAMPLES_DIR to absolute paths in multi-root workspaces.",
    );
  });

  it("retries spec loading after an initial read failure", async () => {
    const eventsPath = path.join(tempDir, "events.yaml");
    process.env.EVENTS_YAML_PATH = eventsPath;
    await writeFile(
      eventsPath,
      "not valid yaml: [",
      "utf8",
    );

    const { createServer } = await import("./server.js");
    const server = createServer();
    vi.spyOn(server.server, "listRoots").mockResolvedValue({ roots: [] });

    const sendEvent = toolHandlers.get("send-event");
    expect(sendEvent).toBeDefined();

    await expect(sendEvent!()).rejects.toThrow();

    await writeFile(
      eventsPath,
      "asyncapi: 3.0.0\ninfo:\n  title: Example\n  version: 1.0.0\noperations: {}\n",
      "utf8",
    );

    await expect(sendEvent!()).resolves.toMatchObject({
      structuredContent: { events: [] },
    });
  });
});
