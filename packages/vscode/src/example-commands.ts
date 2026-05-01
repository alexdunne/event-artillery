/**
 * Save / load example commands — save the current editor payload as a
 * named example, or load a saved example into the editor + send flow.
 */

import * as vscode from "vscode";
import {
  saveExample,
  resolveExamplePath,
  listSavedExamples,
  type AsyncApiEventInfo,
} from "@event-artillery/core";
import { getExamplesDir } from "./config.js";
import type { EventsTreeProvider } from "./events-tree-provider.js";
import type { ExamplesTreeProvider } from "./examples-tree-provider.js";

/**
 * Save the active editor's JSON content as a named example.
 */
export async function saveExampleCommand(
  eventsProvider: EventsTreeProvider,
  examplesProvider: ExamplesTreeProvider,
): Promise<void> {
  // Pick the event to save under
  const events = eventsProvider.getEvents();
  if (events.length === 0) {
    vscode.window.showWarningMessage("Event Artillery: No events loaded.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    events.map((e) => ({ label: e.eventName, event: e })),
    { placeHolder: "Save example for which event?" },
  );
  if (!picked) return;

  // Get a file name from the user
  const fileName = await vscode.window.showInputBox({
    prompt: "Example name (without .json)",
    placeHolder: "my-example",
    validateInput: (v) => (v.trim() ? null : "Name cannot be empty"),
  });
  if (!fileName) return;

  // Read payload from active editor
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Event Artillery: No active editor to read payload from.");
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(editor.document.getText()) as Record<string, unknown>;
  } catch {
    vscode.window.showErrorMessage("Event Artillery: Active editor does not contain valid JSON.");
    return;
  }

  const dir = getExamplesDir();
  const result = await saveExample(dir, picked.event.eventName, fileName, payload);

  if (result.success) {
    vscode.window.showInformationMessage(`Event Artillery: Example saved as ${result.path}`);
    examplesProvider.refresh();
  } else {
    vscode.window.showErrorMessage(`Event Artillery: Failed to save — ${result.error}`);
  }
}

/**
 * Load a saved example into an editor.
 * Can be called from the tree view (with args) or the command palette (interactive).
 */
export async function loadExampleCommand(
  eventsProvider: EventsTreeProvider,
  eventName?: string,
  fileName?: string,
): Promise<void> {
  // If called from command palette, prompt for event + example
  if (!eventName) {
    const events = eventsProvider.getEvents();
    if (events.length === 0) {
      vscode.window.showWarningMessage("Event Artillery: No events loaded.");
      return;
    }

    const pickedEvent = await vscode.window.showQuickPick(
      events.map((e) => ({ label: e.eventName, event: e })),
      { placeHolder: "Load example for which event?" },
    );
    if (!pickedEvent) return;
    eventName = pickedEvent.event.eventName;
  }

  if (!fileName) {
    const dir = getExamplesDir();
    const examples = await listSavedExamples(dir, eventName);
    if (examples.length === 0) {
      vscode.window.showInformationMessage(
        `Event Artillery: No saved examples for "${eventName}".`,
      );
      return;
    }

    const pickedExample = await vscode.window.showQuickPick(
      examples.map((ex) => ({ label: ex.name, fileName: ex.fileName })),
      { placeHolder: "Select an example to load" },
    );
    if (!pickedExample) return;
    fileName = pickedExample.fileName;
  }

  const dir = getExamplesDir();
  const filePath = resolveExamplePath(dir, eventName, fileName);
  try {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Event Artillery: Failed to open example — ${msg}`);
  }
}
