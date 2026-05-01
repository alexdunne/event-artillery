/**
 * Shared tool name constants used by both the server and UI
 * to prevent silent mismatches on rename.
 */
export const TOOL_NAMES = {
  SEND_EVENT: "send-event",
  GENERATE_PAYLOAD: "generate-event-payload",
  SEND_TO_EVENTBRIDGE: "send-to-eventbridge",
  SAVE_EXAMPLE: "save-event-example",
  LOAD_EXAMPLE: "load-saved-example",
} as const;
