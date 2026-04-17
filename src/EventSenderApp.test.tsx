// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineSnapshot } from "xstate";

import type { App } from "@modelcontextprotocol/ext-apps";

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports that consume them
// ---------------------------------------------------------------------------

// Mock useApp so we never need a real MCP transport
vi.mock("@modelcontextprotocol/ext-apps/react", () => ({
  useApp: vi.fn(),
}));

// Mock useMachine so we inject snapshots directly — no machine execution
vi.mock("@xstate/react", () => ({
  useMachine: vi.fn(),
}));

// Silence CSS import (global.css) — jsdom can't process it
vi.mock("./global.css", () => ({}));

// ---------------------------------------------------------------------------
// Imports that use the mocked modules
// ---------------------------------------------------------------------------
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { useMachine } from "@xstate/react";
import { EventSenderApp, EventSenderMachine } from "./EventSenderApp.js";
import type { MachineContext, MachineEvent } from "./machine.js";
import packageJson from "../package.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Snap = MachineSnapshot<MachineContext, MachineEvent, any, any, any, any, any, any>;

const mockSend = vi.fn();

/** Build a minimal fake snapshot. Only fields the component reads are required. */
function makeSnapshot(
  state: string,
  ctx: Partial<MachineContext> = {},
): [Snap, typeof mockSend] {
  const context: MachineContext = {
    app: { callServerTool: vi.fn() },
    events: [],
    selectedEvent: null,
    jsonText: "",
    jsonError: "",
    savedExamples: [],
    status: null,
    saveFileName: "",
    searchQuery: "",
    ...ctx,
  };

  const snap = {
    value: state,
    context,
    matches: (s: string) => s === state,
  } as unknown as Snap;

  return [snap, mockSend];
}

/** A minimal fake App object — EventSenderMachine only touches callServerTool & ontoolresult. */
function makeFakeApp(): App {
  return {
    callServerTool: vi.fn().mockResolvedValue({ structuredContent: {} }),
    ontoolresult: undefined,
  } as unknown as App;
}

const mockEvent = {
  name: "order.created",
  description: "An order was created",
  version: packageJson.version,
};

const mockSelectedEvent = {
  name: "order.created",
  description: "An order was created",
  version: packageJson.version,
};

