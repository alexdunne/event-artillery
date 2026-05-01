/**
 * Event Artillery MCP — MCP server
 *
 * Environment variables (all optional):
 *   EVENTS_YAML_PATH  Path to your AsyncAPI events.yaml (default: ./events.yaml)
 *   EXAMPLES_DIR      Directory for saved examples (default: ./examples)
 *   EVENT_BUS_NAME    EventBridge bus name (default: "my-event-bus")
 *   EVENT_SOURCE      EventBridge source field (default: "event-artillery")
 *   AWS_REGION        AWS region (default: "us-east-1")
 *   AWS_PROFILE       Shared AWS config/credentials profile for EventBridge requests
 */

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  Root,
  ReadResourceResult,
  RootsListChangedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  TOOL_NAMES,
  loadSpec,
  getProducedEvents,
  generateValue,
  listSavedExamples,
  createEventBridgeClient,
  getDefaultEventBridgeConfig,
  sendEvent,
  resolveFromBase,
  fileUriToPath,
  ConfigError,
  type PathsConfig,
} from "@event-artillery/core";

// Read version from package.json at runtime. Tries ../package.json first (local dev and npm
// install layout where dist/ sits inside the package root), then falls back gracefully.
const _pkgRequire = createRequire(import.meta.url);
function readPkgVersion(): string {
  try { return (_pkgRequire("../package.json") as { version: string }).version; } catch {}
  try { return (_pkgRequire("./package.json") as { version: string }).version; } catch {}
  return "0.0.0";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ebConfig = getDefaultEventBridgeConfig();

// dist/ directory — always sibling to this compiled file
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

const PKG_VERSION = readPkgVersion();

// Singleton EventBridge client — shared across all tool calls
const eventBridgeClient = createEventBridgeClient(ebConfig);

// ---------------------------------------------------------------------------
// Response helpers — reduce repeated boilerplate in tool handlers
// ---------------------------------------------------------------------------
function toolOk(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function toolErr(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: structured ?? { error: text },
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Event Artillery MCP",
    version: PKG_VERSION,
  });

  let cachedPathsConfigPromise: Promise<PathsConfig> | null = null;

  async function getWorkspaceRoots(): Promise<Root[]> {
    try {
      const result = await server.server.listRoots();
      return result.roots.filter((root) => root.uri.startsWith("file://"));
    } catch {
      return [];
    }
  }

  async function getBaseDir(): Promise<string> {
    const roots = await getWorkspaceRoots();
    if (roots.length === 1) {
      return path.resolve(fileUriToPath(roots[0].uri) ?? process.env.INIT_CWD ?? process.cwd());
    }

    if (roots.length > 1) {
      throw new ConfigError(
        "Multiple MCP workspace roots were provided. Set EVENTS_YAML_PATH and EXAMPLES_DIR to absolute paths in multi-root workspaces.",
      );
    }

    return path.resolve(process.env.INIT_CWD ?? process.cwd());
  }

  async function getPathsConfig(): Promise<PathsConfig> {
    if (!cachedPathsConfigPromise) {
      cachedPathsConfigPromise = (async () => {
        const baseDir = await getBaseDir();
        const eventsYamlPath = resolveFromBase(baseDir, process.env.EVENTS_YAML_PATH, "events.yaml");
        const examplesDir = resolveFromBase(baseDir, process.env.EXAMPLES_DIR, "examples");

        if (!fsSync.existsSync(eventsYamlPath)) {
          throw new ConfigError(
            `events.yaml not found at: ${eventsYamlPath}\n` +
              "Set EVENTS_YAML_PATH to the path of your AsyncAPI events.yaml file.\n" +
              `Relative paths resolve from: ${baseDir}\n` +
              "When available, this base directory comes from the client's MCP workspace roots.\n" +
              "Example: EVENTS_YAML_PATH=events.yaml",
          );
        }

        return { baseDir, eventsYamlPath, examplesDir };
      })();
    }

    return cachedPathsConfigPromise;
  }

  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async (_notification: RootsListChangedNotification) => {
      cachedPathsConfigPromise = null;
    },
  );

  const resourceUri = "ui://send-event/mcp-app.html";

  // ------------------------------------------------------------------
  // Tool: send-event (main tool with UI)
  // ------------------------------------------------------------------
  registerAppTool(
    server,
    TOOL_NAMES.SEND_EVENT,
    {
      title: "Send Event",
      description:
        "Send an event to AWS EventBridge, including requests like 'send an order.created event'. " +
        "Opens a UI to choose an event type from events.yaml, generate or edit the payload, save examples, and send it.",
      inputSchema: {},
      _meta: { ui: { resourceUri } },
    },
    async (): Promise<CallToolResult> => {
      const config = await getPathsConfig();
      const doc = await loadSpec(config.eventsYamlPath);
      const events = getProducedEvents(doc);
      return toolOk(`Found ${events.length} events available to send.`, {
        events: events.map(({ eventName, description, version }) => ({
          name: eventName,
          description,
          version,
        })),
      });
    },
  );

  // ------------------------------------------------------------------
  // Tool: generate-event-payload (app-only)
  // ------------------------------------------------------------------
  registerAppTool(
    server,
    TOOL_NAMES.GENERATE_PAYLOAD,
    {
      title: "Generate Event Payload",
      description:
        "Generate a sample payload for a named event type from events.yaml and list saved examples for that event.",
      inputSchema: { eventName: z.string() },
      _meta: { ui: { visibility: ["app"] as const } },
    },
    async ({ eventName }: { eventName: string }): Promise<CallToolResult> => {
      const config = await getPathsConfig();
      const doc = await loadSpec(config.eventsYamlPath);
      const events = getProducedEvents(doc);
      const event = events.find((e) => e.eventName === eventName);

      if (!event) {
        return toolErr(`Event not found: ${eventName}`);
      }

      let detail: Record<string, unknown>;
      if (event.schema?.properties?.detail) {
        detail = generateValue(event.schema.properties.detail) as Record<string, unknown>;
      } else if (event.schema) {
        detail = generateValue(event.schema) as Record<string, unknown>;
      } else {
        detail = { message: `Stub payload for ${event.eventName}` };
        console.warn(
          `[generate-event-payload] Schema for "${event.eventName}" could not be resolved. ` +
            "The generated payload is a stub. Consider using a saved example instead.",
        );
      }

      if (detail?.metadata && typeof detail.metadata === "object" && detail.metadata !== null) {
        (detail.metadata as Record<string, unknown>).version = event.version;
      }

      const savedExamples = await listSavedExamples(config.examplesDir, eventName);
      return toolOk(JSON.stringify(detail, null, 2), { payload: detail, savedExamples });
    },
  );

  // ------------------------------------------------------------------
  // Tool: send-to-eventbridge (app-only)
  // ------------------------------------------------------------------
  registerAppTool(
    server,
    TOOL_NAMES.SEND_TO_EVENTBRIDGE,
    {
      title: "Send to EventBridge",
      description:
        "Send a specific named event payload to AWS EventBridge after it has been generated or edited in the app.",
      inputSchema: { eventName: z.string(), payload: z.record(z.unknown()) },
      _meta: { ui: { visibility: ["app"] as const } },
    },
    async ({
      eventName,
      payload,
    }: {
      eventName: string;
      payload: Record<string, unknown>;
    }): Promise<CallToolResult> => {
      try {
        await getPathsConfig();
        const result = await sendEvent(eventBridgeClient, ebConfig, eventName, payload);

        if (!result.success) {
          return toolErr(`Failed: ${result.error}`, { success: false, error: result.error });
        }

        return toolOk(`Sent successfully! EventId: ${result.eventId}`, { success: true, eventId: result.eventId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolErr(`Error: ${message}`, { success: false, error: message });
      }
    },
  );

  // ------------------------------------------------------------------
  // Tool: save-event-example (app-only)
  // ------------------------------------------------------------------
  registerAppTool(
    server,
    TOOL_NAMES.SAVE_EXAMPLE,
    {
      title: "Save Event Example",
      description: "Save an event payload as a local JSON example file for a specific event type.",
      inputSchema: {
        eventName: z.string(),
        fileName: z.string(),
        payload: z.record(z.unknown()),
      },
      _meta: { ui: { visibility: ["app"] as const } },
    },
    async ({
      eventName,
      fileName,
      payload,
    }: {
      eventName: string;
      fileName: string;
      payload: Record<string, unknown>;
    }): Promise<CallToolResult> => {
      try {
        const config = await getPathsConfig();
        const { saveExample } = await import("@event-artillery/core");
        const result = await saveExample(config.examplesDir, eventName, fileName, payload);
        if (!result.success) {
          return toolErr(`Error saving: ${result.error}`, { success: false, error: result.error });
        }
        return toolOk(`Saved example: ${result.path}`, { success: true, path: result.path });
      } catch (err) {
        const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
        return toolErr(`Error saving: ${message}`, { success: false, error: message });
      }
    },
  );

  // ------------------------------------------------------------------
  // Tool: load-saved-example (app-only)
  // ------------------------------------------------------------------
  registerAppTool(
    server,
    TOOL_NAMES.LOAD_EXAMPLE,
    {
      title: "Load Saved Example",
      description: "Load a previously saved JSON example for a specific event type.",
      inputSchema: { eventName: z.string(), fileName: z.string() },
      _meta: { ui: { visibility: ["app"] as const } },
    },
    async ({
      eventName,
      fileName,
    }: {
      eventName: string;
      fileName: string;
    }): Promise<CallToolResult> => {
      try {
        const config = await getPathsConfig();
        const { loadExample } = await import("@event-artillery/core");
        const result = await loadExample(config.examplesDir, eventName, fileName);
        return toolOk(JSON.stringify(result.payload, null, 2), { payload: result.payload });
      } catch (err) {
        const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
        return toolErr(`Error loading: ${message}`, { success: false, error: message });
      }
    },
  );

  // ------------------------------------------------------------------
  // UI Resource
  // ------------------------------------------------------------------
  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
