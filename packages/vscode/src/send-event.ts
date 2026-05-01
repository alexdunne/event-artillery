/**
 * Send-event commands.
 *
 * Flow:
 * 1. sendEventCommand — triggered from the tree view (or command palette).
 *    Picks an event, generates a sample payload, and opens it in an untitled
 *    editor with the custom language id `event-artillery-payload`.
 *    A "Send to EventBridge" button appears in the editor title bar.
 *
 * 2. sendCurrentPayloadCommand — triggered by that editor-title button.
 *    For generated payloads: looks up the stored send-context by URI.
 *    For saved example files on disk: derives the event name from the parent
 *    folder (examplesDir/<eventName>/<file>.json) and looks it up in the
 *    events provider to get the full AsyncApiEventInfo.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
  generateValue,
  createEventBridgeClient,
  sendEvent,
  type AsyncApiEventInfo,
} from "@event-artillery/core";
import { getEventBridgeConfig, getExamplesDir } from "./config.js";
import type { EventsTreeProvider } from "./events-tree-provider.js";

// ---------------------------------------------------------------------------
// Custom language id — used to scope the editor-title button
// ---------------------------------------------------------------------------

export const PAYLOAD_LANGUAGE_ID = "event-artillery-payload";

// ---------------------------------------------------------------------------
// Pending send context — keyed by document URI string
// ---------------------------------------------------------------------------

interface SendContext {
  eventInfo: AsyncApiEventInfo;
}

const pendingContext = new Map<string, SendContext>();

// ---------------------------------------------------------------------------
// Output channel
// ---------------------------------------------------------------------------

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Event Artillery");
  }
  return outputChannel;
}

// ---------------------------------------------------------------------------
// Step 1: Open the payload editor
// ---------------------------------------------------------------------------

export async function sendEventCommand(
  eventsProvider: EventsTreeProvider,
  eventInfo?: AsyncApiEventInfo,
): Promise<void> {
  // Resolve which event to send
  if (!eventInfo) {
    const events = eventsProvider.getEvents();
    if (events.length === 0) {
      vscode.window.showWarningMessage(
        "Event Artillery: No events found. Ensure your AsyncAPI spec is valid.",
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      events.map((e) => ({
        label: e.eventName,
        description: `v${e.version}`,
        detail: e.description,
        event: e,
      })),
      { placeHolder: "Select an event to send" },
    );

    if (!picked) return;
    eventInfo = picked.event;
  }

  // Generate sample payload
  const payload = generateValue(eventInfo.schema);
  const payloadJson = JSON.stringify(payload, null, 2);

  // Open in an untitled editor tagged with our custom language id so the
  // editor-title button's `when` clause fires only for these documents.
  const doc = await vscode.workspace.openTextDocument({
    content: payloadJson,
    language: PAYLOAD_LANGUAGE_ID,
  });

  await vscode.window.showTextDocument(doc, { preview: false });

  // Stash the send context so the toolbar button can retrieve it
  pendingContext.set(doc.uri.toString(), { eventInfo });
}

// ---------------------------------------------------------------------------
// Step 2: Send from the editor-title button
// ---------------------------------------------------------------------------

export async function sendCurrentPayloadCommand(
  eventsProvider: EventsTreeProvider,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Event Artillery: No active editor.");
    return;
  }

  // Resolve event info — either from the pending context (generated payload)
  // or by deriving the event name from the file path (saved example on disk).
  const eventInfo = resolveEventInfo(editor.document, eventsProvider);
  if (!eventInfo) {
    vscode.window.showWarningMessage(
      "Event Artillery: Could not determine which event this file belongs to. Open an event from the Events panel.",
    );
    return;
  }

  // Parse the (possibly hand-edited) JSON
  const editedContent = editor.document.getText();
  let editedPayload: Record<string, unknown>;
  try {
    editedPayload = JSON.parse(editedContent) as Record<string, unknown>;
  } catch {
    vscode.window.showErrorMessage("Event Artillery: Invalid JSON in editor.");
    return;
  }

  const out = getOutputChannel();
  out.show(true);
  out.appendLine(`--- Sending ${eventInfo.eventName} ---`);
  out.appendLine(`Payload: ${JSON.stringify(editedPayload, null, 2)}`);

  const config = getEventBridgeConfig();
  const busName = eventInfo.channelName || config.busName;
  const client = createEventBridgeClient({ ...config, busName });

  try {
    const result = await sendEvent(client, { ...config, busName }, eventInfo.eventName, editedPayload);
    if (result.success) {
      out.appendLine(`Success! EventId: ${result.eventId}`);
      vscode.window.showInformationMessage(
        `Event Artillery: "${eventInfo.eventName}" sent (${result.eventId})`,
      );
    } else {
      out.appendLine(`Failed: ${result.error}`);
      vscode.window.showErrorMessage(`Event Artillery: Send failed — ${result.error}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.appendLine(`Error: ${msg}`);
    vscode.window.showErrorMessage(`Event Artillery: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve AsyncApiEventInfo for the given document.
 *
 * - Generated payload (custom language id): look up pendingContext by URI.
 * - Saved example on disk: the parent folder name IS the event name
 *   (examplesDir/<eventName>/<file>.json). Find the matching event in the
 *   provider so we get channelName and schema too.
 */
function resolveEventInfo(
  doc: vscode.TextDocument,
  eventsProvider: EventsTreeProvider,
): AsyncApiEventInfo | undefined {
  // Generated payload
  const ctx = pendingContext.get(doc.uri.toString());
  if (ctx) return ctx.eventInfo;

  // Saved example file — derive event name from parent directory
  if (doc.uri.scheme !== "file") return undefined;

  const examplesDir = getExamplesDir();
  const filePath = doc.uri.fsPath;
  const eventName = path.basename(path.dirname(filePath));

  // Sanity-check: file must be directly inside a subfolder of examplesDir
  const expectedParent = path.join(examplesDir, eventName);
  if (path.dirname(filePath) !== expectedParent) return undefined;

  return eventsProvider.getEvents().find((e) => e.eventName === eventName);
}
