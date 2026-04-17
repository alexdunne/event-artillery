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
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { Parser } from "@asyncapi/parser";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { TOOL_NAMES } from "./src/tool-names.js";

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
interface ServerPathsConfig {
  baseDir: string;
  eventsYamlPath: string;
  examplesDir: string;
}

class ConfigError extends Error {}

function resolveFromBase(baseDir: string, value: string | undefined, fallbackRelativePath: string): string {
  if (!value) return path.resolve(baseDir, fallbackRelativePath);
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function fileUriToPath(uri: string): string | null {
  try {
    if (!uri.startsWith("file://")) return null;
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME ?? "my-event-bus";
const EVENT_SOURCE = process.env.EVENT_SOURCE ?? "event-artillery";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const AWS_PROFILE = process.env.AWS_PROFILE;

// dist/ directory — always sibling to this compiled file
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

const PKG_VERSION = readPkgVersion();

// Singleton EventBridge client — shared across all tool calls
const eventBridgeClient = new EventBridgeClient({
  region: AWS_REGION,
  credentials: AWS_PROFILE ? fromIni({ profile: AWS_PROFILE }) : undefined,
  maxAttempts: 3,
});

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
// Sanitization + path safety
// ---------------------------------------------------------------------------
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");

function getExamplePaths(
  config: ServerPathsConfig,
  eventName: string,
  fileName?: string,
): { dir: string; filePath?: string } {
  const base = path.resolve(config.examplesDir);
  const dir = path.resolve(base, sanitize(eventName));

  if (!fileName) return { dir };

  const filePath = path.resolve(dir, sanitize(fileName));
  return { dir, filePath };
}

function stripJsonSuffix(fileName: string): string {
  return fileName.replace(/\.json$/i, "");
}

async function assertInsideDirectory(baseDir: string, targetPath: string): Promise<void> {
  const realBaseDir = await fs.realpath(baseDir);
  const realTargetPath = await fs.realpath(targetPath);
  if (realTargetPath !== realBaseDir && !realTargetPath.startsWith(`${realBaseDir}${path.sep}`)) {
    throw new ConfigError("Access denied");
  }
}

async function ensureExampleDir(baseDir: string, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const stats = await fs.lstat(dir);
  if (stats.isSymbolicLink()) {
    throw new ConfigError("Access denied");
  }
  await assertInsideDirectory(baseDir, dir);
}

async function ensureExampleFile(baseDir: string, filePath: string): Promise<void> {
  const parentDir = path.dirname(filePath);
  await assertInsideDirectory(baseDir, parentDir);
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink()) {
    throw new ConfigError("Access denied");
  }
  await assertInsideDirectory(baseDir, filePath);
}

// ---------------------------------------------------------------------------
// AsyncAPI parsing — Promise-memoized to prevent concurrent parse races.
// The spec is cached for the lifetime of the server process; restart to pick
// up changes to events.yaml.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedSpecPromiseByPath = new Map<string, Promise<any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSpec(eventsYamlPath: string): Promise<any> {
  const cachedSpecPromise = cachedSpecPromiseByPath.get(eventsYamlPath);
  if (cachedSpecPromise) return cachedSpecPromise;

  const nextPromise = (async () => {
    try {
      const raw = await fs.readFile(eventsYamlPath, "utf8");
      const parser = new Parser();
      const { document, diagnostics } = await parser.parse(raw);
      const errors = (diagnostics ?? []).filter(
        (d: { severity: number }) => d.severity === 0,
      );
      if (!document) {
        throw new Error(
          `Failed to parse ${eventsYamlPath}: ${errors.map((e: { message: string }) => e.message).join("; ")}`,
        );
      }
      return document;
    } catch (error) {
      cachedSpecPromiseByPath.delete(eventsYamlPath);
      throw error;
    }
  })();

  cachedSpecPromiseByPath.set(eventsYamlPath, nextPromise);
  return nextPromise;
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeAllOf(schema: any): any {
  if (!schema?.allOf) return schema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged: { type: string; properties: Record<string, any>; required: string[] } = {
    type: "object",
    properties: {},
    required: [],
  };
  for (const entry of schema.allOf) {
    const resolved = mergeAllOf(entry);
    if (resolved?.properties)
      merged.properties = { ...merged.properties, ...resolved.properties };
    if (resolved?.required)
      merged.required = [...merged.required, ...resolved.required];
  }
  return merged;
}

interface EventInfo {
  eventName: string;
  description: string;
  version: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProducedEvents(doc: any): EventInfo[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return doc.operations().filterBySend().flatMap((op: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = op.messages().all() as any[];
    if (messages.length === 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return messages.map((msg: any) => ({
      eventName: msg.id() || op.id(),
      description: op.json()?.description ?? "",
      version: msg.json()?.["x-eventcatalog-message-version"] ?? "unknown",
      schema: mergeAllOf(msg?.payload()?.json()),
    }));
  });
}

// ---------------------------------------------------------------------------
// Payload generation
// ---------------------------------------------------------------------------
const KNOWN_FIELD_VALUES: Record<string, string[]> = {
  sku: ["SKU-001-XL-BLK", "SKU-002-M-WHT", "SKU-003-L-GRY"],
  barcode: ["0123456789012", "9876543210987", "1234567890123"],
  name: ["Classic Hoodie - Black - XL", "Performance Tee - White - M", "Joggers - Grey - L"],
  description: ["Classic Hoodie - Black - XL", "Performance Tee - White - M", "Joggers - Grey - L"],
  code: ["UKLUT1 : OK", "BERIE1 : OK", "USLAX1 : OK"],
  provider: ["PROVIDER_A", "PROVIDER_B"],
  currency: ["GBP", "USD", "EUR"],
  currencyCode: ["GBP", "USD", "EUR"],
  countryCode: ["GB", "US", "DE", "NL"],
  country: ["United Kingdom", "United States", "Germany", "Netherlands"],
  city: ["London", "New York", "Los Angeles", "Berlin"],
  postcode: ["SW1A 1AA", "10001", "90001", "10115"],
  state: ["", "California", ""],
  stateCode: ["", "CA", ""],
  line1: ["1 Example Street", "3 Central Blvd", "Unit 7 Magna Park"],
  line2: ["Suite 100", "Floor 2", ""],
  email: ["test@example.com", "warehouse@example.com"],
  phone: ["0000000000", "+441234567890"],
  addressee: ["Jane Smith", "Example Warehouse", "Returns Dept"],
  attention: ["Acme Corp", "Acme Ltd"],
  reference: ["#TR005309", "SO041746995", "POIC3323445634"],
  transactionId: ["439808578", "356546875", "354414408"],
  id: ["5091754528", "683394", "1234"],
  firstName: ["Jim", "Jane", "Alex"],
  lastName: ["Shark", "Smith", "Jones"],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateValue(schema: any, fieldName?: string): any {
  if (!schema) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return pick(schema.enum);
  if (schema.allOf) return generateValue(mergeAllOf(schema), fieldName);

  switch (schema.type) {
    case "object": {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        obj[key] = generateValue(propSchema, key);
      }
      return obj;
    }
    case "array": {
      const count = (schema.minItems ?? 1) + Math.floor(Math.random() * 3);
      return Array.from({ length: count }, () => generateValue(schema.items));
    }
    case "string":
      return generateString(schema, fieldName);
    case "integer":
      return (schema.minimum ?? 1) + Math.floor(Math.random() * 50);
    case "number":
      return Math.round((1 + Math.random() * 100) * 100) / 100;
    case "boolean":
      return schema.default ?? false;
    default:
      return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateString(schema: any, fieldName?: string): string {
  if (schema.format === "date-time")
    return new Date(Date.now() - Math.floor(Math.random() * 7 * 86400000)).toISOString();
  if (schema.format === "uuid") return uuidv4();
  if (schema.format === "email") return pick(KNOWN_FIELD_VALUES.email);

  if (schema.pattern) {
    if (schema.pattern.includes("[A-Z]{2}[A-Z0-9]{3}")) return pick(["GBLTT", "USLAX", "NLRTM"]);
    if (schema.pattern.includes("\\d{10}")) return "6109100010";
    if (schema.pattern.includes("[A-Z]{3}$")) return pick(["GBP", "USD", "EUR", "VNM"]);
    if (schema.pattern.includes("[A-Z]{2}$")) return pick(["GB", "US", "DE", "NL"]);
  }

  if (fieldName && KNOWN_FIELD_VALUES[fieldName]) return pick(KNOWN_FIELD_VALUES[fieldName]);

  if (schema.description) {
    const desc = schema.description.toLowerCase();
    if (desc.includes("sku")) return pick(KNOWN_FIELD_VALUES.sku);
    if (desc.includes("location")) return pick(KNOWN_FIELD_VALUES.code);
    if (desc.includes("currency")) return pick(KNOWN_FIELD_VALUES.currency);
    if (desc.includes("country")) return pick(KNOWN_FIELD_VALUES.country);
    if (desc.includes("email")) return pick(KNOWN_FIELD_VALUES.email);
    if (desc.includes("address")) return pick(KNOWN_FIELD_VALUES.line1);
    if (desc.includes("name")) return pick(KNOWN_FIELD_VALUES.name);
  }

  return `sample-${fieldName ?? "value"}`;
}

// ---------------------------------------------------------------------------
// Saved examples helpers
// ---------------------------------------------------------------------------
async function loadSavedExamples(
  config: ServerPathsConfig,
  eventName: string,
): Promise<{ name: string; fileName: string }[]> {
  const paths = getExamplePaths(config, eventName);
  try {
    await ensureExampleDir(config.examplesDir, paths.dir);
    const files = await fs.readdir(paths.dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: f.replace(/\.json$/, ""), fileName: f }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Event Artillery MCP",
    version: PKG_VERSION,
  });

  let cachedPathsConfigPromise: Promise<ServerPathsConfig> | null = null;

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

  async function getPathsConfig(): Promise<ServerPathsConfig> {
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

      const savedExamples = await loadSavedExamples(config, eventName);
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
        const result = await eventBridgeClient.send(
          new PutEventsCommand({
            Entries: [
              {
                Source: EVENT_SOURCE,
                DetailType: eventName,
                Detail: JSON.stringify(payload),
                EventBusName: EVENT_BUS_NAME,
              },
            ],
          }),
        );

        if (result.FailedEntryCount && result.FailedEntryCount > 0) {
          const entry = result.Entries?.[0];
          const error = entry?.ErrorCode
            ? `${entry.ErrorCode}: ${entry.ErrorMessage}`
            : "Unknown EventBridge error";
          return toolErr(`Failed: ${error}`, { success: false, error });
        }

        const eventId = result.Entries?.[0]?.EventId;
        return toolOk(`Sent successfully! EventId: ${eventId}`, { success: true, eventId });
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
      const config = await getPathsConfig();
      // Strip .json suffix from user input to avoid double extension
      const baseName = fileName.replace(/\.json$/i, "");
      const paths = getExamplePaths(config, eventName, baseName);

      try {
        await ensureExampleDir(config.examplesDir, paths.dir);
        const filePath = `${paths.filePath}.json`;
        await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
        return toolOk(`Saved example: ${baseName}.json`, { success: true, path: `${baseName}.json` });
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
      const config = await getPathsConfig();
      const paths = getExamplePaths(config, eventName, stripJsonSuffix(fileName));
      const filePath = `${paths.filePath}.json`;

      try {
        await ensureExampleFile(config.examplesDir, filePath);
        const content = await fs.readFile(filePath, "utf-8");
        const payload = JSON.parse(content);
        return toolOk(JSON.stringify(payload, null, 2), { payload });
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
