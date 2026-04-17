/**
 * XState v5 machine for the Event Artillery MCP UI.
 *
 * States:
 *   idle              → Waiting for event list from MCP tool result
 *   selecting         → Event list shown, user picks an event
 *   generatingPayload → Calling generate-event-payload tool
 *   editing           → Payload editor shown; all actions available
 *   loadingExample    → Loading a saved example (editor stays visible)
 *   sending           → Sending to EventBridge (editor shown, actions disabled)
 *   saving            → Save dialog open
 *   savingInProgress  → Save dialog submitting
 *
 * The `app` (McpApp) is stored in context so actor `input` functions can
 * access it without external closure hacks.
 */

import { assign, fromPromise, setup } from "xstate";
import { TOOL_NAMES } from "./tool-names.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface EventInfo {
  name: string;
  description: string;
  version: string;
}

export interface SavedExample {
  name: string;
  fileName: string;
}

export interface StatusMessage {
  type: "success" | "error";
  message: string;
}

// Minimal interface for the MCP App — keeps the machine decoupled from the SDK
export interface McpApp {
  callServerTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{
    structuredContent: unknown;
  }>;
}

export interface MachineContext {
  app: McpApp;
  events: EventInfo[];
  selectedEvent: EventInfo | null;
  jsonText: string;
  jsonError: string;
  savedExamples: SavedExample[];
  status: StatusMessage | null;
  saveFileName: string;
  searchQuery: string;
}

