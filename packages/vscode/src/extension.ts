/**
 * Extension entry point — registers tree views, commands, and watchers.
 *
 * Auth flow:
 *  1. On activate, the "AWS Credentials" view checks the configured profile.
 *  2. If authenticated, events + examples load normally.
 *  3. If not, the events/examples views show a placeholder and the auth view
 *     shows the login command + a "Check Again" button.
 *
 * Profile switching:
 *  - The active profile is shown as the first row in the "AWS Credentials" view.
 *  - Clicking it (or running "Switch AWS Profile") opens a quick pick of all
 *    profiles from ~/.aws/config. Selecting one re-runs auth immediately.
 */

import * as vscode from "vscode";
import { EventsTreeProvider } from "./events-tree-provider.js";
import { ExamplesTreeProvider } from "./examples-tree-provider.js";
import { AwsAuthProvider } from "./auth-provider.js";
import { sendEventCommand, sendCurrentPayloadCommand, PAYLOAD_LANGUAGE_ID } from "./send-event.js";
import { saveExampleCommand, loadExampleCommand } from "./example-commands.js";
import { getEventsYamlPath, getActiveProfile, setActiveProfile } from "./config.js";
import { listAwsProfiles } from "./aws-profiles.js";

/**
 * Returns true when the document is a JSON file whose top-level object
 * has `metadata` and `payload` as its first two keys — the shape of an
 * EventBridge event detail saved as an example file.
 */
function isEventPayloadJson(doc: vscode.TextDocument | undefined): boolean {
  if (!doc) return false;
  if (doc.languageId !== "json") return false;
  try {
    const parsed = JSON.parse(doc.getText()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed as Record<string, unknown>);
    return keys[0] === "metadata" && keys[1] === "payload";
  } catch {
    return false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // ── Providers ───────────────────────────────────────────────────────
  const authProvider = new AwsAuthProvider();
  const eventsProvider = new EventsTreeProvider();
  const examplesProvider = new ExamplesTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("eventArtillery.auth", authProvider),
    vscode.window.registerTreeDataProvider("eventArtillery.events", eventsProvider),
    vscode.window.registerTreeDataProvider("eventArtillery.examples", examplesProvider),
  );

  // ── Auth callback — load events once authenticated ──────────────────
  authProvider.onAuthChange((authenticated) => {
    if (authenticated) {
      void loadEventsAndExamples();
    } else {
      eventsProvider.setAuthState(false);
      examplesProvider.setAuthState(false);
    }
  });

  async function loadEventsAndExamples(): Promise<void> {
    eventsProvider.setAuthState(true);
    examplesProvider.setAuthState(true);
    await eventsProvider.refresh();
    examplesProvider.setEventNames(eventsProvider.getEvents());
    examplesProvider.refresh();
  }

  // ── Commands ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("eventArtillery.checkAwsAuth", async () => {
      await authProvider.check();
    }),

    vscode.commands.registerCommand("eventArtillery.switchProfile", async () => {
      const profiles = await listAwsProfiles();
      if (profiles.length === 0) {
        vscode.window.showWarningMessage("Event Artillery: No AWS profiles found in ~/.aws/config");
        return;
      }

      const current = getActiveProfile();
      const items = profiles.map((p) => ({
        label: p.name,
        description: [
          p.ssoAccountId ? `account: ${p.ssoAccountId}` : "",
          p.region ?? "",
        ].filter(Boolean).join("  ·  "),
        picked: p.name === current,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select AWS profile",
        title: "Switch AWS Profile",
      });
      if (!picked || picked.label === current) return;

      setActiveProfile(picked.label);
      // Re-run auth check with the new profile — the auth tree refreshes itself
      await authProvider.check();
    }),

    vscode.commands.registerCommand("eventArtillery.sendEvent", (eventInfo?) => {
      return sendEventCommand(eventsProvider, eventInfo);
    }),

    vscode.commands.registerCommand("eventArtillery.sendCurrentPayload", () => {
      return sendCurrentPayloadCommand(eventsProvider);
    }),

    vscode.commands.registerCommand("eventArtillery.refreshEvents", async () => {
      if (!authProvider.isAuthenticated()) {
        vscode.window.showWarningMessage("Event Artillery: Not authenticated with AWS yet.");
        return;
      }
      await loadEventsAndExamples();
    }),

    vscode.commands.registerCommand("eventArtillery.saveExample", () => {
      return saveExampleCommand(eventsProvider, examplesProvider);
    }),

    vscode.commands.registerCommand("eventArtillery.loadExample", (eventName?: string, fileName?: string) => {
      return loadExampleCommand(eventsProvider, eventName, fileName);
    }),
  );

  // ── Editor context key — show toolbar buttons on payload editors ───
  function updatePayloadEditorContext(editor: vscode.TextEditor | undefined): void {
    const isPayload =
      editor?.document.languageId === PAYLOAD_LANGUAGE_ID ||
      isEventPayloadJson(editor?.document);
    void vscode.commands.executeCommand(
      "setContext",
      "eventArtillery.isPayloadEditor",
      isPayload ?? false,
    );
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updatePayloadEditorContext),
  );
  updatePayloadEditorContext(vscode.window.activeTextEditor);

  // ── File watcher — auto-refresh when events.yaml changes ───────────
  try {
    const specPath = getEventsYamlPath();
    const watcher = vscode.workspace.createFileSystemWatcher(specPath);
    watcher.onDidChange(() => {
      if (authProvider.isAuthenticated()) void loadEventsAndExamples();
    });
    context.subscriptions.push(watcher);
  } catch {
    // No workspace open
  }

  // ── Initial auth check ─────────────────────────────────────────────
  void authProvider.check();
}

export function deactivate(): void {
  // VS Code disposes subscriptions automatically
}
