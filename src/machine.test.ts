import { createActor, fromPromise } from "xstate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eventSenderMachine,
  type EventInfo,
  type McpApp,
  type SavedExample,
} from "./machine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockEvent: EventInfo = {
  name: "order.created",
  description: "An order was created",
  version: "1.0.0",
};

const mockPayload = { orderId: "123", total: 99.99 };
const mockPayloadText = JSON.stringify(mockPayload, null, 2);

const mockExample: SavedExample = { name: "my-example", fileName: "my-example.json" };
const emptyExamples: SavedExample[] = [];

type GeneratePayloadResult = { payload: object; savedExamples: SavedExample[] };
type SendEventResult = { eventId: string };
type SaveExampleResult = { path: string; example: SavedExample };
type LoadExampleResult = { payload: object; fileName: string };

/** Build a mock McpApp whose callServerTool never resolves (for states that just invoke). */
function makePendingApp(): McpApp {
  return {
    callServerTool: vi.fn(
      () => new Promise<{ structuredContent: unknown }>(() => {}),
    ),
  };
}

/**
 * Create and start an actor, returning it plus a helper to read the current snapshot.
 * The actor is stopped in afterEach via the `actors` array.
 */
const actors: ReturnType<typeof createActor>[] = [];

function start(app: McpApp = makePendingApp()) {
  const actor = createActor(eventSenderMachine, { input: { app } });
  actors.push(actor);
  actor.start();
  return actor;
}

/** Drive the machine to `editing` state using provided or default mocks. */
async function startInEditing({
  app,
  generateResult = { payload: mockPayload, savedExamples: [mockExample] },
}: {
  app?: McpApp;
  generateResult?: { payload: object; savedExamples: SavedExample[] };
} = {}) {
  const resolvedApp = app ?? makePendingApp();
  const machine = eventSenderMachine.provide({
    actors: {
      generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(
        async () => generateResult,
      ),
    },
  });
  const actor = createActor(machine, { input: { app: resolvedApp } });
  actors.push(actor);
  actor.start();

  actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
  actor.send({ type: "SELECT_EVENT", event: mockEvent });

  // Wait for generatePayload to settle
  await vi.waitFor(() => {
    expect(actor.getSnapshot().value).toBe("editing");
  });

  return actor;
}

