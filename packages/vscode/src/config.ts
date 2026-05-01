/**
 * VS Code extension config — reads workspace settings and resolves paths.
 *
 * The active AWS profile can be overridden at runtime via setActiveProfile()
 * without touching the VS Code settings file.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import type { EventBridgeConfig } from "@event-artillery/core";

// In-memory profile override — starts as undefined (falls back to setting)
let activeProfileOverride: string | undefined;

export function setActiveProfile(profile: string): void {
  activeProfileOverride = profile;
}

export function getActiveProfile(): string {
  if (activeProfileOverride !== undefined) return activeProfileOverride;
  return cfg().get<string>("awsProfile", "") || "";
}

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("No workspace folder open");
  }
  return folders[0].uri.fsPath;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("eventArtillery");
}

export function getEventsYamlPath(): string {
  const raw = cfg().get<string>("eventsYamlPath", "events.yaml");
  if (path.isAbsolute(raw)) return raw;
  return path.join(getWorkspaceRoot(), raw);
}

export function getExamplesDir(): string {
  const raw = cfg().get<string>("examplesDir", "examples");
  if (path.isAbsolute(raw)) return raw;
  return path.join(getWorkspaceRoot(), raw);
}

export function getEventBridgeConfig(): EventBridgeConfig {
  const c = cfg();
  const profile = getActiveProfile();
  return {
    busName: c.get<string>("eventBusName", "my-event-bus"),
    source: c.get<string>("eventSource", "event-artillery"),
    region: c.get<string>("awsRegion", "us-east-1"),
    profile: profile || undefined,
  };
}
