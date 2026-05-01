import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useMemo } from "react";
import { useMachine } from "@xstate/react";

import { eventSenderMachine, type EventInfo, type McpApp } from "@event-artillery/core/machine";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  ArrowLeft,
  CheckCircle,
  Loader2,
  RefreshCw,
  Save,
  Send,
  XCircle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Root app — waits for MCP connection before starting the machine
// ---------------------------------------------------------------------------
export function EventSenderApp() {
  const { app, error } = useApp({
    appInfo: { name: "Event Artillery MCP", version: "1.0.1" },
    capabilities: {},
    onAppCreated: (createdApp: App) => {
      createdApp.ontoolinput = async () => {};
      createdApp.ontoolcancelled = () => {};
      createdApp.onerror = console.error;
      createdApp.onteardown = async () => ({});
    },
  });

  if (error)
    return (
      <div className="p-4 text-destructive">
        <strong>Error:</strong> {error.message}
      </div>
    );

  if (!app)
    return (
      <div className="flex items-center gap-2 p-4 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Connecting...
      </div>
    );

  return <EventSenderMachine app={app} />;
}

// ---------------------------------------------------------------------------
// Machine-driven UI — only rendered once the MCP app is ready
// ---------------------------------------------------------------------------
export function EventSenderMachine({ app }: { app: App }) {
  // Wrap App in the lightweight McpApp interface the machine depends on
  const mcpApp: McpApp = useMemo(
    () => ({
      callServerTool: (args) =>
        app.callServerTool(args) as Promise<{ structuredContent: unknown }>,
    }),
    [app],
  );

  const [snapshot, send] = useMachine(eventSenderMachine, {
    input: { app: mcpApp },
  });

  // Load the event list directly so the app does not depend on host timing for
  // the initial tool result delivery.
  useEffect(() => {
    let cancelled = false;

    const initialLoad = app.callServerTool({ name: "send-event", arguments: {} });
    if (!initialLoad || typeof initialLoad.then !== "function") {
      console.error("Failed to load events", new Error("callServerTool did not return a promise"));
      return () => {
        cancelled = true;
      };
    }

    void initialLoad
      .then((result) => {
        if (cancelled) return;
        const data = result.structuredContent as { events?: EventInfo[] } | null;
        if (data?.events) {
          send({ type: "EVENTS_LOADED", events: data.events });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load events", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [app, send]);

  // Still listen for host-delivered results so reinvocations can refresh the UI.
  useEffect(() => {
    app.ontoolresult = async (result: CallToolResult) => {
      const data = result.structuredContent as { events?: EventInfo[] } | null;
      if (data?.events) {
        send({ type: "EVENTS_LOADED", events: data.events });
      }
    };

    return () => {
      if (app.ontoolresult) {
        app.ontoolresult = undefined;
      }
    };
  }, [app, send]);

  const ctx = snapshot.context;

  // ---------------------------------------------------------------------------
  // Derived booleans — single source of truth from machine state
  // ---------------------------------------------------------------------------
  const isGenerating = snapshot.matches("generatingPayload");
  const isSending = snapshot.matches("sending");
  const isLoadingExample = snapshot.matches("loadingExample");
  const isSavingInProgress = snapshot.matches("savingInProgress");
  const isSaveDialogOpen = snapshot.matches("saving") || isSavingInProgress;
  const isEditing =
    snapshot.matches("editing") ||
    isSending ||
    isSaveDialogOpen ||
    isLoadingExample;
  const isActionDisabled = isSending || isLoadingExample || isSavingInProgress;

  const filteredEvents = ctx.events.filter(
    (e) =>
      !ctx.searchQuery ||
      e.name.toLowerCase().includes(ctx.searchQuery.toLowerCase()) ||
      e.description.toLowerCase().includes(ctx.searchQuery.toLowerCase()),
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <main className="min-h-screen p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        {/* Title */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Event Artillery MCP</h1>
          <p className="text-sm text-muted-foreground">
            Generate, edit, and send events to EventBridge
          </p>
        </div>

        {/* ---- IDLE ---- */}
        {snapshot.matches("idle") && (
          <Card>
            <CardContent className="py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                Loading events from events.yaml...
              </p>
            </CardContent>
          </Card>
        )}

        {/* ---- SELECTING ---- */}
        {snapshot.matches("selecting") && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Select an Event</CardTitle>
              <CardDescription>
                Choose an event type to generate a payload for ({ctx.events.length} available)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                placeholder="Search events..."
                value={ctx.searchQuery}
                onChange={(e) => send({ type: "SEARCH_CHANGE", query: e.target.value })}
                className="mb-2"
              />
              <div className="max-h-[500px] space-y-2 overflow-y-auto pr-1">
                {filteredEvents.map((event) => (
                  <button
                    key={event.name}
                    onClick={() => send({ type: "SELECT_EVENT", event })}
                    className="w-full rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm">{event.name}</span>
                      <Badge variant="secondary" className="shrink-0">
                        v{event.version}
                      </Badge>
                    </div>
                    {event.description && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                        {event.description.trim().split("\n")[0]}
                      </p>
                    )}
                  </button>
                ))}
                {filteredEvents.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No events match your search.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ---- GENERATING PAYLOAD ---- */}
        {isGenerating && (
          <Card>
            <CardContent className="py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">Generating payload...</p>
            </CardContent>
          </Card>
        )}

        {/* ---- EDITING / SENDING / SAVING / LOADING EXAMPLE ---- */}
        {isEditing && ctx.selectedEvent && (
          <>
            {/* Header with back button */}
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => send({ type: "BACK" })}
                disabled={isActionDisabled}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-lg font-semibold">{ctx.selectedEvent.name}</h2>
                  <Badge variant="secondary">v{ctx.selectedEvent.version}</Badge>
                </div>
                {ctx.selectedEvent.description && (
                  <p className="truncate text-sm text-muted-foreground">
                    {ctx.selectedEvent.description.trim().split("\n")[0]}
                  </p>
                )}
              </div>
            </div>

            {/* Saved examples */}
            {ctx.savedExamples.length > 0 && (
              <Card>
                <CardContent className="py-3">
                  <div className="flex items-center gap-2">
                    <Label className="shrink-0 text-sm font-medium">Load saved example:</Label>
                    <Select
                      onValueChange={(fileName) =>
                        send({ type: "LOAD_EXAMPLE", fileName })
                      }
                      disabled={isActionDisabled}
                    >
                      <SelectTrigger className="w-[240px]">
                        <SelectValue placeholder="Select an example..." />
                      </SelectTrigger>
                      <SelectContent>
                        {ctx.savedExamples.map((ex) => (
                          <SelectItem key={ex.fileName} value={ex.fileName}>
                            {ex.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* JSON Editor */}
            <Card>
              <CardContent className="p-4">
                <div className="mb-2 flex items-center justify-between">
                  <Label className="text-sm font-medium">Event Payload</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => send({ type: "FORMAT_JSON" })}
                    disabled={isActionDisabled}
                  >
                    Format JSON
                  </Button>
                </div>
                {isLoadingExample ? (
                  <div className="flex min-h-[400px] items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <Textarea
                    value={ctx.jsonText}
                    onChange={(e) => send({ type: "JSON_CHANGE", value: e.target.value })}
                    className="min-h-[400px] resize-y bg-muted/50 font-mono text-sm"
                    spellCheck={false}
                    disabled={isActionDisabled}
                  />
                )}
                {ctx.jsonError && (
                  <p className="mt-1 text-sm text-destructive">{ctx.jsonError}</p>
                )}
              </CardContent>
            </Card>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => send({ type: "REGENERATE" })}
                disabled={isActionDisabled}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Regenerate
              </Button>
              <Button
                variant="outline"
                onClick={() => send({ type: "OPEN_SAVE_DIALOG" })}
                disabled={isActionDisabled}
              >
                <Save className="mr-2 h-4 w-4" />
                Save Example
              </Button>
              <div className="flex-1" />
              <Button
                onClick={() => send({ type: "SEND" })}
                disabled={isActionDisabled}
              >
                {isSending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Send to EventBridge
              </Button>
            </div>

            {/* Status message */}
            {ctx.status && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg border p-3",
                  ctx.status.type === "success" &&
                    "border-green-500/50 bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
                  ctx.status.type === "error" &&
                    "border-destructive/50 bg-destructive/10 text-destructive",
                )}
              >
                {ctx.status.type === "success" ? (
                  <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span className="break-all text-sm">{ctx.status.message}</span>
              </div>
            )}

            {/* Save Dialog — controlled by machine state */}
            <Dialog
              open={isSaveDialogOpen}
              onOpenChange={(open) => {
                if (!open && !isSavingInProgress) send({ type: "CLOSE_SAVE_DIALOG" });
              }}
            >
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Save Event Example</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Save to:{" "}
                  <code className="text-xs">examples/{ctx.selectedEvent?.name}/</code>
                </p>
                <div className="space-y-2">
                  <Label htmlFor="save-filename">Filename</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      id="save-filename"
                      value={ctx.saveFileName}
                      onChange={(e) =>
                        send({ type: "SAVE_FILENAME_CHANGE", value: e.target.value })
                      }
                      placeholder="my-test-payload"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && ctx.saveFileName.trim()) {
                          send({ type: "SAVE_CONFIRM" });
                        }
                      }}
                      disabled={isSavingInProgress}
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">.json</span>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => send({ type: "CLOSE_SAVE_DIALOG" })}
                    disabled={isSavingInProgress}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => send({ type: "SAVE_CONFIRM" })}
                    disabled={!ctx.saveFileName.trim() || isSavingInProgress}
                  >
                    {isSavingInProgress && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Save
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
    </main>
  );
}
