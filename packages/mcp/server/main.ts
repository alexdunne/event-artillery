#!/usr/bin/env node

/**
 * Entry point for the Event Artillery MCP server.
 *
 * Run with:
 *   npx tsx server/main.ts          # stdio mode (default, for MCP client integration)
 *   npx tsx server/main.ts --http   # HTTP mode (binds 127.0.0.1:${PORT:-3001})
 *
 * Environment variables:
 *   EVENTS_YAML_PATH  Path to your AsyncAPI events.yaml (default: ./events.yaml)
 *   EXAMPLES_DIR      Path to the saved examples directory (default: ./examples)
 *   EVENT_BUS_NAME    EventBridge bus name (default: my-event-bus)
 *   EVENT_SOURCE      EventBridge source field (default: event-artillery)
 *   AWS_REGION        AWS region (default: us-east-1)
 *   AWS_PROFILE       Shared AWS profile for EventBridge requests
 *   PORT              HTTP server port (default: 3001)
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

// Restrict CORS to localhost origins only — this server runs locally and has
// ambient AWS credentials, so cross-origin access from arbitrary sites is unsafe.
const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
});

async function startHttpServer(factory: () => McpServer): Promise<void> {
  // Bind to loopback only — this server carries ambient AWS credentials and
  // should not be reachable from other machines on the network.
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.use(corsMiddleware);

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = factory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(PORT, "127.0.0.1", () => {
    console.log(
      `Event Artillery MCP server listening on http://localhost:${PORT}/mcp`,
    );
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  if (process.argv.includes("--http")) {
    await startHttpServer(createServer);
  } else {
    await createServer().connect(new StdioServerTransport());
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
