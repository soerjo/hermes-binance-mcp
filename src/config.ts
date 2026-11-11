/**
 * Central configuration for the Binance MCP server.
 * Every value can be overridden through environment variables, mirroring the
 * previous Python implementation so existing deployments keep working.
 */

function envStr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  // Transport
  transport: envStr("MCP_TRANSPORT", "stdio").toLowerCase(),
  host: envStr("MCP_HOST", "0.0.0.0"),
  port: envInt("MCP_PORT", 8811),

  // Binance credentials (read lazily so the module can be imported in tests)
  get apiKey(): string {
    return process.env.BINANCE_API_KEY ?? "";
  },
  get apiSecret(): string {
    return process.env.BINANCE_API_SECRET ?? "";
  },
  get proxy(): string | undefined {
    return process.env.BINANCE_PROXY || process.env.HTTPS_PROXY || undefined;
  },
  get dohEnabled(): boolean {
    return envStr("BINANCE_DOH_ENABLED", "1") !== "0";
  },

  // Analysis defaults
  scanTopN: envInt("SCAN_TOP_N", 15),
  scanInterval: envStr("SCAN_INTERVAL", "15m"),
  defaultLeverage: envInt("DEFAULT_LEVERAGE", 5),
  riskReward: envFloat("RISK_REWARD", 2.0),

  // Risk engine
  maxRiskPerTradePct: envFloat("MAX_RISK_PER_TRADE_PCT", 0.02),
  maxOpenPositions: envInt("MAX_OPEN_POSITIONS", 5),
  maxLeverage: envInt("MAX_LEVERAGE", 25),
  maxFundingRate: envFloat("MAX_FUNDING_RATE", 0.001),
  fundingBlackoutMinutes: envInt("FUNDING_BLACKOUT_MINUTES", 30),
  minConfidence: envInt("MIN_CONFIDENCE", 60),
  maxDailyLossPct: envFloat("MAX_DAILY_LOSS_PCT", 0.05),
  minFreeMarginUsd: 20.0,

  // REST cache
  exchangeInfoTtl: envInt("EXCHANGE_INFO_TTL", 3600),
  recvWindow: envInt("RECV_WINDOW", 30000),

  // Entry fill wait (place_futures_order protects only AFTER the entry fills)
  entryFillTimeoutS: envInt("ENTRY_FILL_TIMEOUT_S", 30),
  entryFillPollMs: envInt("ENTRY_FILL_POLL_MS", 750),
  marketFillWaitS: envInt("MARKET_FILL_WAIT_S", 5),

  // WebSocket mark-price cache
  wsEnabled: envStr("BINANCE_WS_ENABLED", "1") !== "0",
  wsUrl: envStr("BINANCE_WS_URL", "wss://fstream.binance.com/ws/!markPrice@arr@1s"),

  logLevel: envStr("LOG_LEVEL", "INFO").toUpperCase(),
} as const;

export const BINANCE_FUTURES_URL = "https://fapi.binance.com";
export const BINANCE_SPOT_URL = "https://api.binance.com";
