/**
 * Built-in DNS-over-HTTPS (DoH) auto-tunnel.
 *
 * Indonesian ISPs (TrustPositif / aduankonten.id) poison the A records for
 * Binance domains (fapi.binance.com, api.binance.com, fstream.binance.com) so
 * that direct connections fail with HTTP 403 / certificate mismatch even
 * though the machine's public IP is whitelisted in Binance. This module
 * resolves those hostnames through Cloudflare/Google DoH and exposes a local
 * HTTP CONNECT proxy (127.0.0.1:<ephemeral>) that forwards to the real
 * CloudFront IP, letting Bun's fetch() and WebSocket keep using the original
 * hostname (so TLS SNI and certificate verification stay correct).
 *
 * When BINANCE_PROXY / HTTPS_PROXY is set, this module is bypassed entirely.
 */

import net from "node:net";

const DOH_ENDPOINTS = [
  "https://1.1.1.1/dns-query",
  "https://dns.google/resolve",
];

const dnsCache = new Map<string, { ip: string; expiresAt: number }>();

async function resolveDoH(host: string): Promise<string> {
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.ip;

  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const url = `${endpoint}?name=${encodeURIComponent(host)}&type=A`;
      const response = await fetch(url, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as {
        Answer?: Array<{ type: number; data: string }>;
      };
      const answer = data.Answer?.find((a) => a.type === 1);
      if (answer?.data) {
        dnsCache.set(host, { ip: answer.data, expiresAt: Date.now() + 5 * 60 * 1000 });
        return answer.data;
      }
    } catch {
      // Try the next DoH endpoint.
    }
  }
  throw new Error(`DoH resolution failed for ${host}`);
}

let tunnelServer: net.Server | null = null;
let tunnelUrl: string | null = null;
let tunnelPromise: Promise<string> | null = null;

async function startTunnel(): Promise<string> {
  if (tunnelUrl) return tunnelUrl;

  const server = net.createServer((client) => {
    client.once("data", (chunk) => {
      const match = chunk.toString("utf8").match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]/i);
      if (!match) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const host = match[1];
      const port = Number(match[2]);

      void (async () => {
        try {
          const ip = await resolveDoH(host);
          const upstream = net.connect(port, ip, () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("error", () => client.destroy());
          client.on("error", () => upstream.destroy());
          client.on("close", () => upstream.destroy());
        } catch {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  tunnelServer = server;
  tunnelUrl = `http://127.0.0.1:${port}`;
  // Do not keep the event loop alive solely for the tunnel.
  server.unref();
  return tunnelUrl;
}

/**
 * Ensure the DoH tunnel is running and return its proxy URL.
 * Idempotent and safe to call concurrently.
 */
export async function ensureDohTunnel(): Promise<string> {
  if (tunnelUrl) return tunnelUrl;
  if (!tunnelPromise) tunnelPromise = startTunnel();
  return tunnelPromise;
}

/**
 * Stop the tunnel (used during graceful shutdown).
 */
export function stopDohTunnel(): void {
  if (tunnelServer) {
    try {
      tunnelServer.close();
    } catch {
      // Already closed.
    }
    tunnelServer = null;
    tunnelUrl = null;
    tunnelPromise = null;
  }
}