/**
 * @event-artillery/core — public API
 *
 * Core logic for Event Artillery: AsyncAPI parsing, payload generation,
 * EventBridge sending, example file management, and the UI state machine.
 */

// AsyncAPI parsing
export { loadSpec, clearSpecCache, mergeAllOf, getProducedEvents } from "./asyncapi.js";
export type { EventInfo as AsyncApiEventInfo } from "./asyncapi.js";

// Payload generation
export { generateValue, KNOWN_FIELD_VALUES } from "./payload-generator.js";

// EventBridge
export {
  createEventBridgeClient,
  getDefaultEventBridgeConfig,
  sendEvent,
} from "./eventbridge.js";
export type { EventBridgeConfig, SendEventResult } from "./eventbridge.js";

// Example file management
export {
  listSavedExamples,
  saveExample,
  loadExample,
  resolveExamplePath,
  getExamplePaths,
  stripJsonSuffix,
  assertInsideDirectory,
  ConfigError,
} from "./examples.js";

// Config / path utilities
export { resolveFromBase, fileUriToPath } from "./config.js";
export type { PathsConfig } from "./config.js";

// State machine
export { eventSenderMachine } from "./machine.js";
export type {
  EventInfo,
  SavedExample,
  StatusMessage,
  McpApp,
  MachineContext,
  MachineEvent,
} from "./machine.js";

// Tool name constants
export { TOOL_NAMES } from "./tool-names.js";