export type MachineEvent =
  | { type: "EVENTS_LOADED"; events: EventInfo[] }
  | { type: "SELECT_EVENT"; event: EventInfo }
  | { type: "REGENERATE" }
  | { type: "JSON_CHANGE"; value: string }
  | { type: "FORMAT_JSON" }
  | { type: "SEARCH_CHANGE"; query: string }
  | { type: "BACK" }
  | { type: "SEND" }
  | { type: "OPEN_SAVE_DIALOG" }
  | { type: "CLOSE_SAVE_DIALOG" }
  | { type: "SAVE_FILENAME_CHANGE"; value: string }
  | { type: "SAVE_CONFIRM" }
  | { type: "LOAD_EXAMPLE"; fileName: string };

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------
export const eventSenderMachine = setup({
  types: {
    context: {} as MachineContext,
    events: {} as MachineEvent,
    input: {} as { app: McpApp },
  },
  actors: {
    generatePayload: fromPromise(async ({ input }: { input: { app: McpApp; eventName: string } }) => {
      const result = await input.app.callServerTool({
        name: TOOL_NAMES.GENERATE_PAYLOAD,
        arguments: { eventName: input.eventName },
      });
      return result.structuredContent as { payload: object; savedExamples: SavedExample[] };
    }),

    sendEvent: fromPromise(async ({ input }: { input: { app: McpApp; eventName: string; payload: object } }) => {
      const result = await input.app.callServerTool({
        name: TOOL_NAMES.SEND_TO_EVENTBRIDGE,
        arguments: { eventName: input.eventName, payload: input.payload },
      });
      const data = result.structuredContent as {
        success: boolean;
        eventId?: string;
        error?: string;
      };
      if (!data.success) throw new Error(data.error ?? "Unknown error");
      return { eventId: data.eventId ?? "" };
    }),

    saveExample: fromPromise(async ({ input }: { input: { app: McpApp; eventName: string; fileName: string; payload: object } }) => {
      const result = await input.app.callServerTool({
        name: TOOL_NAMES.SAVE_EXAMPLE,
        arguments: {
          eventName: input.eventName,
          fileName: input.fileName,
          payload: input.payload,
        },
      });
      const data = result.structuredContent as {
        success: boolean;
        path?: string;
        error?: string;
      };
      if (!data.success) throw new Error(data.error ?? "Unknown error");
      return {
        path: data.path ?? "",
        example: { name: input.fileName, fileName: `${input.fileName}.json` },
      };
    }),

    loadExample: fromPromise(async ({ input }: { input: { app: McpApp; eventName: string; fileName: string } }) => {
      const result = await input.app.callServerTool({
        name: TOOL_NAMES.LOAD_EXAMPLE,
        arguments: { eventName: input.eventName, fileName: input.fileName },
      });
      const data = result.structuredContent as { payload: object };
      return { payload: data.payload, fileName: input.fileName };
    }),
  },
  guards: {
    isValidJson: ({ context }) => {
      try {
        JSON.parse(context.jsonText);
        return true;
      } catch {
        return false;
      }
    },
    canSave: ({ context }) => {
      if (!context.saveFileName.trim()) return false;
      try {
        JSON.parse(context.jsonText);
        return true;
      } catch {
        return false;
      }
    },
  },
}).createMachine({
  id: "eventSender",
  initial: "idle",
  context: ({ input }) => ({
    app: input.app,
    events: [],
    selectedEvent: null,
    jsonText: "",
    jsonError: "",
    savedExamples: [],
    status: null,
    saveFileName: "",
    searchQuery: "",
  }),

  states: {
    idle: {
      on: {
        EVENTS_LOADED: {
          target: "selecting",
          actions: assign({ events: ({ event }) => event.events }),
        },
      },
    },

    selecting: {
      on: {
        SELECT_EVENT: {
          target: "generatingPayload",
          actions: assign({
            selectedEvent: ({ event }) => event.event,
            searchQuery: "",
            status: null,
          }),
        },
        SEARCH_CHANGE: {
          actions: assign({ searchQuery: ({ event }) => event.query }),
        },
      },
    },

    generatingPayload: {
      invoke: {
        src: "generatePayload",
        input: ({ context }) => ({
          app: context.app,
          eventName: context.selectedEvent!.name,
        }),
        onDone: {
          target: "editing",
          actions: assign({
            jsonText: ({ event }) => JSON.stringify(event.output.payload, null, 2),
            savedExamples: ({ event }) => event.output.savedExamples,
            jsonError: "",
          }),
        },
        onError: {
          target: "selecting",
          actions: assign({
            status: { type: "error" as const, message: "Failed to generate payload" },
          }),
        },
      },
    },

    editing: {
      on: {
        BACK: {
          target: "selecting",
          actions: assign({
            selectedEvent: null,
            jsonText: "",
            jsonError: "",
            savedExamples: [],
            status: null,
          }),
        },
        JSON_CHANGE: {
          actions: assign({ jsonText: ({ event }) => event.value, jsonError: "" }),
        },
        FORMAT_JSON: {
          actions: assign(({ context }) => {
            try {
              return {
                jsonText: JSON.stringify(JSON.parse(context.jsonText), null, 2),
                jsonError: "",
              };
            } catch {
              return { jsonError: "Cannot format — invalid JSON" };
            }
          }),
        },
        SEND: [
          {
            guard: "isValidJson",
            target: "sending",
            actions: assign({ jsonError: "", status: null }),
          },
          {
            actions: assign({ jsonError: "Invalid JSON — please fix before sending" }),
          },
        ],
        OPEN_SAVE_DIALOG: {
          target: "saving",
          actions: assign({ status: null }),
        },
        LOAD_EXAMPLE: {
          target: "loadingExample",
          actions: assign({ status: null }),
        },
        REGENERATE: {
          target: "generatingPayload",
          actions: assign({ status: null }),
        },
      },
    },

    sending: {
      invoke: {
        src: "sendEvent",
        input: ({ context }) => ({
          app: context.app,
          eventName: context.selectedEvent!.name,
          payload: JSON.parse(context.jsonText) as object,
        }),
        onDone: {
          target: "editing",
          actions: assign({
            status: ({ event }) => ({
              type: "success" as const,
              message: `Sent! EventId: ${event.output.eventId}`,
            }),
          }),
        },
        onError: {
          target: "editing",
          actions: assign({
            status: ({ event }) => ({
              type: "error" as const,
              message: `Failed: ${(event.error as Error).message}`,
            }),
          }),
        },
      },
    },

    saving: {
      entry: assign({ saveFileName: "" }),
      on: {
        CLOSE_SAVE_DIALOG: "editing",
        SAVE_FILENAME_CHANGE: {
          actions: assign({ saveFileName: ({ event }) => event.value }),
        },
        SAVE_CONFIRM: [
          {
            guard: "canSave",
            target: "savingInProgress",
          },
          {
            actions: assign({ jsonError: "Invalid JSON or missing filename" }),
          },
        ],
      },
    },

    savingInProgress: {
      invoke: {
        src: "saveExample",
        input: ({ context }) => ({
          app: context.app,
          eventName: context.selectedEvent!.name,
          fileName: context.saveFileName.trim(),
          payload: JSON.parse(context.jsonText) as object,
        }),
        onDone: {
          target: "editing",
          actions: assign({
            savedExamples: ({ context, event }) => [
              ...context.savedExamples,
              event.output.example,
            ],
            status: ({ event }) => ({
              type: "success" as const,
              message: `Saved to ${event.output.path}`,
            }),
          }),
        },
        onError: {
          target: "saving",
          actions: assign({
            status: ({ event }) => ({
              type: "error" as const,
              message: `Failed to save: ${(event.error as Error).message}`,
            }),
          }),
        },
      },
    },

    loadingExample: {
      invoke: {
        src: "loadExample",
        input: ({ context, event }) => ({
          app: context.app,
          eventName: context.selectedEvent!.name,
          fileName: (event as Extract<MachineEvent, { type: "LOAD_EXAMPLE" }>).fileName,
        }),
        onDone: {
          target: "editing",
          actions: assign({
            jsonText: ({ event }) => JSON.stringify(event.output.payload, null, 2),
            jsonError: "",
            status: ({ event }) => ({
              type: "success" as const,
              message: `Loaded ${event.output.fileName}`,
            }),
          }),
        },
        onError: {
          target: "editing",
          actions: assign({
            status: ({ event }) => ({
              type: "error" as const,
              message: `Failed to load: ${(event.error as Error).message}`,
            }),
          }),
        },
      },
    },
  },
});
