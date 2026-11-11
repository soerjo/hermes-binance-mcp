/**
 * Binance USDT-M Futures + Spot REST client.
 *
 * Differences from the legacy Python client:
 *  - One long-lived client instance per process (connection pool stays warm).
 *  - Native HMAC-SHA256 through Bun.CryptoHasher (no per-request interpreter work).
 *  - In-memory exchangeInfo cache with TTL.
 *  - Mark-price reads are served from the WebSocket cache when it is warm.
 */

import { BINANCE_FUTURES_URL, BINANCE_SPOT_URL, config } from "../config";
import { createLogger } from "../logger";
import { markPriceStream } from "./ws-stream";
import { ensureDohTunnel, stopDohTunnel } from "./doh-tunnel";
import type {
  AccountInfo,
  AlgoOrder,
  BinanceKline,
  BookTicker,
  ExchangeInfo,
  IncomeRecord,
  MarkPrice,
  OrderParams,
  PositionRisk,
  SpotAccount,
  SpotOrder,
  Ticker24hr,
} from "./types";

const log = createLogger("binance-client");

export class BinanceAPIError extends Error {
  constructor(
    public readonly code: number,
    public readonly msg: string,
  ) {
    super(`BinanceAPIError code=${code}: ${msg}`);
    this.name = "BinanceAPIError";
  }
}

function cleanParams(params: OrderParams): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") {
      cleaned[key] = value ? "true" : "false";
    } else {
      cleaned[key] = String(value);
    }
  }
  return cleaned;
}