beforeEach(() => {
  mockSend.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// EventSenderApp — connection states
// ---------------------------------------------------------------------------
describe("EventSenderApp", () => {
  it("shows connecting state while app is null", () => {
    vi.mocked(useApp).mockReturnValue({ app: null, error: null, isConnected: false });
    render(<EventSenderApp />);
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("shows error message when useApp returns an error", () => {
    vi.mocked(useApp).mockReturnValue({
      app: null,
      error: new Error("Transport failed"),
      isConnected: false,
    });
    render(<EventSenderApp />);
    expect(screen.getByText("Transport failed")).toBeInTheDocument();
  });

  it("renders EventSenderMachine when app is ready", () => {
    const fakeApp = makeFakeApp();
    vi.mocked(useApp).mockReturnValue({ app: fakeApp, error: null, isConnected: true });
    vi.mocked(useMachine).mockReturnValue(makeSnapshot("idle") as any);
    render(<EventSenderApp />);
    expect(screen.getByText("Event Artillery MCP")).toBeInTheDocument();
  });

  it("loads events directly from the send-event tool on mount", async () => {
    const fakeApp = makeFakeApp();
    vi.mocked(fakeApp.callServerTool).mockResolvedValue({
      structuredContent: { events: [mockEvent] },
    } as any);
    vi.mocked(useApp).mockReturnValue({ app: fakeApp, error: null, isConnected: true });
    vi.mocked(useMachine).mockReturnValue(makeSnapshot("idle") as any);

    render(<EventSenderApp />);

    await waitFor(() => {
      expect(fakeApp.callServerTool).toHaveBeenCalledWith({
        name: "send-event",
        arguments: {},
      });
    });
  });
});

// ---------------------------------------------------------------------------
// EventSenderMachine — rendered with injected snapshots
// ---------------------------------------------------------------------------

function renderMachine(state: string, ctx: Partial<MachineContext> = {}) {
  vi.mocked(useMachine).mockReturnValue(makeSnapshot(state, ctx) as any);
  return render(<EventSenderMachine app={makeFakeApp()} />);
}

describe("idle state", () => {
  it("shows loading spinner and message", () => {
    renderMachine("idle");
    expect(screen.getByText("Loading events from events.yaml...")).toBeInTheDocument();
  });

  it("does not show the event list", () => {
    renderMachine("idle");
    expect(screen.queryByText("Select an Event")).not.toBeInTheDocument();
  });
});

describe("selecting state", () => {
  it("renders the event list with event names", () => {
    renderMachine("selecting", { events: [mockEvent], searchQuery: "" });
    expect(screen.getByText("Select an Event")).toBeInTheDocument();
    expect(screen.getByText("order.created")).toBeInTheDocument();
    expect(screen.getByText("An order was created")).toBeInTheDocument();
  });

  it("shows event count in description", () => {
    renderMachine("selecting", { events: [mockEvent], searchQuery: "" });
    expect(screen.getByText(/1 available/)).toBeInTheDocument();
  });

  it("shows empty-state message when no events match", () => {
    renderMachine("selecting", { events: [], searchQuery: "xyz" });
    expect(screen.getByText("No events match your search.")).toBeInTheDocument();
  });

  it("sends SELECT_EVENT when an event button is clicked", async () => {
    const user = userEvent.setup();
    renderMachine("selecting", { events: [mockEvent], searchQuery: "" });
    await user.click(screen.getByText("order.created"));
    expect(mockSend).toHaveBeenCalledWith({ type: "SELECT_EVENT", event: mockEvent });
  });

  it("sends SEARCH_CHANGE when the search input changes", async () => {
    const user = userEvent.setup();
    renderMachine("selecting", { events: [mockEvent], searchQuery: "" });
    await user.type(screen.getByPlaceholderText("Search events..."), "ord");
    expect(mockSend).toHaveBeenCalledWith({ type: "SEARCH_CHANGE", query: "o" });
    expect(mockSend).toHaveBeenCalledWith({ type: "SEARCH_CHANGE", query: "r" });
    expect(mockSend).toHaveBeenCalledWith({ type: "SEARCH_CHANGE", query: "d" });
  });
});

describe("generatingPayload state", () => {
  it("shows generating spinner", () => {
    renderMachine("generatingPayload");
    expect(screen.getByText("Generating payload...")).toBeInTheDocument();
  });
});

describe("editing state", () => {
  const editingCtx: Partial<MachineContext> = {
    selectedEvent: mockSelectedEvent,
    jsonText: '{"orderId":"123"}',
    jsonError: "",
    savedExamples: [],
    status: null,
    saveFileName: "",
  };

  it("renders the page title and event name", () => {
    renderMachine("editing", editingCtx);
    expect(screen.getByText("Event Artillery MCP")).toBeInTheDocument();
    expect(screen.getByText("order.created")).toBeInTheDocument();
  });

  it("renders the JSON textarea with current jsonText", () => {
    renderMachine("editing", editingCtx);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue('{"orderId":"123"}');
  });

  it("sends JSON_CHANGE when textarea changes", async () => {
    const user = userEvent.setup();
    renderMachine("editing", editingCtx);
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "x");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: "JSON_CHANGE" }),
    );
  });

  it("displays jsonError when set", () => {
    renderMachine("editing", { ...editingCtx, jsonError: "Invalid JSON — please fix" });
    expect(screen.getByText("Invalid JSON — please fix")).toBeInTheDocument();
  });

  it("sends BACK when the back button is clicked", async () => {
    const user = userEvent.setup();
    renderMachine("editing", editingCtx);
    // The back button is the ghost icon button — find by accessible label or role
    const buttons = screen.getAllByRole("button");
    const backBtn = buttons.find((b) => b.querySelector("svg")) as HTMLElement;
    await user.click(backBtn);
    expect(mockSend).toHaveBeenCalledWith({ type: "BACK" });
  });

  it("sends REGENERATE when Regenerate button is clicked", async () => {
    const user = userEvent.setup();
    renderMachine("editing", editingCtx);
    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    expect(mockSend).toHaveBeenCalledWith({ type: "REGENERATE" });
  });

  it("sends OPEN_SAVE_DIALOG when Save Example is clicked", async () => {
    const user = userEvent.setup();
    renderMachine("editing", editingCtx);
    await user.click(screen.getByRole("button", { name: /save example/i }));
    expect(mockSend).toHaveBeenCalledWith({ type: "OPEN_SAVE_DIALOG" });
  });

  it("sends FORMAT_JSON when Format JSON is clicked", async () => {
    const user = userEvent.setup();
    renderMachine("editing", editingCtx);
    await user.click(screen.getByRole("button", { name: /format json/i }));
    expect(mockSend).toHaveBeenCalledWith({ type: "FORMAT_JSON" });
  });

  it("sends SEND when Send to EventBridge is clicked", async () => {
    const user = userEvent.setup();
    renderMachine("editing", editingCtx);
    await user.click(screen.getByRole("button", { name: /send to eventbridge/i }));
    expect(mockSend).toHaveBeenCalledWith({ type: "SEND" });
  });

  it("shows success status banner with message", () => {
    renderMachine("editing", {
      ...editingCtx,
      status: { type: "success", message: "Sent! EventId: abc-123" },
    });
    expect(screen.getByText("Sent! EventId: abc-123")).toBeInTheDocument();
  });

  it("shows error status banner with message", () => {
    renderMachine("editing", {
      ...editingCtx,
      status: { type: "error", message: "Failed: throttled" },
    });
    expect(screen.getByText("Failed: throttled")).toBeInTheDocument();
  });

  it("does not show status banner when status is null", () => {
    renderMachine("editing", { ...editingCtx, status: null });
    expect(screen.queryByText(/sent!/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });

  it("shows saved examples select when examples exist", () => {
    renderMachine("editing", {
      ...editingCtx,
      savedExamples: [{ name: "baseline", fileName: "baseline.json" }],
    });
    expect(screen.getByText("Load saved example:")).toBeInTheDocument();
    expect(screen.getByText("Select an example...")).toBeInTheDocument();
  });

  it("does not show saved examples select when no examples", () => {
    renderMachine("editing", { ...editingCtx, savedExamples: [] });
    expect(screen.queryByText("Load saved example:")).not.toBeInTheDocument();
  });
});

describe("sending state", () => {
  it("disables action buttons while sending", () => {
    renderMachine("sending", {
      selectedEvent: mockSelectedEvent,
      jsonText: "{}",
      savedExamples: [],
    });
    expect(screen.getByRole("button", { name: /regenerate/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save example/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /send to eventbridge/i })).toBeDisabled();
  });
});

describe("saving state (dialog)", () => {
  const savingCtx: Partial<MachineContext> = {
    selectedEvent: mockSelectedEvent,
    jsonText: '{"a":1}',
    savedExamples: [],
    saveFileName: "",
    status: null,
  };

  it("shows the save dialog when in saving state", () => {
    renderMachine("saving", savingCtx);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Save Event Example")).toBeInTheDocument();
  });

  it("shows the target directory path in the dialog", () => {
    renderMachine("saving", savingCtx);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/examples\/order\.created\//)).toBeInTheDocument();
  });

  it("sends SAVE_FILENAME_CHANGE when filename input changes", async () => {
    const user = userEvent.setup();
    renderMachine("saving", savingCtx);
    await user.type(screen.getByLabelText("Filename"), "my-file");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SAVE_FILENAME_CHANGE" }),
    );
  });

  it("sends CLOSE_SAVE_DIALOG when Cancel is clicked", async () => {
    const user = userEvent.setup();
    renderMachine("saving", savingCtx);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockSend).toHaveBeenCalledWith({ type: "CLOSE_SAVE_DIALOG" });
  });

  it("sends SAVE_CONFIRM when Save button is clicked", async () => {
    const user = userEvent.setup();
    renderMachine("saving", { ...savingCtx, saveFileName: "my-file" });
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^save$/i }));
    expect(mockSend).toHaveBeenCalledWith({ type: "SAVE_CONFIRM" });
  });

  it("Save button is disabled when saveFileName is empty", () => {
    renderMachine("saving", { ...savingCtx, saveFileName: "" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("sends SAVE_CONFIRM on Enter key in filename input when filename set", async () => {
    const user = userEvent.setup();
    renderMachine("saving", { ...savingCtx, saveFileName: "my-file" });
    await user.type(screen.getByLabelText("Filename"), "{Enter}");
    expect(mockSend).toHaveBeenCalledWith({ type: "SAVE_CONFIRM" });
  });
});

describe("savingInProgress state", () => {
  it("shows the save dialog with disabled inputs", () => {
    renderMachine("savingInProgress", {
      selectedEvent: mockSelectedEvent,
      jsonText: "{}",
      savedExamples: [],
      saveFileName: "my-file",
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Filename")).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
  });
});

describe("loadingExample state", () => {
  it("shows a loading spinner in place of the textarea", () => {
    renderMachine("loadingExample", {
      selectedEvent: mockSelectedEvent,
      jsonText: "{}",
      savedExamples: [],
    });
    // Textarea should not be present
    expect(screen.queryByRole("textbox", { name: /event payload/i })).not.toBeInTheDocument();
  });

  it("disables action buttons while loading", () => {
    renderMachine("loadingExample", {
      selectedEvent: mockSelectedEvent,
      jsonText: "{}",
      savedExamples: [],
    });
    expect(screen.getByRole("button", { name: /regenerate/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /send to eventbridge/i })).toBeDisabled();
  });
});
