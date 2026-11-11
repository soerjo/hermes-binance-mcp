/**
 * Real-time mark-price / funding-rate cache.
 *
 * A single WebSocket to Binance's `!markPrice@arr@1s` stream keeps mark price,
 * index price, funding rate and next funding time for every USDT-M perp in RAM.
 * Tools that need a mark price then avoid a REST round-trip entirely.
 *
 * The stream is best-effort: if it cannot connect (VPN, proxy, offline), callers
 * transparently fall back to REST because `get()` returns `undefined`.
 */

import { config } from "../config";
import { createLogger } from "../logger";
import type { MarkPrice } from "./types";

const log = createLogger("mark-price-ws");

const STALE_AFTER_MS = 5000;

interface StreamMessage {
  s: string; // symbol
  p: string; // mark price
  i: string; // index price
  r: string; // funding rate
  T: number; // next funding time
  E: number; // event time
}

class MarkPriceStream {
  private cache = new Map<string, MarkPrice>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private started = false;
  private stopped = false;
  private lastMessageAt = 0;

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;

    if (!config.wsEnabled) {
      log.info("Mark-price WebSocket disabled via BINANCE_WS_ENABLED=0");
      return;
    }
    if (config.proxy) {
      // Bun's WebSocket has no proxy option. Inside the Gluetun sidecar no proxy
      // is needed; when a proxy IS configured, prefer REST to avoid leaking a
      // direct connection.
      log.info("Proxy configured — using REST for mark prices (WebSocket skipped)");
      return;
    }

    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  /** Fresh mark-price entry, or undefined when the cache is cold/stale. */
  get(symbol: string): MarkPrice | undefined {
    const entry = this.cache.get(symbol);
    if (!entry) return undefined;
    if (Date.now() - this.lastMessageAt > STALE_AFTER_MS) return undefined;
    return entry;
  }

  get size(): number {
    return this.cache.size;
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      const socket = new WebSocket(config.wsUrl);
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectDelay = 1000;
        log.info("Connected to Binance mark-price stream");
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as StreamMessage[] | { data?: StreamMessage[] };
          const rows = Array.isArray(payload) ? payload : payload.data;
          if (!Array.isArray(rows)) return;
          const now = Date.now();
          for (const row of rows) {
            if (!row?.s) continue;
            this.cache.set(row.s, {
              symbol: row.s,
              markPrice: row.p,
              indexPrice: row.i,
              lastFundingRate: row.r,
              nextFundingTime: row.T,
              time: row.E ?? now,
            });
          }
          this.lastMessageAt = now;
        } catch (error) {
          log.debug("Bad mark-price payload", error);
        }
      };

      socket.onerror = () => {
        // onclose handles reconnect; keep noise low.
      };

      socket.onclose = () => {
        this.socket = null;
        if (this.stopped) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        log.warn(`Mark-price stream closed; reconnecting in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      };
    } catch (error) {
      log.warn("Failed to open mark-price stream", error);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    }
  }
}

export const markPriceStream = new MarkPriceStream();
