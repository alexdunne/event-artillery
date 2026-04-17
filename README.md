# event-artillery-mcp

An MCP App that provides a React UI for generating and sending events to AWS EventBridge. It reads your AsyncAPI spec to discover available event types, generates realistic example payloads, and lets you edit and fire them with one click.

## Requirements

- Node.js >= 20.11.0
- AWS credentials available in the environment (e.g. via `aws sso login` or environment variables)

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVENTS_YAML_PATH` | No | `./events.yaml` | Path to your AsyncAPI `events.yaml` file |
| `EXAMPLES_DIR` | No | `./examples` | Path to the directory where saved event examples are stored |
| `EVENT_BUS_NAME` | No | `my-event-bus` | Name of the EventBridge event bus to publish to |
| `EVENT_SOURCE` | No | `event-artillery` | The `source` field set on all EventBridge events |
| `AWS_REGION` | No | `us-east-1` | AWS region of the event bus |
| `AWS_PROFILE` | No | - | Shared AWS config/credentials profile to use for EventBridge requests |
| `PORT` | No | `3001` | HTTP server port (HTTP mode only) |

The server resolves `EVENTS_YAML_PATH` and `EXAMPLES_DIR` relative to the MCP client's workspace root when the client supports `roots/list` (for example VS Code). If roots are unavailable, it falls back to `INIT_CWD` when available, then the current working directory. Validation is lazy: tool calls fail with a descriptive error if the resolved `events.yaml` path does not exist.

If the client exposes multiple file-based roots, set absolute `EVENTS_YAML_PATH` and `EXAMPLES_DIR` values so the server does not guess which workspace root to use.

## Usage

### As a binary (MCP stdio transport)

The published binary defaults to stdio mode, which is what MCP clients expect. The `start:stdio` script builds the package and runs `node dist/main.js`; build output is redirected to stderr so it does not corrupt the stdio JSON-RPC stream.

```bash
EVENTS_YAML_PATH=/path/to/events.yaml \
EXAMPLES_DIR=/path/to/examples \
AWS_PROFILE=my-profile \
npx event-artillery-mcp
```

### MCP client configuration

Add the following to your MCP client config (e.g. Claude Desktop's `claude_desktop_config.json` or Cursor's `mcp.json`):

```json
{
  "mcpServers": {
    "event-artillery-mcp": {
      "command": "npx",
      "args": ["-y", "event-artillery-mcp@1.0.0"],
      "env": {
        "EVENTS_YAML_PATH": "/absolute/path/to/events.yaml",
        "EXAMPLES_DIR": "/absolute/path/to/examples",
        "EVENT_BUS_NAME": "my-event-bus",
        "AWS_REGION": "us-east-1",
        "AWS_PROFILE": "my-profile"
      }
    }
  }
}
```

### Programmatic usage (HTTP transport)

Import the server factory and mount it in your own Express app:

```ts
import { createServer } from "event-artillery-mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = createMcpExpressApp({ host: "127.0.0.1" });

app.all("/mcp", async (req, res) => {
  const mcpServer = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

If you embed `createServer()` yourself, you are responsible for recreating the transport security controls from `main.ts`, including loopback-only binding, host validation, and any authentication you require. The `main.ts` entry point shows the reference setup for stdio-by-default and `--http` opt-in transport handling.

## Development

```bash
# Install dependencies
npm install

# Start in dev mode (Vite watch + tsx watch)
npm run dev

# Type-check only
npx tsc --noEmit

# Production build
npm run build
```

## Publishing

```bash
# Builds and type-checks automatically via prepublishOnly
npm publish --access public

# Local CI pipeline + dry-run publish
make publish-public-dry-run

# Local CI pipeline + public publish
make publish-public
```

> **Note on bundling:** The React UI (`mcp-app.tsx`) is bundled by Vite (`vite-plugin-singlefile`) into `dist/mcp-app.html`. The MCP server (`server.ts`) is compiled separately by `tsc` into `dist/`. At runtime, `server.ts` reads `dist/mcp-app.html` from disk and exposes it through `registerAppResource(...)` as the MCP App resource `ui://send-event/mcp-app.html`. HTTP mode exposes the MCP endpoint at `/mcp`; it does not serve the app HTML as a standalone route.

## Architecture

```
main.ts          Entry point — starts HTTP or stdio MCP server; CORS restricted to localhost
server.ts        MCP tools, EventBridge client, AsyncAPI spec loading
src/
  machine.ts     XState v5 state machine — drives all UI state
  mcp-app.tsx    React UI — rendered inside the MCP App iframe
  tool-names.ts  Shared tool name constants (server + UI)
  components/ui/ shadcn/ui components (Dialog, Select, Button, …)
```

### State machine

The UI is driven by a single XState v5 machine (`src/machine.ts`) with the following states:

```
idle → selecting → generatingPayload → editing ←──────────────────┐
                                           │                       │
                              ┌────────────┼────────────┐          │
                              ↓            ↓            ↓          │
                           sending    saving →    loadingExample   │
                              │       savingInProgress      │      │
                              └──────────────┬─────────────┘      │
                                             └────────────────────→┘
```

All async operations (payload generation, event sending, save/load) are modelled as `fromPromise` actors invoked from the machine, so the UI never has impossible state combinations.

## Troubleshooting

**`YAML file not found` on startup**
In VS Code, the server asks the MCP client for workspace roots and resolves relative `EVENTS_YAML_PATH` and `EXAMPLES_DIR` from that root. If the client does not support roots, it falls back to `INIT_CWD` and then the process working directory. In multi-root workspaces, use absolute paths so the server does not have to guess which root to use.

**AWS credential errors**
Ensure your AWS credentials are active before starting the server. For SSO profiles, run `aws sso login --profile <profile>` first.

**MCP client shows no tools**
If using HTTP mode, confirm the client is pointing at `http://localhost:<PORT>/mcp` (not just `http://localhost:<PORT>`) and that you started the server with `--http`. Stdio is the default transport for the binary.

**HTTP embedding safety**
If you embed `createServer()` in your own app, bind to loopback unless you intentionally want network access, and add your own authentication/authorization if the server should be reachable by anything other than your local user session.

**`CORS: origin … not allowed` in browser console**
The server only accepts requests from `localhost` and `127.0.0.1` origins. If your dev environment uses a different hostname, update the `corsMiddleware` in `main.ts`.
