/**
 * Events tree view — parses the AsyncAPI spec and shows available events
 * in the VS Code sidebar.
 */

import * as vscode from "vscode";
import {
  loadSpec,
  clearSpecCache,
  getProducedEvents,
  type AsyncApiEventInfo,
} from "@event-artillery/core";
import { getEventsYamlPath } from "./config.js";

export class EventsTreeProvider implements vscode.TreeDataProvider<EventTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<EventTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private events: AsyncApiEventInfo[] = [];
  private authenticated = false;

  setAuthState(authenticated: boolean): void {
    this.authenticated = authenticated;
    if (!authenticated) {
      this.events = [];
    }
    this._onDidChangeTreeData.fire();
  }

  async refresh(): Promise<void> {
    clearSpecCache();
    await this.loadEvents();
    this._onDidChangeTreeData.fire();
  }

  getEvents(): AsyncApiEventInfo[] {
    return this.events;
  }

  getTreeItem(element: EventTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: EventTreeItem): Promise<EventTreeItem[]> {
    if (element) return [];

    if (!this.authenticated) {
      return [new EventTreeItem("Waiting for AWS authentication…", "", "", undefined)];
    }

    if (this.events.length === 0) {
      await this.loadEvents();
    }

    if (this.events.length === 0) {
      return [new EventTreeItem("No events found", "", "", undefined)];
    }

    return this.events.map(
      (e) => new EventTreeItem(e.eventName, e.description, e.version, e),
    );
  }

  private async loadEvents(): Promise<void> {
    try {
      const specPath = getEventsYamlPath();
      const doc = await loadSpec(specPath);
      this.events = getProducedEvents(doc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Event Artillery: Failed to parse spec — ${msg}`);
      this.events = [];
    }
  }
}

export class EventTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly eventDescription: string,
    public readonly version: string,
    public readonly eventInfo: AsyncApiEventInfo | undefined,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    if (eventInfo) {
      this.tooltip = `${label} v${version}\n${eventDescription}`;
      this.description = `v${version}`;
      this.contextValue = "event";
      this.command = {
        command: "eventArtillery.sendEvent",
        title: "Send Event",
        arguments: [eventInfo],
      };
    }
  }
}
