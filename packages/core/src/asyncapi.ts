/**
 * AsyncAPI spec parsing — loads and caches AsyncAPI YAML specs,
 * extracts send-operations and their schemas.
 */

import { Parser } from "@asyncapi/parser";
import fs from "node:fs/promises";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cachedSpecPromiseByPath = new Map<string, Promise<any>>();

/**
 * Load and parse an AsyncAPI YAML spec from disk.
 * Results are Promise-memoized to prevent concurrent parse races.
 * The spec is cached for the lifetime of the process; restart to pick up changes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadSpec(eventsYamlPath: string): Promise<any> {
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

/** Clear the spec cache — useful when spec files change. */
export function clearSpecCache(): void {
  cachedSpecPromiseByPath.clear();
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/**
 * Recursively resolve `allOf` compositions into a single merged object schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeAllOf(schema: any): any {
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

// ---------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------

export interface EventInfo {
  eventName: string;
  description: string;
  version: string;
  channelName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
}

/**
 * Extract all send-operations (produced events) from a parsed AsyncAPI document.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getProducedEvents(doc: any): EventInfo[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return doc.operations().filterBySend().flatMap((op: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = op.messages().all() as any[];
    if (messages.length === 0) return [];
    const channelName: string = op.channels().all()[0]?.id() ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return messages.map((msg: any) => {
      const fullSchema = mergeAllOf(msg?.payload()?.json());
      // If the schema is an EventBridge envelope (has a top-level `detail`
      // property), expose only the detail schema — AWS adds the envelope.
      const schema = fullSchema?.properties?.detail ?? fullSchema;
      return {
        eventName: msg.id() || op.id(),
        description: op.json()?.description ?? "",
        version: msg.json()?.["x-eventcatalog-message-version"] ?? "unknown",
        channelName,
        schema,
      };
    });
  });
}
