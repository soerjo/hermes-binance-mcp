/**
 * Entrypoint — dual transport, same as the Python server.
 *
 *   MCP_TRANSPORT=stdio  (default, for Hermes subprocess mode)
 *   MCP_TRANSPORT=sse    (container / HTTP mode, default port 8811)
 *
 * The SSE implementation keeps the legacy `GET /sse` + `POST /messages`
 * contract that the crypto-trading-engine client expects.
 */

import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config";
import { createLogger } from "./logger";
import { markPriceStream } from "./binance/ws-stream";
import { stopDohTunnel } from "./binance/doh-tunnel";
import { createServer } from "./tools/handlers";

const log = createLogger("main");

const HEARTBEAT_MS = 25_000;

function startSseServer(): void {
  const sessions = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res, sessions).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`HTTP handler error: ${message}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    });
  });

  httpServer.listen(config.port, config.host, () => {
    log.info(`Binance Futures MCP Server (SSE) listening on ${config.host}:${config.port}`);
    log.info(`SSE endpoint: http://${config.host}:${config.port}/sse`);
  });

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}; shutting down`);
    markPriceStream.stop();
    stopDohTunnel();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: Map<string, SSEServerTransport>,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Liveness probe for Docker / Gluetun healthchecks.
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "binance-futures-mcp" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, transport);
    log.info(`SSE session opened: ${transport.sessionId}`);

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // Socket already closed; cleanup happens on 'close'.
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      sessions.delete(transport.sessionId);
      log.info(`SSE session closed: ${transport.sessionId}`);
    };
    let closed = false;
    res.on("close", cleanup);
    transport.onclose = cleanup;

    // A fresh McpServer per connection: the SDK binds one transport per server.
    const server = createServer();
    await server.connect(transport);
    return;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Session not found");
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/sse") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const transport = sessions.get(sessionId);
    if (transport) {
      await transport.close();
      sessions.delete(sessionId);
    }
    res.writeHead(200).end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

async function startStdioServer(): Promise<void> {
  log.info("Binance Futures MCP Server (stdio)");
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    markPriceStream.stop();
    stopDohTunnel();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function main(): Promise<void> {
  // Warm the mark-price cache in the background; tools fall back to REST if it
  // cannot connect (proxy, VPN, offline).
  markPriceStream.start();

  if (config.transport === "sse") {
    startSseServer();
  } else {
    await startStdioServer();
  }
}

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", reason);
});

void main().catch((error) => {
  log.error("Fatal startup error", error);
  process.exit(1);
});