function encode(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

interface RequestOptions {
  signed?: boolean;
  spot?: boolean;
  method?: "GET" | "POST" | "DELETE";
  params?: OrderParams;
  timeoutMs?: number;
}

class BinanceClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly proxy?: string;
  private exchangeInfoCache: ExchangeInfo | null = null;
  private exchangeInfoCachedAt = 0;
  private timeOffsetMs = 0;

  constructor() {
    const apiKey = config.apiKey;
    const apiSecret = config.apiSecret;
    if (!apiKey || !apiSecret) {
      throw new Error("BINANCE_API_KEY and BINANCE_API_SECRET must be set");
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.proxy = config.proxy;
  }

  // ------------------------------------------------------------------
  // Low-level request helpers
  // ------------------------------------------------------------------

  private sign(params: OrderParams): string {
    const cleaned = cleanParams(params);
    cleaned.timestamp = String(Date.now() + this.timeOffsetMs);
    cleaned.recvWindow = String(config.recvWindow);
    const query = encode(cleaned);
    const hasher = new Bun.CryptoHasher("sha256", this.apiSecret);
    hasher.update(query);
    const signature = hasher.digest("hex");
    return `${query}&signature=${signature}`;
  }

  private async syncTime(): Promise<void> {
    try {
      const data = await this.request<{ serverTime: number }>("/fapi/v1/time", {
        timeoutMs: 5000,
      });
      if (data && typeof data.serverTime === "number") {
        this.timeOffsetMs = data.serverTime - Date.now();
      }
    } catch {
      // Best-effort; fall back to local clock if the sync fails.
    }
  }

  private isTransientStatus(status: number): boolean {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { signed = false, spot = false, method = "GET", params = {}, timeoutMs = 15000 } = options;
    const base = spot ? BINANCE_SPOT_URL : BINANCE_FUTURES_URL;
    const isIdempotent = method === "GET";

    const attempt = async (retryOnTimeDrift: boolean): Promise<T> => {
      let url = `${base}${path}`;
      const init: RequestInit = {
        method,
        headers: {
          "X-MBX-APIKEY": this.apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        signal: AbortSignal.timeout(timeoutMs),
        keepalive: true,
      };

      if (method === "GET" || method === "DELETE") {
        const query = signed ? this.sign(params) : encode(cleanParams(params));
        if (query) url += `?${query}`;
      } else if (signed) {
        url += `?${this.sign(params)}`;
      } else {
        init.body = encode(cleanParams(params));
      }

      let effectiveProxy = this.proxy;
      if (!effectiveProxy && config.dohEnabled) {
        effectiveProxy = await ensureDohTunnel();
      }
      if (effectiveProxy) {
        (init as Record<string, unknown>).proxy = effectiveProxy;
      }

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        if (isIdempotent) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const retryResponse = await fetch(url, init);
          if (!retryResponse.ok) {
            const retryText = await retryResponse.text();
            throw new Error(`HTTP ${retryResponse.status} from ${path}: ${retryText.slice(0, 200)}`);
          }
          const retryText = await retryResponse.text();
          let retryData: unknown;
          try {
            retryData = retryText.length > 0 ? JSON.parse(retryText) : null;
          } catch {
            return retryText as unknown as T;
          }
          if (retryData && typeof retryData === "object" && !Array.isArray(retryData)) {
            const code = (retryData as Record<string, unknown>).code;
            if (typeof code === "number" && code < 0) {
              throw new BinanceAPIError(code, String((retryData as Record<string, unknown>).msg ?? "unknown error"));
            }
          }
          return retryData as T;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Network error calling ${path}: ${message}`);
      }

      const text = await response.text();
      let data: unknown;
      try {
        data = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from ${path}: ${text.slice(0, 200)}`);
        }
        return text as unknown as T;
      }

      if (data && typeof data === "object" && !Array.isArray(data)) {
        const code = (data as Record<string, unknown>).code;
        if (typeof code === "number" && code < 0) {
          const apiError = new BinanceAPIError(code, String((data as Record<string, unknown>).msg ?? "unknown error"));
          // -1021: timestamp drift. Sync clock and retry once for signed requests.
          if (retryOnTimeDrift && signed && code === -1021) {
            await this.syncTime();
            return attempt(false);
          }
          throw apiError;
        }
      }

      if (!response.ok) {
        if (isIdempotent && this.isTransientStatus(response.status)) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return attempt(false);
        }
        throw new Error(`HTTP ${response.status} from ${path}: ${text.slice(0, 200)}`);
      }

      return data as T;
    };

    return attempt(true);
  }

  // ------------------------------------------------------------------
  // Public market data
  // ------------------------------------------------------------------

  getServerTime(): Promise<{ serverTime: number }> {
    return this.request("/fapi/v1/time");
  }

  async getExchangeInfo(forceRefresh = false): Promise<ExchangeInfo> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.exchangeInfoCache &&
      now - this.exchangeInfoCachedAt < config.exchangeInfoTtl * 1000
    ) {
      return this.exchangeInfoCache;
    }
    const data = await this.request<ExchangeInfo>("/fapi/v1/exchangeInfo");
    if (data && Array.isArray(data.symbols)) {
      this.exchangeInfoCache = data;
      this.exchangeInfoCachedAt = now;
    }
    return data;
  }

  getKlines(symbol: string, interval: string, limit = 200): Promise<BinanceKline[]> {
    return this.request<BinanceKline[]>("/fapi/v1/klines", {
      params: { symbol, interval, limit },
    });
  }

  getTicker24hr(symbol?: string): Promise<Ticker24hr[] | Ticker24hr> {
    return this.request("/fapi/v1/ticker/24hr", {
      params: symbol ? { symbol } : {},
    });
  }

  getBookTicker(symbol: string): Promise<BookTicker> {
    return this.request<BookTicker>("/fapi/v1/ticker/bookTicker", { params: { symbol } });
  }

  async getMarkPrice(symbol?: string): Promise<MarkPrice | MarkPrice[]> {
    if (symbol) {
      const cached = markPriceStream.get(symbol);
      if (cached) return cached;
    }
    return this.request<MarkPrice | MarkPrice[]>("/fapi/v1/premiumIndex", {
      params: symbol ? { symbol } : {},
    });
  }

  getOpenInterest(symbol: string): Promise<{ symbol: string; openInterest: string; time: number }> {
    return this.request("/fapi/v1/openInterest", { params: { symbol } });
  }

  getTopLongShortRatio(symbol: string, period = "5m", limit = 1): Promise<Array<{ symbol: string; longShortRatio: string; longAccount: string; shortAccount: string; timestamp: number }>> {
    return this.request("/futures/data/topLongShortAccountRatio", {
      params: { symbol, period, limit },
    });
  }

  // ------------------------------------------------------------------
  // Account & positions (signed)
  // ------------------------------------------------------------------

  getAccount(): Promise<AccountInfo> {
    return this.request<AccountInfo>("/fapi/v2/account", { signed: true });
  }

  getPositionRisk(symbol?: string): Promise<PositionRisk[]> {
    return this.request<PositionRisk[]>("/fapi/v2/positionRisk", {
      signed: true,
      params: symbol ? { symbol } : {},
    });
  }

  getOpenOrders(symbol?: string): Promise<Record<string, unknown>[]> {
    return this.request("/fapi/v1/openOrders", {
      signed: true,
      params: symbol ? { symbol } : {},
    });
  }

  getIncomeHistory(limit = 50): Promise<IncomeRecord[]> {
    return this.request<IncomeRecord[]>("/fapi/v1/income", {
      signed: true,
      params: { limit },
    });
  }

  // ------------------------------------------------------------------
  // Standard orders (signed)
  // ------------------------------------------------------------------

  changeLeverage(symbol: string, leverage: number): Promise<Record<string, unknown>> {
    return this.request("/fapi/v1/leverage", {
      method: "POST",
      signed: true,
      params: { symbol, leverage },
    });
  }

  changeMarginType(symbol: string, marginType: string): Promise<Record<string, unknown>> {
    return this.request("/fapi/v1/marginType", {
      method: "POST",
      signed: true,
      params: { symbol, marginType },
    });
  }

  placeOrder(params: OrderParams): Promise<Record<string, unknown>> {
    return this.request("/fapi/v1/order", { method: "POST", signed: true, params });
  }

  /** Query a single futures order by orderId or origClientOrderId. */
  getOrder(
    symbol: string,
    params: { orderId?: number; origClientOrderId?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("/fapi/v1/order", {
      method: "GET",
      signed: true,
      params: { symbol, ...params },
    });
  }

  cancelOrder(symbol: string, orderId: number): Promise<Record<string, unknown>> {
    return this.request("/fapi/v1/order", {
      method: "DELETE",
      signed: true,
      params: { symbol, orderId },
    });
  }

  cancelAllOrders(symbol: string): Promise<Record<string, unknown>> {
    return this.request("/fapi/v1/allOpenOrders", {
      method: "DELETE",
      signed: true,
      params: { symbol },
    });
  }

  // ------------------------------------------------------------------
  // Algo / conditional orders (signed)
  // ------------------------------------------------------------------

  placeAlgoOrder(params: OrderParams): Promise<Record<string, unknown>> {
    return this.request("/fapi/v1/algoOrder", { method: "POST", signed: true, params });
  }

  cancelAlgoOrder(symbol: string, algoId: number): Promise<Record<string, unknown>> {
    return this.request("/fapi/v1/algoOrder", {
      method: "DELETE",
      signed: true,
      params: { symbol, algoId },
    });
  }

  async getOpenAlgoOrders(symbol?: string): Promise<AlgoOrder[]> {
    const data = await this.request<AlgoOrder[] | { orders?: AlgoOrder[] }>("/fapi/v1/openAlgoOrders", {
      signed: true,
      params: symbol ? { symbol } : {},
    });
    if (Array.isArray(data)) return data;
    return data?.orders ?? [];
  }

  async closePosition(symbol: string, positionSide = "BOTH"): Promise<Record<string, unknown>> {
    const positions = await this.getPositionRisk(symbol);
    const pos = positions.find((p) => p.symbol === symbol && Number(p.positionAmt) !== 0);
    if (!pos) {
      return { symbol, status: "NO_OPEN_POSITION" };
    }
    const amount = Number(pos.positionAmt);
    return this.placeOrder({
      symbol,
      side: amount > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: Math.abs(amount),
      reduceOnly: true,
      positionSide,
    });
  }

  // ------------------------------------------------------------------
  // Spot
  // ------------------------------------------------------------------

  async getSpotAccount(nonZeroOnly = true): Promise<SpotAccount> {
    const data = await this.request<SpotAccount>("/api/v3/account", { signed: true, spot: true });
    if (nonZeroOnly && Array.isArray(data.balances)) {
      data.balances = data.balances.filter(
        (b) => Number(b.free ?? 0) > 0 || Number(b.locked ?? 0) > 0,
      );
    }
    return data;
  }

  getSpotOpenOrders(symbol?: string): Promise<SpotOrder[]> {
    return this.request<SpotOrder[]>("/api/v3/openOrders", {
      signed: true,
      spot: true,
      params: symbol ? { symbol: symbol.toUpperCase() } : {},
    });
  }

  getSpotTicker(symbol?: string): Promise<Array<{ symbol: string; price: string }> | { symbol: string; price: string }> {
    return this.request("/api/v3/ticker/price", {
      spot: true,
      params: symbol ? { symbol: symbol.toUpperCase() } : {},
    });
  }

  createSpotOrder(input: {
    symbol: string;
    side: string;
    orderType: string;
    quantity?: number;
    quoteOrderQty?: number;
    price?: number;
    timeInForce?: string;
    newClientOrderId?: string;
  }): Promise<Record<string, unknown>> {
    const params: OrderParams = {
      symbol: input.symbol.toUpperCase(),
      side: input.side.toUpperCase(),
      type: input.orderType.toUpperCase(),
    };
    if (input.quantity !== undefined) params.quantity = input.quantity;
    if (input.quoteOrderQty !== undefined) params.quoteOrderQty = input.quoteOrderQty;
    if (input.price !== undefined) params.price = input.price;
    if (input.timeInForce !== undefined) params.timeInForce = input.timeInForce;
    else if (input.orderType.toUpperCase() === "LIMIT") params.timeInForce = "GTC";
    if (input.newClientOrderId) params.newClientOrderId = input.newClientOrderId;

    return this.request("/api/v3/order", { method: "POST", signed: true, spot: true, params });
  }

  cancelSpotOrder(input: {
    symbol: string;
    orderId?: number;
    origClientOrderId?: string;
  }): Promise<Record<string, unknown>> {
    const params: OrderParams = { symbol: input.symbol.toUpperCase() };
    if (input.orderId !== undefined) params.orderId = input.orderId;
    if (input.origClientOrderId) params.origClientOrderId = input.origClientOrderId;
    return this.request("/api/v3/order", {
      method: "DELETE",
      signed: true,
      spot: true,
      params,
    });
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton (keeps the HTTP connection pool warm)
// ---------------------------------------------------------------------------

let singleton: BinanceClient | null = null;

export function getClient(): BinanceClient {
  if (!singleton) singleton = new BinanceClient();
  return singleton;
}

export function resetClientForTests(): void {
  singleton = null;
}

export type { BinanceClient };
