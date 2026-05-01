/**
 * Auth tree provider — shown in the "AWS Credentials" sidebar view.
 * Displays auth status, the active profile (with a switch button in the
 * view title bar), and login instructions when unauthenticated.
 */

import * as vscode from "vscode";
import { checkAwsAuth, type AwsAuthStatus } from "./aws-auth.js";
import { getEventBridgeConfig, getActiveProfile } from "./config.js";

export type AuthState =
  | { kind: "checking" }
  | { kind: "authenticated"; identity: { account: string; arn: string } }
  | { kind: "unauthenticated"; error: string };

export class AwsAuthProvider implements vscode.TreeDataProvider<AuthTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private state: AuthState = { kind: "checking" };
  private _onAuthChange: ((authenticated: boolean) => void) | undefined;

  onAuthChange(cb: (authenticated: boolean) => void): void {
    this._onAuthChange = cb;
  }

  isAuthenticated(): boolean {
    return this.state.kind === "authenticated";
  }

  async check(): Promise<void> {
    this.state = { kind: "checking" };
    this._onDidChangeTreeData.fire();

    const { profile } = getEventBridgeConfig();
    const status = await checkAwsAuth(profile);
    this.state = toAuthState(status);
    this._onDidChangeTreeData.fire();
    this._onAuthChange?.(this.state.kind === "authenticated");
  }

  getTreeItem(element: AuthTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): AuthTreeItem[] {
    const profile = getActiveProfile();
    const profileRow = new AuthTreeItem(
      profile ? `$(account) ${profile}` : "$(account) No profile selected",
      "eventArtillery.switchProfile",
      "action",
    );
    profileRow.tooltip = "Click to switch AWS profile";

    switch (this.state.kind) {
      case "checking":
        return [
          profileRow,
          new AuthTreeItem("$(sync~spin) Checking credentials…", undefined, "info"),
        ];

      case "authenticated": {
        const { account, arn } = this.state.identity;
        return [
          profileRow,
          new AuthTreeItem("$(check) Authenticated", undefined, "info"),
          new AuthTreeItem(`Account: ${account}`, undefined, "detail"),
          new AuthTreeItem(arn, undefined, "detail"),
        ];
      }

      case "unauthenticated": {
        if (!profile) {
          return [
            profileRow,
            new AuthTreeItem("$(warning) No AWS profile selected", undefined, "error"),
            new AuthTreeItem("Click the profile above to choose one.", undefined, "detail"),
          ];
        }

        const loginCmd = `aws sso login --profile ${profile}`;
        return [
          profileRow,
          new AuthTreeItem(`$(error) ${this.state.error}`, undefined, "error"),
          new AuthTreeItem(`Run in your terminal:`, undefined, "detail"),
          new AuthTreeItem(loginCmd, undefined, "code"),
          new AuthTreeItem(
            "$(refresh) Check Again",
            "eventArtillery.checkAwsAuth",
            "action",
          ),
        ];
      }
    }
  }
}

function toAuthState(status: AwsAuthStatus): AuthState {
  if (status.authenticated && status.identity) {
    return { kind: "authenticated", identity: status.identity };
  }
  return { kind: "unauthenticated", error: status.error ?? "Not authenticated." };
}

type ItemVariant = "info" | "detail" | "error" | "code" | "action";

class AuthTreeItem extends vscode.TreeItem {
  constructor(label: string, command?: string, variant: ItemVariant = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);

    if (command) {
      this.command = { command, title: label, arguments: [] };
    }

    if (variant === "code") {
      this.description = "(copy and run this)";
      this.tooltip = label;
      this.contextValue = "codeSnippet";
    }
    if (variant === "detail") {
      this.description = "";
    }
  }
}
