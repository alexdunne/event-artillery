/**
 * Examples tree view — shows saved example payloads grouped by event name.
 */

import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { listSavedExamples, type AsyncApiEventInfo } from "@event-artillery/core";
import { getExamplesDir } from "./config.js";

type ExamplesTreeNode = EventGroupItem | ExampleFileItem | PlainItem;

export class ExamplesTreeProvider implements vscode.TreeDataProvider<ExamplesTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ExamplesTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private eventNames: string[] = [];
  private authenticated = false;

  setAuthState(authenticated: boolean): void {
    this.authenticated = authenticated;
    if (!authenticated) this.eventNames = [];
    this._onDidChangeTreeData.fire();
  }

  setEventNames(events: AsyncApiEventInfo[]): void {
    this.eventNames = events.map((e) => e.eventName);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ExamplesTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ExamplesTreeNode): Promise<ExamplesTreeNode[]> {
    if (!element) {
      if (!this.authenticated) {
        return [new EventGroupItem("Waiting for AWS authentication…", false)];
      }
      if (this.eventNames.length === 0) {
        return [new EventGroupItem("No events loaded yet", false)];
      }

      // Warn if the examples directory doesn't exist
      const dir = getExamplesDir();
      const dirExists = await fs.access(dir).then(() => true).catch(() => false);
      if (!dirExists) {
        return [
          new PlainItem(
            `$(warning) Examples directory not found`,
            `Set "eventArtillery.examplesDir" to the correct path. Currently: ${dir}`,
          ),
        ];
      }

      return this.eventNames.map((name) => new EventGroupItem(name, true));
    }

    if (element instanceof EventGroupItem && element.eventName) {
      const dir = getExamplesDir();
      const examples = await listSavedExamples(dir, element.eventName);
      if (examples.length === 0) {
        return [new ExampleFileItem("(no saved examples)", element.eventName, "")];
      }
      return examples.map(
        (ex) => new ExampleFileItem(ex.name, element.eventName!, ex.fileName),
      );
    }

    return [];
  }
}

class PlainItem extends vscode.TreeItem {
  constructor(label: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (tooltip) this.tooltip = tooltip;
  }
}

class EventGroupItem extends vscode.TreeItem {
  public readonly eventName: string | undefined;

  constructor(label: string, expandable: boolean) {
    super(
      label,
      expandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.eventName = expandable ? label : undefined;
    this.contextValue = "eventGroup";
  }
}

class ExampleFileItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly eventName: string,
    public readonly fileName: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (fileName) {
      this.command = {
        command: "eventArtillery.loadExample",
        title: "Load Example",
        arguments: [eventName, fileName],
      };
    }
  }
}