afterEach(() => {
  actors.forEach((a) => a.stop());
  actors.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// idle
// ---------------------------------------------------------------------------
describe("idle", () => {
  it("starts in idle", () => {
    const actor = start();
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("transitions to selecting on EVENTS_LOADED and stores events", () => {
    const actor = start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("selecting");
    expect(snap.context.events).toEqual([mockEvent]);
  });

  it("ignores unrelated events", () => {
    const actor = start();
    actor.send({ type: "BACK" });
    expect(actor.getSnapshot().value).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// selecting
// ---------------------------------------------------------------------------
describe("selecting", () => {
  beforeEach(() => {
    // Suppress unhandled promise warnings from pending actors in these tests
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("updates searchQuery on SEARCH_CHANGE", () => {
    const actor = start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SEARCH_CHANGE", query: "order" });
    expect(actor.getSnapshot().context.searchQuery).toBe("order");
  });

  it("transitions to generatingPayload on SELECT_EVENT and sets selectedEvent", () => {
    const actor = start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("generatingPayload");
    expect(snap.context.selectedEvent).toEqual(mockEvent);
  });

  it("clears searchQuery and status when selecting an event", () => {
    const actor = start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SEARCH_CHANGE", query: "ord" });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    const { context } = actor.getSnapshot();
    expect(context.searchQuery).toBe("");
    expect(context.status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generatingPayload
// ---------------------------------------------------------------------------
describe("generatingPayload", () => {
  it("transitions to editing on successful payload generation", async () => {
    const actor = await startInEditing();
    expect(actor.getSnapshot().value).toBe("editing");
  });

  it("stores jsonText and savedExamples from payload generation", async () => {
    const actor = await startInEditing();
    const { context } = actor.getSnapshot();
    expect(context.jsonText).toBe(mockPayloadText);
    expect(context.savedExamples).toEqual([mockExample]);
    expect(context.jsonError).toBe("");
  });

  it("returns to selecting with error status when generation fails", async () => {
    const machine = eventSenderMachine.provide({
      actors: {
        generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(async () => {
          throw new Error("network error");
        }),
      },
    });
    const actor = createActor(machine, { input: { app: makePendingApp() } });
    actors.push(actor);
    actor.start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe("selecting");
    });

    expect(actor.getSnapshot().context.status).toEqual({
      type: "error",
      message: "Failed to generate payload",
    });
  });
});

// ---------------------------------------------------------------------------
// editing
// ---------------------------------------------------------------------------
describe("editing", () => {
  it("SEND clears status before invoking sendEvent", async () => {
    // Verify that triggering SEND resets any prior status to null
    const machine = eventSenderMachine.provide({
      actors: {
        generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(async () => ({
          payload: mockPayload,
          savedExamples: emptyExamples,
        })),
        // Never resolves — lets us inspect context mid-flight
        sendEvent: fromPromise<SendEventResult, { app: McpApp; eventName: string; payload: object }>(
          () => new Promise(() => {}),
        ),
      },
    });
    const actor = createActor(machine, { input: { app: makePendingApp() } });
    actors.push(actor);
    actor.start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    actor.send({ type: "SEND" });
    expect(actor.getSnapshot().value).toBe("sending");
    expect(actor.getSnapshot().context.status).toBeNull();
  });

  it("updates jsonText on JSON_CHANGE and clears jsonError", async () => {
    const actor = await startInEditing();
    actor.send({ type: "JSON_CHANGE", value: '{"foo":1}' });
    const { context } = actor.getSnapshot();
    expect(context.jsonText).toBe('{"foo":1}');
    expect(context.jsonError).toBe("");
  });

  it("FORMAT_JSON pretty-prints valid JSON", async () => {
    const actor = await startInEditing();
    actor.send({ type: "JSON_CHANGE", value: '{"a":1,"b":2}' });
    actor.send({ type: "FORMAT_JSON" });
    expect(actor.getSnapshot().context.jsonText).toBe(
      JSON.stringify({ a: 1, b: 2 }, null, 2),
    );
  });

  it("FORMAT_JSON sets jsonError for invalid JSON", async () => {
    const actor = await startInEditing();
    actor.send({ type: "JSON_CHANGE", value: "not json" });
    actor.send({ type: "FORMAT_JSON" });
    expect(actor.getSnapshot().context.jsonError).toBe("Cannot format — invalid JSON");
  });

  it("SEND with valid JSON transitions to sending", async () => {
    const actor = await startInEditing();
    // jsonText is already valid from generatePayload
    actor.send({ type: "SEND" });
    expect(actor.getSnapshot().value).toBe("sending");
  });

  it("SEND with invalid JSON sets jsonError and stays in editing", async () => {
    const actor = await startInEditing();
    actor.send({ type: "JSON_CHANGE", value: "bad json{" });
    actor.send({ type: "SEND" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("editing");
    expect(snap.context.jsonError).toBe("Invalid JSON — please fix before sending");
  });

  it("OPEN_SAVE_DIALOG transitions to saving", async () => {
    const actor = await startInEditing();
    actor.send({ type: "OPEN_SAVE_DIALOG" });
    expect(actor.getSnapshot().value).toBe("saving");
  });

  it("LOAD_EXAMPLE transitions to loadingExample", async () => {
    const actor = await startInEditing();
    actor.send({ type: "LOAD_EXAMPLE", fileName: "my-example" });
    expect(actor.getSnapshot().value).toBe("loadingExample");
  });

  it("REGENERATE transitions to generatingPayload", async () => {
    const actor = await startInEditing();
    actor.send({ type: "REGENERATE" });
    expect(actor.getSnapshot().value).toBe("generatingPayload");
  });

  it("BACK returns to selecting and clears editing context", async () => {
    const actor = await startInEditing();
    actor.send({ type: "BACK" });
    const { value, context } = actor.getSnapshot();
    expect(value).toBe("selecting");
    expect(context.selectedEvent).toBeNull();
    expect(context.jsonText).toBe("");
    expect(context.jsonError).toBe("");
    expect(context.savedExamples).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------
describe("sending", () => {
  it("returns to editing with success status on successful send", async () => {
    const machine = eventSenderMachine.provide({
      actors: {
        generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(async () => ({
          payload: mockPayload,
          savedExamples: emptyExamples,
        })),
        sendEvent: fromPromise<SendEventResult, { app: McpApp; eventName: string; payload: object }>(
          async () => ({ eventId: "evt-abc-123" }),
        ),
      },
    });
    const actor = createActor(machine, { input: { app: makePendingApp() } });
    actors.push(actor);
    actor.start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    actor.send({ type: "SEND" });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    expect(actor.getSnapshot().context.status).toEqual({
      type: "success",
      message: "Sent! EventId: evt-abc-123",
    });
  });

  it("returns to editing with error status on failed send", async () => {
    const machine = eventSenderMachine.provide({
      actors: {
        generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(async () => ({
          payload: mockPayload,
          savedExamples: emptyExamples,
        })),
        sendEvent: fromPromise<SendEventResult, { app: McpApp; eventName: string; payload: object }>(async () => {
          throw new Error("EventBridge throttled");
        }),
      },
    });
    const actor = createActor(machine, { input: { app: makePendingApp() } });
    actors.push(actor);
    actor.start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    actor.send({ type: "SEND" });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    expect(actor.getSnapshot().context.status).toEqual({
      type: "error",
      message: "Failed: EventBridge throttled",
    });
  });
});

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------
describe("saving", () => {
  it("resets saveFileName to empty string on entry", async () => {
    const actor = await startInEditing();
    // Manually set saveFileName first to prove entry resets it
    actor.send({ type: "OPEN_SAVE_DIALOG" });
    actor.send({ type: "SAVE_FILENAME_CHANGE", value: "old-name" });
    actor.send({ type: "CLOSE_SAVE_DIALOG" });
    // Re-open — entry should clear it
    actor.send({ type: "OPEN_SAVE_DIALOG" });
    expect(actor.getSnapshot().context.saveFileName).toBe("");
  });

  it("CLOSE_SAVE_DIALOG returns to editing", async () => {
    const actor = await startInEditing();
    actor.send({ type: "OPEN_SAVE_DIALOG" });
    actor.send({ type: "CLOSE_SAVE_DIALOG" });
    expect(actor.getSnapshot().value).toBe("editing");
  });

  it("SAVE_FILENAME_CHANGE updates saveFileName", async () => {
    const actor = await startInEditing();
    actor.send({ type: "OPEN_SAVE_DIALOG" });
    actor.send({ type: "SAVE_FILENAME_CHANGE", value: "my-test" });
    expect(actor.getSnapshot().context.saveFileName).toBe("my-test");
  });

  it("SAVE_CONFIRM with valid filename and JSON transitions to savingInProgress", async () => {
    const actor = await startInEditing();
    actor.send({ type: "OPEN_SAVE_DIALOG" });
    actor.send({ type: "SAVE_FILENAME_CHANGE", value: "my-test" });
    actor.send({ type: "SAVE_CONFIRM" });
    expect(actor.getSnapshot().value).toBe("savingInProgress");
  });

  it("SAVE_CONFIRM with empty filename stays in saving and sets jsonError", async () => {
    const actor = await startInEditing();
    actor.send({ type: "OPEN_SAVE_DIALOG" });
    actor.send({ type: "SAVE_CONFIRM" }); // saveFileName is "" from entry reset
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("saving");
    expect(snap.context.jsonError).toBe("Invalid JSON or missing filename");
  });

  it("SAVE_CONFIRM with invalid JSON stays in saving and sets jsonError", async () => {
    const actor = await startInEditing();
    actor.send({ type: "JSON_CHANGE", value: "bad{json" });
    actor.send({ type: "OPEN_SAVE_DIALOG" });
    actor.send({ type: "SAVE_FILENAME_CHANGE", value: "my-test" });
    actor.send({ type: "SAVE_CONFIRM" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("saving");
    expect(snap.context.jsonError).toBe("Invalid JSON or missing filename");
  });
});

// ---------------------------------------------------------------------------
// savingInProgress
// ---------------------------------------------------------------------------
describe("savingInProgress", () => {
  it("transitions to editing and appends example on success", async () => {
    const savedPath = "my-test.json";
    const machine = eventSenderMachine.provide({
      actors: {
        generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(async () => ({
          payload: mockPayload,
          savedExamples: [mockExample],
        })),
        saveExample: fromPromise<SaveExampleResult, { app: McpApp; eventName: string; fileName: string; payload: object }>(async () => ({
          path: savedPath,
          example: { name: "my-test", fileName: "my-test.json" },
        })),
      },
    });
    const actor = createActor(machine, { input: { app: makePendingApp() } });
    actors.push(actor);
    actor.start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    actor.send({ type: "OPEN_SAVE_DIALOG" });
    actor.send({ type: "SAVE_FILENAME_CHANGE", value: "my-test" });
    actor.send({ type: "SAVE_CONFIRM" });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    const { context } = actor.getSnapshot();
    expect(context.savedExamples).toContainEqual({ name: "my-test", fileName: "my-test.json" });
    expect(context.status).toEqual({
      type: "success",
      message: `Saved to ${savedPath}`,
    });
  });

  it("returns to saving with error status on failure", async () => {
    const machine = eventSenderMachine.provide({
      actors: {
        generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(async () => ({
          payload: mockPayload,
          savedExamples: emptyExamples,
        })),
        saveExample: fromPromise<SaveExampleResult, { app: McpApp; eventName: string; fileName: string; payload: object }>(async () => {
          throw new Error("disk full");
        }),
      },
    });
    const actor = createActor(machine, { input: { app: makePendingApp() } });
    actors.push(actor);
    actor.start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    actor.send({ type: "OPEN_SAVE_DIALOG" });
    actor.send({ type: "SAVE_FILENAME_CHANGE", value: "my-test" });
    actor.send({ type: "SAVE_CONFIRM" });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("saving"));

    expect(actor.getSnapshot().context.status).toEqual({
      type: "error",
      message: "Failed to save: disk full",
    });
  });
});

// ---------------------------------------------------------------------------
// loadingExample
// ---------------------------------------------------------------------------
describe("loadingExample", () => {
  it("transitions to editing with loaded payload on success", async () => {
    const loadedPayload = { orderId: "loaded-456" };
    const machine = eventSenderMachine.provide({
      actors: {
        generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(async () => ({
          payload: mockPayload,
          savedExamples: [mockExample],
        })),
        loadExample: fromPromise<LoadExampleResult, { app: McpApp; eventName: string; fileName: string }>(async () => ({
          payload: loadedPayload,
          fileName: "my-example",
        })),
      },
    });
    const actor = createActor(machine, { input: { app: makePendingApp() } });
    actors.push(actor);
    actor.start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    actor.send({ type: "LOAD_EXAMPLE", fileName: "my-example" });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    const { context } = actor.getSnapshot();
    expect(context.jsonText).toBe(JSON.stringify(loadedPayload, null, 2));
    expect(context.jsonError).toBe("");
    expect(context.status).toEqual({
      type: "success",
      message: "Loaded my-example",
    });
  });

  it("returns to editing with error status on failure", async () => {
    const machine = eventSenderMachine.provide({
      actors: {
        generatePayload: fromPromise<GeneratePayloadResult, { app: McpApp; eventName: string }>(async () => ({
          payload: mockPayload,
          savedExamples: [mockExample],
        })),
        loadExample: fromPromise<LoadExampleResult, { app: McpApp; eventName: string; fileName: string }>(async () => {
          throw new Error("file not found");
        }),
      },
    });
    const actor = createActor(machine, { input: { app: makePendingApp() } });
    actors.push(actor);
    actor.start();
    actor.send({ type: "EVENTS_LOADED", events: [mockEvent] });
    actor.send({ type: "SELECT_EVENT", event: mockEvent });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    actor.send({ type: "LOAD_EXAMPLE", fileName: "missing" });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("editing"));

    expect(actor.getSnapshot().context.status).toEqual({
      type: "error",
      message: "Failed to load: file not found",
    });
  });
});

// ---------------------------------------------------------------------------
// guards (unit-level)
// ---------------------------------------------------------------------------
describe("guards", () => {
  describe("isValidJson / SEND guard", () => {
    it("allows SEND when jsonText is valid JSON", async () => {
      const actor = await startInEditing();
      actor.send({ type: "SEND" });
      expect(actor.getSnapshot().value).toBe("sending");
    });

    it("blocks SEND when jsonText is invalid JSON", async () => {
      const actor = await startInEditing();
      actor.send({ type: "JSON_CHANGE", value: "{invalid" });
      actor.send({ type: "SEND" });
      expect(actor.getSnapshot().value).toBe("editing");
    });
  });

  describe("canSave / SAVE_CONFIRM guard", () => {
    it("allows SAVE_CONFIRM when filename is set and JSON is valid", async () => {
      const actor = await startInEditing();
      actor.send({ type: "OPEN_SAVE_DIALOG" });
      actor.send({ type: "SAVE_FILENAME_CHANGE", value: "test" });
      actor.send({ type: "SAVE_CONFIRM" });
      expect(actor.getSnapshot().value).toBe("savingInProgress");
    });

    it("blocks SAVE_CONFIRM when filename is whitespace only", async () => {
      const actor = await startInEditing();
      actor.send({ type: "OPEN_SAVE_DIALOG" });
      actor.send({ type: "SAVE_FILENAME_CHANGE", value: "   " });
      actor.send({ type: "SAVE_CONFIRM" });
      expect(actor.getSnapshot().value).toBe("saving");
    });

    it("blocks SAVE_CONFIRM when JSON is invalid", async () => {
      const actor = await startInEditing();
      actor.send({ type: "JSON_CHANGE", value: "bad{" });
      actor.send({ type: "OPEN_SAVE_DIALOG" });
      actor.send({ type: "SAVE_FILENAME_CHANGE", value: "test" });
      actor.send({ type: "SAVE_CONFIRM" });
      expect(actor.getSnapshot().value).toBe("saving");
    });
  });
});
