/**
 * MCP tool registrations — a 1:1 port of the Python `server.py` contract.
 *
 * Tool names, argument names, defaults and JSON output shapes are preserved
 * exactly so Hermes Agent and the crypto-trading-engine keep working unchanged.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "../config";
import { createLogger } from "../logger";
import { BinanceAPIError, getClient } from "../binance/client";
import type {
  AlgoOrder,
  BinanceKline,
  MarkPrice,
  PositionRisk,
  SpotOrder,
} from "../binance/types";
import {
  analyzeSymbol,
  calculateSlTp,
  roundTo,
  scoreOpportunity,
  type SymbolAnalysis,
} from "../ta/analyzer";
import {
  calculatePositionSize,
  checkPositionHealth,
  checkPreTrade,
  MAX_LEVERAGE,
  RiskError,
  roundStepQty,
  roundTickPrice,
} from "../risk/engine";
import { getSymbolPrecision } from "../risk/precision";
import {
  ACTIVE_STATUSES,
  computeFinalRiskUsd,
  isFilledStatus,
  isTerminalOrderStatus,
  lookupFuturesOrder,
  normalizeOrderStatus,
  sanitizeClientOrderId,
  sleep,
  waitForTerminalStatus,
} from "./order-flow";

const log = createLogger("tools");

const DEFAULT_LEVERAGE = config.defaultLeverage;
const RISK_REWARD = config.riskReward;
const SCAN_TOP_N = config.scanTopN;
const SCAN_INTERVAL = config.scanInterval;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intOf(value: unknown, fallback = 0): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function oneMark(value: MarkPrice | MarkPrice[]): MarkPrice {
  if (Array.isArray(value)) return value[0] ?? ({ markPrice: "0" } as MarkPrice);
  return value ?? ({ markPrice: "0" } as MarkPrice);
}

function fmtPos(p: Record<string, unknown>): Record<string, unknown> {
  return {
    symbol: p.symbol,
    side: p.positionSide ?? p.side,
    entry_price: num(p.entryPrice),
    mark_price: num(p.markPrice),
    qty: num(p.positionAmt),
    unrealized_pnl: num(p.unRealizedProfit),
    leverage: intOf(p.leverage, 1),
    margin_type: p.marginType,
    initial_margin:
      num(p.initialMargin) ||
      num(p.isolatedWallet) ||
      num(p.positionInitialMargin),
  };
}

async function safe(name: string, fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(await fn());
  } catch (error) {
    if (error instanceof BinanceAPIError) {
      return textResult({ error: `Binance API error: ${error.message}` });
    }
    if (error instanceof RiskError) {
      return textResult({ error: `Risk rule blocked: ${error.message}` });
    }
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Tool ${name} failed: ${message}`);
    return textResult({ error: `Error: ${message}` });
  }
}

function findOpenPosition(positions: PositionRisk[], symbol: string): PositionRisk | undefined {
  return positions.find((p) => p.symbol === symbol && num(p.positionAmt) !== 0);
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "binance-futures", version: "1.0.0" });

  // ═══════════════════════════════════════════════════════════════════════
  // MARKET DATA
  // ═══════════════════════════════════════════════════════════════════════

  server.registerTool(
    "get_futures_market",
    {
      description:
        "Fetch OHLCV klines + 24h ticker + mark price for a single symbol.",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
        interval: z.string().default("4h").describe('kline interval e.g. "1h", "4h", "1d"'),
        limit: z.number().int().default(200).describe("number of candles (max 1500)"),
      },
    },
    async ({ symbol, interval, limit }) =>
      safe("get_futures_market", async () => {
        const client = getClient();
        const [klines, ticker, mark, book] = await Promise.all([
          client.getKlines(symbol, interval, limit),
          client.getTicker24hr(symbol),
          client.getMarkPrice(symbol),
          client.getBookTicker(symbol),
        ]);
        return {
          symbol,
          interval,
          klines,
          ticker_24h: ticker,
          mark_price: mark,
          book_ticker: book,
        };
      }),
  );

  server.registerTool(
    "scan_market",
    {
      description:
        "Scan top futures markets by 24h volume, run TA, score and rank opportunities.",
      inputSchema: {
        top_n: z.number().int().default(SCAN_TOP_N).describe("how many top-volume symbols to analyze"),
        interval: z.string().default(SCAN_INTERVAL).describe("kline interval for analysis"),
        min_volume_usdt: z
          .number()
          .default(50_000_000)
          .describe("minimum 24h volume filter (USDT)"),
      },
    },
    async ({ top_n, interval, min_volume_usdt }) =>
      safe("scan_market", async () => {
        const client = getClient();
        const tickers = await client.getTicker24hr();
        const list = Array.isArray(tickers) ? tickers : [tickers];

        const usdtPairs = list
          .filter(
            (t) => t.symbol.endsWith("USDT") && num(t.quoteVolume) >= min_volume_usdt,
          )
          .sort((a, b) => num(b.quoteVolume) - num(a.quoteVolume));

        const topSymbols = usdtPairs.slice(0, top_n).map((t) => t.symbol);
        const volumeBySymbol = new Map(usdtPairs.map((t) => [t.symbol, num(t.quoteVolume)]));
        log.info(`Scanning ${topSymbols.length} symbols: ${topSymbols.join(", ")}`);

        const results: Array<Record<string, unknown>> = [];
        const analyzeOne = async (sym: string): Promise<void> => {
          try {
            const [klines, markRaw] = await Promise.all([
              client.getKlines(sym, interval, 300),
              client.getMarkPrice(sym),
            ]);
            const mark = oneMark(markRaw);
            const fundingRate = num(mark.lastFundingRate);
            const analysis = analyzeSymbol(klines);
            if (!analysis.rsi || !analysis.macd) return;
            const score = scoreOpportunity(analysis, fundingRate);
            results.push({
              symbol: sym,
              price: num(mark.markPrice),
              volume_24h_usdt: volumeBySymbol.get(sym) ?? 0,
              funding_rate: fundingRate,
              funding_countdown_ms: intOf(mark.nextFundingTime),
              signal: analysis.signal,
              confidence: analysis.confidence,
              score,
              trend: analysis.trend,
              rsi: analysis.rsi.value,
              macd_cross: analysis.macd.cross,
              atr: analysis.atr,
              analysis,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`Failed to analyze ${sym}: ${message}`);
          }
        };

        // Concurrency-limited worker pool (6) to avoid Binance rate limits
        // while cutting the sequential per-symbol latency by ~6x.
        const scanConcurrency = 6;
        let scanNext = 0;
        const scanRunners = Array.from(
          { length: Math.min(scanConcurrency, Math.max(topSymbols.length, 1)) },
          async () => {
            for (;;) {
              const index = scanNext;
              scanNext += 1;
              if (index >= topSymbols.length) return;
              await analyzeOne(topSymbols[index]);
            }
          },
        );
        await Promise.all(scanRunners);

        results.sort((a, b) => num(b.score) - num(a.score));
        const actionable = results.filter((r) => r.signal !== "SKIP");
        return {
          scanned: results.length,
          actionable: actionable.length,
          interval,
          top_opportunities: results.slice(0, 10),
          ranked_actionable: actionable.slice(0, 5),
        };
      }),
  );

  server.registerTool(
    "analyze_market",
    {
      description:
        "Full technical analysis on a symbol: RSI, MACD, EMA, Bollinger, ATR, trend, signal.",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
        interval: z.string().default("15m").describe("kline interval"),
      },
    },
    async ({ symbol, interval }) =>
      safe("analyze_market", async () => {
        const client = getClient();
        const [klines, markRaw] = await Promise.all([
          client.getKlines(symbol, interval, 300),
          client.getMarkPrice(symbol),
        ]);
        const mark = oneMark(markRaw);
        const fundingRate = num(mark.lastFundingRate);
        const analysis = analyzeSymbol(klines);
        const score = scoreOpportunity(analysis, fundingRate);
        const slTp = calculateSlTp(
          num(mark.markPrice),
          analysis.signal,
          analysis.atr ?? 0,
          RISK_REWARD,
        );
        return {
          symbol,
          interval,
          mark_price: num(mark.markPrice),
          funding_rate: fundingRate,
          analysis,
          score,
          suggested_sl_tp: slTp,
        };
      }),
  );

  server.registerTool(
    "analyze_mtf",
    {
      description:
        "Single-call Multi-Timeframe technical analysis for a symbol. Default intervals: 4h, 1h, 15m, 5m. Pass `intervals` for custom (e.g. swing: 1d, 4h, 1h, 15m).",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
        intervals: z
          .array(z.string())
          .optional()
          .describe('e.g. ["1d","4h","1h","15m"] (default 4h,1h,15m,5m)'),
      },
    },
    async ({ symbol, intervals }) =>
      safe("analyze_mtf", async () => {
        const client = getClient();
        const markRaw = await client.getMarkPrice(symbol);
        const ivs = intervals && intervals.length > 0 ? intervals : ["4h", "1h", "15m", "5m"];
        const klines = await Promise.all(ivs.map((iv) => client.getKlines(symbol, iv, iv === "5m" ? 100 : 210)));
        const mark = oneMark(markRaw);
        const timeframes: Record<string, SymbolAnalysis> = {};
        ivs.forEach((iv, i) => {
          timeframes[iv] = analyzeSymbol(klines[i]);
        });
        return {
          symbol,
          mark_price: num(mark.markPrice),
          funding_rate: num(mark.lastFundingRate),
          next_funding_time: intOf(mark.nextFundingTime),
          timeframes,
        };
      }),
  );

  server.registerTool(
    "get_funding_rates",
    {
      description:
        "Get current funding rates for given symbols, or top 20 by abs rate if none given.",
      inputSchema: {
        symbols: z
          .array(z.string())
          .optional()
          .describe('list of symbol strings e.g. ["BTCUSDT", "ETHUSDT"]'),
      },
    },
    async ({ symbols }) =>
      safe("get_funding_rates", async () => {
        const client = getClient();
        if (symbols && symbols.length > 0) {
          return Promise.all(symbols.map((s) => client.getMarkPrice(s)));
        }
        const allMark = await client.getMarkPrice();
        if (Array.isArray(allMark)) {
          return [...allMark]
            .sort((a, b) => Math.abs(num(b.lastFundingRate)) - Math.abs(num(a.lastFundingRate)))
            .slice(0, 20);
        }
        return [allMark];
      }),
  );

  server.registerTool(
    "get_symbol_precision",
    {
      description:
        "Get Binance Futures LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL precision for a symbol.",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
      },
    },
    async ({ symbol }) =>
      safe("get_symbol_precision", async () => {
        const client = getClient();
        const exchangeInfo = await client.getExchangeInfo();
        const precision = getSymbolPrecision(exchangeInfo, symbol);
        return {
          symbol,
          qty_precision: precision.qty_precision,
          price_precision: precision.price_precision,
          min_qty: precision.min_qty,
          min_notional: precision.min_notional,
          qty_step: precision.qty_step,
          price_tick: precision.price_tick,
        };
      }),
  );

  server.registerTool(
    "get_derivatives_context",
    {
      description:
        "Get Open Interest + Top Trader Long/Short ratio for a symbol (squeeze & trap detection).",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
        period: z.string().default("5m").describe('period: "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"'),
      },
    },
    async ({ symbol, period }) =>
      safe("get_derivatives_context", async () => {
        const client = getClient();
        const [oi, topLs] = await Promise.all([
          client.getOpenInterest(symbol),
          client.getTopLongShortRatio(symbol, period, 1),
        ]);
        const latest = Array.isArray(topLs) && topLs.length > 0 ? topLs[topLs.length - 1] : null;
        return {
          symbol,
          open_interest: num(oi?.openInterest),
          oi_time: intOf(oi?.time),
          top_trader_long_short_ratio: latest ? num(latest.longShortRatio) : null,
          top_trader_long_pct: latest ? num(latest.longAccount) * 100 : null,
          top_trader_short_pct: latest ? num(latest.shortAccount) * 100 : null,
          period,
        };
      }),
  );

  server.registerTool(
    "recommend_trading_style",
    {
      description:
        "Analyze BTC/ETH/SOL across 1d/4h/1h/15m and recommend trading style (swing/intraday/scalp/wait) with regime, BTC bias, and suggested targets.",
      inputSchema: {},
    },
    async () =>
      safe("recommend_trading_style", async () => {
        const client = getClient();
        const leaders = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
        const ivs = ["1d", "4h", "1h", "15m"];
        const data: Record<string, Record<string, SymbolAnalysis>> = {};
        await Promise.all(
          leaders.map(async (sym) => {
            try {
              const ks = await Promise.all(ivs.map((iv) => client.getKlines(sym, iv, iv === "1d" ? 60 : 210)));
              const perTimeframe: Record<string, SymbolAnalysis> = {};
              ivs.forEach((iv, i) => {
                perTimeframe[iv] = analyzeSymbol(ks[i]);
              });
              // Assign only after every timeframe parsed, so a partial failure
              // is treated as missing data by the guard below.
              data[sym] = perTimeframe;
            } catch {
              // Leader unavailable — handled by the INSUFFICIENT_DATA guard below.
            }
          }),
        );

        // Fail-safe parity with crypto-trading-engine/src/regime.ts: if any of
        // BTC/ETH/SOL cannot be read, hold new entries instead of scoring a
        // regime from partial data.
        const missing = leaders.filter((sym) => !data[sym]);
        if (missing.length > 0) {
          return {
            recommended_style: "wait_and_see",
            regime: "INSUFFICIENT_DATA",
            btc_bias: "NEUTRAL_RANGE",
            btc_veto_long: false,
            btc_veto_short: false,
            scores: { scalp: 0, intraday: 0, swing: 0, wait_and_see: 100 },
            market_metrics: {},
            reasons: [
              `Regime data incomplete: missing ${missing.join(", ")}. Holding new entries.`,
            ],
            suggested_targets: {},
            auto_switch_available: true,
          };
        }

        // Compute metrics per leader
        const metrics: Record<string, Record<string, unknown>> = {};
        for (const sym of leaders) {
          const tf4h = data[sym]["4h"];
          const tf1h = data[sym]["1h"];
          const tf15 = data[sym]["15m"];
          metrics[sym] = {
            trend_4h: tf4h.trend,
            trend_1h: tf1h.trend,
            adx_4h: tf4h.adx,
            adx_1h: tf1h.adx,
            bbw_4h: tf4h.bollinger?.bandwidth,
            bbw_1h: tf1h.bollinger?.bandwidth,
            bbw_15m: tf15.bollinger?.bandwidth,
            rsi_15m: tf15.rsi?.value,
            chop_15m: tf15.choppiness,
            pctB_1h: tf1h.bollinger?.pct_b,
          };
        }

        // Regime scoring (continuous, 4 regimes)
        const btc = metrics["BTCUSDT"] as Record<string, unknown>;
        const eth = metrics["ETHUSDT"] as Record<string, unknown>;
        const sol = metrics["SOLUSDT"] as Record<string, unknown>;

        const adx4hAvg = ((btc.adx_4h as number) + (eth.adx_4h as number) + (sol.adx_4h as number)) / 3;
        const adx1hAvg = ((btc.adx_1h as number) + (eth.adx_1h as number) + (sol.adx_1h as number)) / 3;
        const bbw4hAvg = ((btc.bbw_4h as number) + (eth.bbw_4h as number) + (sol.bbw_4h as number)) / 3;
        const bbw1hAvg = ((btc.bbw_1h as number) + (eth.bbw_1h as number) + (sol.bbw_1h as number)) / 3;
        const bbw15Max = Math.max(btc.bbw_15m as number, eth.bbw_15m as number, sol.bbw_15m as number);
        const chopAvg = ((btc.chop_15m as number) + (eth.chop_15m as number) + (sol.chop_15m as number)) / 3;

        const trends4h = [btc.trend_4h, eth.trend_4h, sol.trend_4h];
        const allBullish4h = trends4h.every((t) => t === "BULLISH");
        const allBearish4h = trends4h.every((t) => t === "BEARISH");
        const aligned = allBullish4h || allBearish4h;
        const bullishCount = trends4h.filter((t) => t === "BULLISH").length;
        const bearishCount = trends4h.filter((t) => t === "BEARISH").length;
        const hasOpposition = bullishCount > 0 && bearishCount > 0;
        const majorityAligned = (bullishCount >= 2 && bearishCount === 0) || (bearishCount >= 2 && bullishCount === 0);

        let btcBias = "NEUTRAL_RANGE";
        if (btc.trend_4h === "BULLISH" && btc.trend_1h === "BULLISH") btcBias = "BULLISH_BIAS";
        else if (btc.trend_4h === "BEARISH" && btc.trend_1h === "BEARISH") btcBias = "BEARISH_BIAS";
        const btcVetoLong = btcBias === "BEARISH_BIAS" && (btc.adx_1h as number) >= 22;
        const btcVetoShort = btcBias === "BULLISH_BIAS" && (btc.adx_1h as number) >= 22;

        const scores = { swing: 0, intraday: 0, scalp: 0, wait_and_see: 0 };
        const deadMarket = bbw1hAvg < 1.1 && chopAvg > 62;
        const extremeWhipsaw = bbw15Max > 6.0 && chopAvg > 58;
        if (deadMarket) scores.wait_and_see += 85;
        else if (extremeWhipsaw) scores.wait_and_see += 70;
        else if (chopAvg > 62 && adx4hAvg < 15) scores.wait_and_see += 60;
        else if (chopAvg > 61.8) scores.wait_and_see += 35;

        if (adx4hAvg >= 26) scores.swing += 30;
        if (adx4hAvg >= 32) scores.swing += 15;
        if (aligned) scores.swing += 25;
        else if (majorityAligned) scores.swing += 12;
        if (bbw4hAvg >= 3.5) scores.swing += 15;
        if (bbw4hAvg >= 5.0) scores.swing += 10;
        if (chopAvg < 45) scores.swing += 10;
        else if (chopAvg < 55) scores.swing += 5;
        if (hasOpposition) scores.swing -= 15;

        if (adx4hAvg >= 18 && adx4hAvg <= 30) scores.intraday += 30;
        else if (adx4hAvg >= 26 && !aligned) scores.intraday += 25;
        else if (adx4hAvg >= 15 && adx4hAvg < 18) scores.intraday += 15;
        if (bbw1hAvg >= 1.6) scores.intraday += 20;
        if (bbw1hAvg >= 2.5) scores.intraday += 10;
        if (chopAvg >= 40 && chopAvg <= 58) scores.intraday += 15;
        if (majorityAligned || aligned) scores.intraday += 10;

        if (adx4hAvg < 20) scores.scalp += 25;
        else if (adx4hAvg < 24) scores.scalp += 10;
        if (chopAvg >= 54 && chopAvg <= 65) scores.scalp += 20;
        else if (chopAvg >= 48 && chopAvg < 54) scores.scalp += 10;
        if (bbw1hAvg >= 1.2 && bbw1hAvg <= 4.0) scores.scalp += 20;
        if (bbw15Max >= 1.0) scores.scalp += 10;
        if (aligned && adx4hAvg >= 28) scores.scalp -= 15;

        for (const k of Object.keys(scores) as Array<keyof typeof scores>) {
          scores[k] = Math.max(0, Math.min(100, Math.round(scores[k])));
        }
        const entries: Array<[string, number]> = [["swing", scores.swing], ["intraday", scores.intraday], ["scalp", scores.scalp], ["wait_and_see", scores.wait_and_see]];
        entries.sort((a, b) => b[1] - a[1]);
        const recommended = entries[0][1] >= 35 ? entries[0][0] : "wait_and_see";
        const regime = recommended === "swing" ? "MACRO_TREND_EXPANSION" : recommended === "intraday" ? "INTRADAY_RANGE_ROTATION" : recommended === "scalp" ? "CHOPPY_MICRO_RANGE" : (deadMarket ? "DEAD_MARKET" : "HIGH_VOL_WHIPSAW");

        const reasons: string[] = [];
        reasons.push(`ADX 4H avg = ${adx4hAvg.toFixed(1)} | ADX 1H avg = ${adx1hAvg.toFixed(1)}`);
        reasons.push(`BBW 4H avg = ${bbw4hAvg.toFixed(2)}% | BBW 1H avg = ${bbw1hAvg.toFixed(2)}% | BBW 15m max = ${bbw15Max.toFixed(2)}%`);
        reasons.push(`CHOP 15m avg = ${chopAvg.toFixed(1)} (>61.8 = choppy, <45 = clean trend)`);
        reasons.push(`Leader alignment 4H: ${aligned ? (allBullish4h ? "all BULLISH" : "all BEARISH") : majorityAligned ? "majority (no opposition)" : "mixed"}`);
        reasons.push(`BTC bias: ${btcBias}`);
        reasons.push(`Scores → Swing ${scores.swing} | Intraday ${scores.intraday} | Scalp ${scores.scalp} | Wait ${scores.wait_and_see}`);
        if (btcVetoLong) reasons.push("BTC Impulse Bearish → VETO all LONG signals on altcoins");
        if (btcVetoShort) reasons.push("BTC Impulse Bullish → VETO all SHORT signals on altcoins");

        const suggestedTargets: Record<string, unknown> = {};
        if (recommended === "swing") {
          Object.assign(suggestedTargets, { tp_target_pct: 6.0, sl_atr_mult: 2.0, be_trigger_pct: 2.8, partial_tp_pct: 4.2, chandelier_pct: 7.0, leverage_min: 5, leverage_def: 8, leverage_max: 10, max_risk_pct: 2.2 });
        } else if (recommended === "intraday") {
          Object.assign(suggestedTargets, { tp_target_pct: 2.4, sl_atr_mult: 1.5, be_trigger_pct: 1.8, partial_tp_pct: 2.2, chandelier_pct: 4.0, leverage_min: 10, leverage_def: 15, leverage_max: 20, max_risk_pct: 2.0 });
        } else if (recommended === "scalp") {
          Object.assign(suggestedTargets, { tp_target_pct: 1.4, sl_atr_mult: 1.2, be_trigger_pct: 1.0, partial_tp_pct: 1.3, chandelier_pct: 2.0, leverage_min: 10, leverage_def: 15, leverage_max: 20, max_risk_pct: 1.8 });
        } else {
          Object.assign(suggestedTargets, { tp_target_pct: 0, sl_atr_mult: 0, be_trigger_pct: 0, partial_tp_pct: 0, chandelier_pct: 0, leverage_min: 0, leverage_def: 0, leverage_max: 0, max_risk_pct: 0 });
        }

        return {
          recommended_style: recommended,
          regime,
          btc_bias: btcBias,
          btc_veto_long: btcVetoLong,
          btc_veto_short: btcVetoShort,
          scores,
          market_metrics: metrics,
          reasons,
          suggested_targets: suggestedTargets,
          auto_switch_available: true,
        };
      }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // ACCOUNT
  // ═══════════════════════════════════════════════════════════════════════

  server.registerTool(
    "get_account_status",
    {
      description:
        "Get current Binance Futures account: balance, margin, open position count. Call this before placing any order.",
      inputSchema: {},
    },
    async () =>
      safe("get_account_status", async () => {
        const account = await getClient().getAccount();
        const assets = account.assets ?? [];
        const usdt = (assets.find((a) => a.asset === "USDT") ?? {}) as Record<string, unknown>;
        const openPos = (account.positions ?? []).filter((p) => num(p.positionAmt) !== 0);
        return {
          total_wallet_balance: num(account.totalWalletBalance),
          total_unrealized_pnl: num(account.totalUnrealizedProfit),
          total_margin_balance: num(account.totalMarginBalance),
          available_balance: num(account.availableBalance),
          usdt: {
            wallet: num(usdt.walletBalance),
            available: num(usdt.availableBalance),
            unrealized_pnl: num(usdt.unrealizedProfit),
            initial_margin: num(usdt.initialMargin),
          },
          open_positions_count: openPos.length,
          can_trade: account.canTrade ?? false,
        };
      }),
  );

  server.registerTool(
    "get_open_positions",
    {
      description: "All open futures positions with health check (OK/WARN/CRITICAL + action).",
      inputSchema: {},
    },
    async () =>
      safe("get_open_positions", async () => {
        const allPos = await getClient().getPositionRisk();
        return allPos
          .filter((p) => num(p.positionAmt) !== 0)
          .map((p) => {
            const formatted = fmtPos(p as unknown as Record<string, unknown>);
            return { ...formatted, ...checkPositionHealth(p as unknown as Record<string, unknown>) };
          });
      }),
  );

  server.registerTool(
    "get_open_orders",
    {
      description: "Get all open orders (limit / stop / TP orders).",
      inputSchema: {
        symbol: z.string().optional().describe("filter by symbol, or omit for all symbols"),
      },
    },
    async ({ symbol }) =>
      safe("get_open_orders", async () => getClient().getOpenOrders(symbol)),
  );

  server.registerTool(
    "get_spot_account_status",
    {
      description:
        "Get current Binance Spot account status, non-zero coin balances, and estimated total value in USDT.",
      inputSchema: {},
    },
    async () =>
      safe("get_spot_account_status", async () => {
        const client = getClient();
        const account = await client.getSpotAccount(true);
        const rawBalances = account.balances ?? [];

        let priceMap = new Map<string, number>();
        try {
          const tickers = await client.getSpotTicker();
          const list = Array.isArray(tickers) ? tickers : [tickers];
          priceMap = new Map(list.map((t) => [t.symbol, num(t.price)]));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`Failed to fetch spot tickers for valuation: ${message}`);
        }

        const stablecoins = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD"]);
        const balances: Array<Record<string, unknown>> = [];
        let totalEstimated = 0;

        for (const b of rawBalances) {
          const asset = b.asset ?? "";
          const free = num(b.free);
          const locked = num(b.locked);
          const totalQty = free + locked;
          if (totalQty <= 0) continue;

          let est: number | null = null;
          if (stablecoins.has(asset)) {
            est = totalQty;
          } else if (priceMap.has(`${asset}USDT`)) {
            est = totalQty * (priceMap.get(`${asset}USDT`) as number);
          } else if (priceMap.has(`${asset}BTC`) && priceMap.has("BTCUSDT")) {
            est =
              totalQty *
              (priceMap.get(`${asset}BTC`) as number) *
              (priceMap.get("BTCUSDT") as number);
          }

          if (est !== null) totalEstimated += est;
          balances.push({
            asset,
            free,
            locked,
            total: totalQty,
            estimated_usdt: est !== null ? roundTo(est, 4) : null,
          });
        }

        balances.sort((a, b) => num(a.estimated_usdt, -1) - num(b.estimated_usdt, -1));
        balances.reverse();

        return {
          account_type: account.accountType ?? "SPOT",
          can_trade: account.canTrade ?? false,
          can_withdraw: account.canWithdraw ?? false,
          can_deposit: account.canDeposit ?? false,
          total_estimated_usdt: roundTo(totalEstimated, 2),
          balances_count: balances.length,
          balances,
        };
      }),
  );

  server.registerTool(
    "get_spot_open_orders",
    {
      description: "Get all open Spot orders.",
      inputSchema: {
        symbol: z.string().optional().describe('optional filter by symbol e.g. "BTCUSDT"'),
      },
    },
    async ({ symbol }) =>
      safe("get_spot_open_orders", async () => {
        const rawOrders = await getClient().getSpotOpenOrders(symbol);
        return rawOrders
          .filter((o): o is SpotOrder => typeof o === "object" && o !== null)
          .map((o) => ({
            symbol: o.symbol,
            order_id: o.orderId,
            client_order_id: o.clientOrderId,
            price: num(o.price),
            orig_qty: num(o.origQty),
            executed_qty: num(o.executedQty),
            status: o.status,
            type: o.type,
            side: o.side,
            time_in_force: o.timeInForce,
            time: o.time,
          }));
      }),
  );

  server.registerTool(
    "place_spot_order",
    {
      description: "Place a Binance Spot order (BUY or SELL).",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
        side: z.string().describe('"BUY" or "SELL"'),
        order_type: z.string().default("MARKET").describe('"MARKET" or "LIMIT"'),
        qty: z.number().optional().describe("base asset quantity (e.g. 0.01 BTC)"),
        quote_qty: z
          .number()
          .optional()
          .describe("quote asset quantity for MARKET orders (e.g. 50 USDT)"),
        price: z.number().optional().describe("limit order price"),
        time_in_force: z
          .string()
          .optional()
          .describe('e.g. "GTC", "IOC", "FOK" (defaults to GTC for LIMIT)'),
      },
    },
    async (args) =>
      safe("place_spot_order", async () => {
        const sideUpper = args.side.toUpperCase();
        if (sideUpper !== "BUY" && sideUpper !== "SELL") {
          return { error: "side must be BUY or SELL" };
        }
        const typeUpper = args.order_type.toUpperCase();
        if (typeUpper !== "MARKET" && typeUpper !== "LIMIT") {
          return { error: "order_type must be MARKET or LIMIT" };
        }
        if (typeUpper === "LIMIT" && args.price === undefined) {
          return { error: "price is required for LIMIT orders" };
        }
        if (args.qty === undefined && args.quote_qty === undefined) {
          return { error: "Either qty or quote_qty must be specified" };
        }

        return getClient().createSpotOrder({
          symbol: args.symbol,
          side: sideUpper,
          orderType: typeUpper,
          quantity: args.qty,
          quoteOrderQty: args.quote_qty,
          price: args.price,
          timeInForce: args.time_in_force,
        });
      }),
  );

  server.registerTool(
    "cancel_spot_order",
    {
      description: "Cancel an active Binance Spot order by order_id or client_order_id.",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
        order_id: z.number().int().optional().describe("Binance order ID"),
        client_order_id: z.string().optional().describe("Client order ID string"),
      },
    },
    async ({ symbol, order_id, client_order_id }) =>
      safe("cancel_spot_order", async () => {
        if (order_id === undefined && !client_order_id) {
          return { error: "Either order_id or client_order_id must be provided" };
        }
        return getClient().cancelSpotOrder({
          symbol,
          orderId: order_id,
          origClientOrderId: client_order_id,
        });
      }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // FUTURES ORDERS
  // ═══════════════════════════════════════════════════════════════════════

  server.registerTool(
    "place_futures_order",
    {
      description:
        "Place a Binance Futures LONG or SHORT with auto position sizing, SL, and TP. Risk rules and exchange LOT_SIZE / PRICE_FILTER precision enforced automatically.",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
        side: z.string().describe('"LONG" or "SHORT"'),
        leverage: z.number().int().default(DEFAULT_LEVERAGE).describe("1-MAX_LEVERAGE"),
        sl_price: z.number().optional().describe("stop-loss price (auto-calc from ATR if omitted)"),
        tp_price: z.number().optional().describe("take-profit price (auto-calc if omitted)"),
        qty: z.number().optional().describe("manual quantity (only if use_auto_sizing=false)"),
        notional_usdt: z
          .number()
          .optional()
          .describe("target notional in USDT (optional, auto-converts to exact exchange qty)"),
        use_auto_sizing: z
          .boolean()
          .default(true)
          .describe("size by 2% risk rule automatically"),
        margin_type: z.string().default("ISOLATED").describe('"ISOLATED" or "CROSSED"'),
        order_type: z
          .string()
          .default("LIMIT")
          .describe('"LIMIT" (default — maker fee) or "MARKET" (taker, explicit only)'),
        max_risk_usdt: z
          .number()
          .optional()
          .describe("hard risk cap in USDT: order rejected if final qty × SL distance × fees exceeds it"),
        reference_price: z
          .number()
          .optional()
          .describe("analysis-time reference price; order rejected if the book drifted beyond tolerance"),
        price_tolerance_pct: z
          .number()
          .default(0.5)
          .describe("max allowed |entry - reference_price| as % of reference (default 0.5)"),
        price: z
          .number()
          .optional()
          .describe(
            "limit order price. If omitted for LIMIT, a maker-safe price is auto-picked from the order book",
          ),
        time_in_force: z
          .string()
          .default("GTC")
          .describe('"GTC" (default), "IOC", "FOK" — only for LIMIT'),
        client_order_id: z
          .string()
          .optional()
          .describe(
            "idempotency key (newClientOrderId). Re-sending with the same key will NOT duplicate the order — the existing entry is looked up first",
          ),
        wait_for_fill: z
          .boolean()
          .default(true)
          .describe(
            "wait until the entry fills before arming SL/TP (recommended). false returns immediately with ENTRY_PENDING — you must arm SL/TP yourself once filled",
          ),
        entry_fill_timeout_s: z
          .number()
          .optional()
          .describe("max seconds to wait for a LIMIT fill before the remainder is cancelled (default 30)"),
        close_on_sl_failure: z
          .boolean()
          .default(true)
          .describe(
            "fail-safe: if the SL algo order cannot be placed after retries, market-close the position instead of leaving it unprotected",
          ),
      },
    },
    async (args) =>
      safe("place_futures_order", async () => {
        const { symbol, side } = args;
        const leverage = args.leverage;
        if (leverage > MAX_LEVERAGE) {
          return { error: `Max leverage is ${MAX_LEVERAGE}. Risk rule enforced.` };
        }
        if (side !== "LONG" && side !== "SHORT") {
          return { error: "side must be LONG or SHORT" };
        }

        const typeUpper = args.order_type.toUpperCase();
        if (typeUpper !== "MARKET" && typeUpper !== "LIMIT") {
          return { error: "order_type must be MARKET or LIMIT" };
        }

        const client = getClient();
        let price = args.price;
        let autoPriced = false;
        if (typeUpper === "LIMIT" && price === undefined) {
          const book = await client.getBookTicker(symbol);
          price = side === "LONG" ? num(book.bidPrice) : num(book.askPrice);
          autoPriced = true;
          if (price <= 0) {
            return { error: `Order book returned no usable price for ${symbol}` };
          }
        }

        const [account, allPositions, markRaw, exchangeInfo] = await Promise.all([
          client.getAccount(),
          client.getPositionRisk(),
          client.getMarkPrice(symbol),
          client.getExchangeInfo(),
        ]);
        const mark = oneMark(markRaw);

        const openPositions = allPositions.filter((p) => num(p.positionAmt) !== 0);
        const fundingRate = num(mark.lastFundingRate);
        const fundingCountdownMs = intOf(mark.nextFundingTime);
        const fundingCountdownS = Math.max(
          0,
          Math.floor((fundingCountdownMs - Date.now()) / 1000),
        );
        const markPrice = num(mark.markPrice);
        const freeBalance = num(account.availableBalance);

        const precision = getSymbolPrecision(exchangeInfo, symbol);

        let entryPrice: number;
        if (typeUpper === "LIMIT") {
          entryPrice = roundTickPrice(
            price ?? 0,
            precision.price_tick,
            precision.price_precision,
          );
          if (entryPrice <= 0) return { error: "Limit price must be > 0" };
          if (
            (side === "LONG" && entryPrice > markPrice) ||
            (side === "SHORT" && entryPrice < markPrice)
          ) {
            log.warn(`${symbol} LIMIT ${side} crosses the book — may fill as TAKER, not maker`);
          }
        } else {
          entryPrice = markPrice;
        }

        let slPrice = args.sl_price;
        let tpPrice = args.tp_price;
        if (slPrice === undefined || tpPrice === undefined) {
          const klines = await client.getKlines(symbol, "4h", 200);
          const analysis = analyzeSymbol(klines);
          const slTp = calculateSlTp(entryPrice, side, analysis.atr ?? 0, RISK_REWARD);
          if (slPrice === undefined) slPrice = slTp.sl ?? undefined;
          if (tpPrice === undefined) tpPrice = slTp.tp ?? undefined;
        }
        if (slPrice === undefined || tpPrice === undefined) {
          return {
            error:
              "SL/TP could not be determined (ATR unavailable?) — pass sl_price/tp_price explicitly",
          };
        }

        try {
          checkPreTrade({
            account: account as unknown as Record<string, unknown>,
            positions: openPositions as unknown as Array<Record<string, unknown>>,
            fundingRate,
            fundingCountdownSeconds: fundingCountdownS,
            confidence: 70,
          });
        } catch (error) {
          if (error instanceof RiskError) {
            return { error: `Risk rule blocked: ${error.message}`, blocked: true };
          }
          throw error;
        }

        let sizingNote: string | undefined;
        let orderQty: number;
        if (args.notional_usdt !== undefined && args.notional_usdt > 0) {
          if (args.use_auto_sizing) {
            sizingNote = "notional_usdt took precedence over use_auto_sizing";
            log.warn(`${symbol}: notional_usdt provided with use_auto_sizing=true — sizing by notional`);
          }
          orderQty = roundStepQty(
            args.notional_usdt / entryPrice,
            precision.qty_step,
            precision.qty_precision,
          );
        } else if (args.use_auto_sizing) {
          const sizing = calculatePositionSize(
            freeBalance,
            entryPrice,
            slPrice,
            leverage,
            precision.qty_step,
          );
          orderQty = roundStepQty(sizing.qty, precision.qty_step, precision.qty_precision);
        } else {
          if (args.qty === undefined) {
            return { error: "qty or notional_usdt required when use_auto_sizing=False" };
          }
          orderQty = roundStepQty(args.qty, precision.qty_step, precision.qty_precision);
        }

        if (orderQty < precision.min_qty) {
          return {
            error: `Calculated qty ${orderQty} is below symbol min_qty ${precision.min_qty} (stepSize=${precision.qty_step})`,
          };
        }
        if (orderQty * entryPrice < precision.min_notional) {
          return {
            error: `Order notional $${(orderQty * entryPrice).toFixed(2)} is below symbol min_notional $${precision.min_notional.toFixed(2)}`,
          };
        }

        const orderSide = side === "LONG" ? "BUY" : "SELL";
        const slSide = side === "LONG" ? "SELL" : "BUY";
        const tpSide = side === "LONG" ? "SELL" : "BUY";
        const slPriceR = roundTickPrice(
          slPrice,
          precision.price_tick,
          precision.price_precision,
        );
        const tpPriceR = roundTickPrice(
          tpPrice,
          precision.price_tick,
          precision.price_precision,
        );

        // Geometry guard: SL must sit on the losing side of entry, TP on the
        // winning side. Reject early instead of letting Binance reject the
        // algo order *after* the entry order is already live (which would
        // leave the position unprotected).
        if (side === "LONG") {
          if (!(slPriceR < entryPrice && entryPrice < tpPriceR)) {
            return {
              error:
                `Invalid SL/TP geometry for ${symbol} (LONG): need SL(${slPriceR}) < entry(${entryPrice}) < TP(${tpPriceR})`,
            };
          }
        } else {
          if (!(tpPriceR < entryPrice && entryPrice < slPriceR)) {
            return {
              error:
                `Invalid SL/TP geometry for ${symbol} (SHORT): need TP(${tpPriceR}) < entry(${entryPrice}) < SL(${slPriceR})`,
            };
          }
        }

        // Drift guard: the caller sized against a reference price. If the book
        // has moved beyond tolerance, the approved sizing no longer describes
        // this order — reject BEFORE any POST.
        if (args.reference_price !== undefined && args.reference_price > 0) {
          const tolerance = Math.max(0, args.price_tolerance_pct ?? 0.5) / 100;
          const drift = Math.abs(entryPrice - args.reference_price) / args.reference_price;
          if (drift > tolerance) {
            return {
              error: `Entry drifted ${(drift * 100).toFixed(2)}% from reference $${args.reference_price} (tolerance ${((tolerance) * 100).toFixed(2)}%) — re-analyze before ordering`,
              blocked: true,
            };
          }
        }

        // Final risk guard on the qty that will actually be POSTed, using the
        // real entry price and both taker fees. This is the last line of
        // defence so the approved sizing matches the placed order.
        if (args.max_risk_usdt !== undefined && args.max_risk_usdt > 0) {
          const stopDistanceFinal = Math.abs(entryPrice - slPriceR) / entryPrice;
          const finalRisk = orderQty * entryPrice * stopDistanceFinal * (1 + 2 * 0.0005);
          if (finalRisk > args.max_risk_usdt + 1e-6) {
            return {
              error: `Final stop risk $${finalRisk.toFixed(2)} exceeds cap $${args.max_risk_usdt.toFixed(2)} (qty=${orderQty}, entry=${entryPrice}, SL=${slPriceR})`,
              blocked: true,
            };
          }
        }

        log.info(
          `Placing ${side} ${symbol}: ${typeUpper} qty=${orderQty} @ ${entryPrice} SL=${slPriceR} TP=${tpPriceR} ${leverage}x`,
        );

        // ── Idempotency: never POST twice with the same client_order_id ──
        const clientOrderId = sanitizeClientOrderId(args.client_order_id);
        if (clientOrderId) {
          const existing = await lookupFuturesOrder(client, symbol, {
            origClientOrderId: clientOrderId,
          });
          const existingStatus = normalizeOrderStatus(existing);
          if (existing && (ACTIVE_STATUSES.has(existingStatus) || existingStatus === "FILLED")) {
            const posList0 = await client.getPositionRisk(symbol);
            const posAmt0 = num(posList0.find((p) => p.symbol === symbol)?.positionAmt);
            return {
              status: "DUPLICATE_SUPPRESSED",
              duplicate: true,
              client_order_id: clientOrderId,
              existing_entry: existing,
              existing_entry_status: existingStatus,
              open_position_qty: posAmt0,
              note:
                posAmt0 !== 0
                  ? "Entry already exists (or has filled). If SL/TP are not armed yet, set them via set_position_stop_loss / set_position_take_profit."
                  : "An active order with this client_order_id already exists — nothing was re-sent.",
            };
          }
          if (existing) {
            log.info(
              `${symbol}: client_order_id ${clientOrderId} previously used (${existingStatus}) — placing fresh order`,
            );
          }
        }

        log.info(
          `Placing ${side} ${symbol}: ${typeUpper} qty=${orderQty} @ ${entryPrice} SL=${slPriceR} TP=${tpPriceR} ${leverage}x`,
        );

        const results: Record<string, unknown> = {};

        try {
          await client.changeLeverage(symbol, leverage);
        } catch (error) {
          if (error instanceof BinanceAPIError) log.warn(`Leverage skip: ${error.message}`);
          else throw error;
        }
        try {
          await client.changeMarginType(symbol, args.margin_type);
        } catch (error) {
          if (error instanceof BinanceAPIError) log.warn(`Margin type skip: ${error.message}`);
          else throw error;
        }

        // ── Entry POST, with outcome recovery via client_order_id lookup ──
        const entryParams: Record<string, string | number | boolean> = {
          symbol,
          side: orderSide,
          type: typeUpper,
          quantity: orderQty,
          reduceOnly: false,
        };
        if (typeUpper === "LIMIT") {
          entryParams.price = entryPrice;
          entryParams.timeInForce = args.time_in_force.toUpperCase();
        }
        if (clientOrderId) entryParams.newClientOrderId = clientOrderId;

        let entryOrder: Record<string, unknown> | null = null;
        try {
          entryOrder = (await client.placeOrder(entryParams)) as Record<string, unknown>;
        } catch (error) {
          const submitError = error instanceof Error ? error.message : String(error);
          log.error(`Entry POST failed ${symbol}: ${submitError}`);
          if (clientOrderId) {
            // The POST outcome is unknown (timeout/network). Look the order up
            // instead of blindly re-sending — that is what prevents doubles.
            const known = await lookupFuturesOrder(client, symbol, {
              origClientOrderId: clientOrderId,
            });
            if (known) {
              entryOrder = known;
              results.outcome_note =
                "Entry response was lost, but the order was recovered via client_order_id lookup — it was NOT re-sent.";
            }
          }
          if (!entryOrder) {
            return {
              error: `Entry order failed: ${submitError}`,
              post_outcome: "NOT_PLACED_OR_UNKNOWN",
              client_order_id: clientOrderId ?? null,
              note: "No entry was confirmed. If you retry, reuse the same client_order_id (it is checked against open/filled orders first).",
            };
          }
        }
        results.entry = entryOrder;

        // ── Wait for the entry to reach a terminal state, then reconcile ──
        const orderId = intOf(entryOrder.orderId);
        const canTrack = orderId > 0;
        const isMarket = typeUpper === "MARKET";
        const waitFill = args.wait_for_fill !== false;
        const status0 = normalizeOrderStatus(entryOrder);

        if (waitFill && canTrack && !isTerminalOrderStatus(status0)) {
          const waitS = isMarket
            ? config.marketFillWaitS
            : (args.entry_fill_timeout_s ?? config.entryFillTimeoutS);
          const finalOrder = await waitForTerminalStatus(
            client,
            symbol,
            orderId,
            Date.now() + waitS * 1000,
          );
          if (finalOrder) entryOrder = finalOrder;
          results.entry = entryOrder;
        }
        const entryStatus = normalizeOrderStatus(entryOrder);

        let posAmt = num(
          (await client.getPositionRisk(symbol)).find((p) => p.symbol === symbol)?.positionAmt,
        );

        if (posAmt === 0) {
          if (isFilledStatus(entryStatus)) {
            results.status = "POSITION_FLAT_AFTER_FILL";
            results.error =
              "Entry reported FILLED but no position exists — it may have been closed by another process. Verify manually before re-ordering.";
            return results;
          }
          if (isTerminalOrderStatus(entryStatus) && entryStatus !== "FILLED") {
            results.status = "ENTRY_REJECTED";
            results.error = `Entry order did not fill: ${entryStatus}`;
            return results;
          }
          if (!waitFill) {
            results.status = "ENTRY_PENDING_PROTECTION_DEFERRED";
            results.note =
              "wait_for_fill=false: entry is on the book but NOT protected. Poll get_open_positions, then arm SL (first!) and TP via set_position_stop_loss / set_position_take_profit.";
            return results;
          }
          // Still open at the deadline → cancel the remainder. A fill may race
          // the cancel, so re-check the position afterwards instead of trusting
          // the cancel result.
          if (canTrack) {
            try {
              await client.cancelOrder(symbol, orderId);
            } catch (error) {
              log.warn(
                `Cancel on timeout failed ${symbol} #${orderId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            await sleep(500);
            posAmt = num(
              (await client.getPositionRisk(symbol)).find((p) => p.symbol === symbol)?.positionAmt,
            );
          }
          if (posAmt === 0) {
            results.status = "ENTRY_CANCELLED_NOT_FILLED";
            results.note =
              "LIMIT entry did not fill within the timeout; the remainder was cancelled. No position, no SL/TP placed.";
            return results;
          }
          results.entry_cancel_note =
            "Entry (partially) filled while/just before the timeout cancel — protecting the actual open position.";
        }

        // ── Protection: SL FIRST, then TP. closePosition:true covers partial fills. ──
        const protectQty = Math.abs(posAmt);
        const actualEntry = num(entryOrder.avgPrice) || entryPrice;
        if (actualEntry !== entryPrice) {
          results.entry_price_note = `Fill price ${actualEntry} differs from planned ${entryPrice}`;
        }
        if ((side === "LONG" && actualEntry <= slPriceR) || (side === "SHORT" && actualEntry >= slPriceR)) {
          results.slippage_warning =
            `Filled at ${actualEntry}, at/beyond the planned SL ${slPriceR} — the SL algo may trigger immediately or be rejected.`;
        }

        const protect = { closePosition: true };
        let slResult: Record<string, unknown> | null = null;
        let slError: string | null = null;
        for (let attempt = 0; attempt < 2 && !slResult; attempt++) {
          try {
            slResult = (await client.placeAlgoOrder({
              symbol,
              side: slSide,
              type: "STOP_MARKET",
              algoType: "CONDITIONAL",
              triggerPrice: slPriceR,
              positionSide: "BOTH",
              workingType: "CONTRACT_PRICE",
              ...protect,
            })) as Record<string, unknown>;
          } catch (error) {
            slError = error instanceof Error ? error.message : String(error);
            log.error(`SL failed ${symbol} (attempt ${attempt + 1}): ${slError}`);
            if (attempt === 0) await sleep(500);
          }
        }
        if (slResult) results.stop_loss = slResult;
        else results.stop_loss_error = slError;

        if (!slResult) {
          // Fail-safe: a naked position is the worst outcome, never leave one.
          if (args.close_on_sl_failure !== false) {
            try {
              results.emergency_close = await client.placeOrder({
                symbol,
                side: posAmt > 0 ? "SELL" : "BUY",
                type: "MARKET",
                quantity: protectQty,
                reduceOnly: true,
              });
              results.status = "PROTECTION_FAILED_POSITION_CLOSED";
              results.error = `SL could not be placed (${slError}); the position was market-closed as fail-safe.`;
            } catch (error) {
              const closeError = error instanceof Error ? error.message : String(error);
              results.status = "PROTECTION_FAILED_CLOSE_FAILED";
              results.error = `SL failed (${slError}) AND emergency close failed (${closeError}). POSITION IS UNPROTECTED.`;
              results.action_required = "CLOSE_OR_PROTECT_POSITION_NOW";
            }
          } else {
            results.status = "PROTECTION_FAILED_POSITION_OPEN";
            results.error = `SL could not be placed (${slError}); position left open (close_on_sl_failure=false).`;
            results.action_required = "SET_SL_MANUALLY_NOW";
          }
          return results;
        }

        let tpResult: Record<string, unknown> | null = null;
        let tpError: string | null = null;
        for (let attempt = 0; attempt < 2 && !tpResult; attempt++) {
          try {
            tpResult = (await client.placeAlgoOrder({
              symbol,
              side: tpSide,
              type: "TAKE_PROFIT_MARKET",
              algoType: "CONDITIONAL",
              triggerPrice: tpPriceR,
              positionSide: "BOTH",
              workingType: "CONTRACT_PRICE",
              ...protect,
            })) as Record<string, unknown>;
          } catch (error) {
            tpError = error instanceof Error ? error.message : String(error);
            log.error(`TP failed ${symbol} (attempt ${attempt + 1}): ${tpError}`);
            if (attempt === 0) await sleep(500);
          }
        }
        if (tpResult) results.take_profit = tpResult;
        else {
          results.take_profit_error = tpError;
          results.status = "FILLED_SL_ONLY_TP_FAILED";
          results.error = `TP could not be placed (${tpError}). SL is armed; the position runs without TP.`;
          results.action_required = "SET_TP_MANUALLY";
        }
        if (!results.status) results.status = "FILLED_PROTECTED";

        results.summary = {
          symbol,
          side,
          qty: protectQty,
          order_qty: orderQty,
          order_type: typeUpper,
          entry_price: actualEntry,
          planned_entry_price: entryPrice,
          auto_priced: autoPriced,
          entry_price_approx: markPrice,
          sl: slPriceR,
          tp: tpPriceR,
          leverage,
          risk_usdt: roundTo(computeFinalRiskUsd(protectQty, actualEntry, slPriceR), 2),
          ...(sizingNote ? { sizing_note: sizingNote } : {}),
          ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
        };
        return results;
      }),
  );

  server.registerTool(
    "close_position",
    {
      description:
        "Market-close an open position and cancel its pending standard & algo SL/TP orders.",
      inputSchema: {
        symbol: z.string().describe('e.g. "BTCUSDT"'),
      },
    },
    async ({ symbol }) =>
      safe("close_position", async () => {
        const client = getClient();

        let cancelled: unknown;
        try {
          cancelled = await client.cancelAllOrders(symbol);
        } catch (error) {
          cancelled = { error: error instanceof Error ? error.message : String(error) };
        }

        const cancelledAlgos: number[] = [];
        try {
          const openAlgos = await client.getOpenAlgoOrders(symbol);
          for (const algo of openAlgos) {
            try {
              await client.cancelAlgoOrder(symbol, algo.algoId);
              cancelledAlgos.push(algo.algoId);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              log.warn(`Failed to cancel algo ${algo.algoId} on close: ${message}`);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`Could not list open algos on close: ${message}`);
        }

        const closeResult = await client.closePosition(symbol);
        return {
          symbol,
          close_result: closeResult,
          cancelled_orders: cancelled,
          cancelled_algo_orders: cancelledAlgos,
        };
      }),
  );

  server.registerTool(
    "partial_close_position",
    {
      description:
        "Close a partial amount (e.g. 50%) or specific quantity of an EXISTING open position. Uses reduceOnly=True to guarantee no reverse position is opened.",
      inputSchema: {
        symbol: z.string().describe('e.g. "SUIUSDT", "1000PEPEUSDT", "PHAUSDT"'),
        percentage: z
          .number()
          .nullable()
          .optional()
          .describe("percentage of position to close (e.g. 50.0 for 50%)"),
        qty: z.number().optional().describe("manual quantity override (used if percentage is None)"),
        order_type: z
          .string()
          .default("MARKET")
          .describe('"MARKET" (immediate execution) or "LIMIT" (at specific price)'),
        price: z.number().optional().describe('target limit price (required if order_type="LIMIT")'),
      },
    },
    async (args) =>
      safe("partial_close_position", async () => {
        const client = getClient();
        const [positions, exchangeInfo] = await Promise.all([
          client.getPositionRisk(args.symbol),
          client.getExchangeInfo(),
        ]);

        const position = findOpenPosition(positions, args.symbol);
        if (!position) return { error: `No active open position found for ${args.symbol}` };

        const posAmt = num(position.positionAmt);
        const currentSize = Math.abs(posAmt);
        const side = posAmt > 0 ? "SELL" : "BUY";

        const percentage = args.percentage === undefined ? 50 : args.percentage;
        let rawQty: number;
        if (percentage !== null) {
          if (percentage <= 0 || percentage > 100) {
            return { error: "percentage must be between 1 and 100" };
          }
          rawQty = currentSize * (percentage / 100);
        } else if (args.qty !== undefined) {
          rawQty = args.qty;
        } else {
          return { error: "Must provide either percentage or qty" };
        }

        const precision = getSymbolPrecision(exchangeInfo, args.symbol);
        const orderQty = roundStepQty(rawQty, precision.qty_step, precision.qty_precision);
        if (orderQty <= 0) {
          return {
            error: `Calculated close qty ${orderQty} is 0. Position size too small or precision issue.`,
          };
        }

        const orderType = args.order_type.toUpperCase();
        const orderParams: Record<string, string | number | boolean> = {
          symbol: args.symbol,
          side,
          type: orderType,
          quantity: orderQty,
          reduceOnly: true,
        };
        if (orderType === "LIMIT") {
          if (args.price === undefined) {
            return { error: "price is required when order_type is LIMIT" };
          }
          orderParams.price = roundTickPrice(
            args.price,
            precision.price_tick,
            precision.price_precision,
          );
          orderParams.timeInForce = "GTC";
        }

        log.info(
          `Partial closing ${args.symbol}: ${orderQty} (target ~${percentage}%) via ${orderType}`,
        );
        const orderResult = await client.placeOrder(orderParams);

        return {
          symbol: args.symbol,
          action: "PARTIAL_CLOSE",
          closed_qty: orderQty,
          original_size: currentSize,
          remaining_size_approx: roundTo(currentSize - orderQty, precision.qty_precision),
          percentage_target: percentage,
          side,
          order_type: args.order_type,
          order_result: orderResult,
        };
      }),
  );

  server.registerTool(
    "set_position_stop_loss",
    {
      description:
        "Set or update Stop Loss for an EXISTING open position using the Binance Futures Algo Order API.",
      inputSchema: {
        symbol: z.string().describe('e.g. "SUIUSDT", "1000PEPEUSDT", "PHAUSDT"'),
        stop_price: z.number().describe("trigger price for the stop loss"),
        cancel_existing_sl: z
          .boolean()
          .default(true)
          .describe("cancel existing STOP_MARKET algo orders first"),
      },
    },
    async (args) =>
      safe("set_position_stop_loss", async () => {
        const client = getClient();
        const [positions, exchangeInfo] = await Promise.all([
          client.getPositionRisk(args.symbol),
          client.getExchangeInfo(),
        ]);

        const position = findOpenPosition(positions, args.symbol);
        if (!position) return { error: `No active open position found for ${args.symbol}` };

        const posAmt = num(position.positionAmt);
        const posSide = String(position.positionSide ?? "BOTH");
        const slSide = posAmt > 0 ? "SELL" : "BUY";

        const cancelled: number[] = [];
        if (args.cancel_existing_sl) {
          try {
            const openAlgos = await client.getOpenAlgoOrders(args.symbol);
            for (const algo of openAlgos) {
              if (algo.orderType === "STOP_MARKET" || algo.orderType === "STOP") {
                try {
                  await client.cancelAlgoOrder(args.symbol, algo.algoId);
                  cancelled.push(algo.algoId);
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  log.warn(`Failed to cancel old SL algo ${algo.algoId}: ${message}`);
                }
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`Could not list open algos: ${message}`);
          }
        }

        const precision = getSymbolPrecision(exchangeInfo, args.symbol);
        const stopPriceR = roundTickPrice(
          args.stop_price,
          precision.price_tick,
          precision.price_precision,
        );

        const markPrice = num(position.markPrice);
        if (markPrice > 0) {
          if (posAmt > 0 && !(stopPriceR < markPrice)) {
            return {
              error: `Invalid stop price for ${args.symbol} (LONG): stop(${stopPriceR}) must be below mark(${markPrice})`,
            };
          }
          if (posAmt < 0 && !(stopPriceR > markPrice)) {
            return {
              error: `Invalid stop price for ${args.symbol} (SHORT): stop(${stopPriceR}) must be above mark(${markPrice})`,
            };
          }
        }
        const qty = roundStepQty(
          Math.abs(posAmt),
          precision.qty_step,
          precision.qty_precision,
        );

        log.info(`Setting Algo SL for ${args.symbol} to ${stopPriceR} (side=${slSide}, qty=${qty})`);

        const orderResult = await client.placeAlgoOrder({
          symbol: args.symbol,
          side: slSide,
          type: "STOP_MARKET",
          algoType: "CONDITIONAL",
          triggerPrice: stopPriceR,
          quantity: qty,
          positionSide: posSide,
          reduceOnly: true,
          workingType: "CONTRACT_PRICE",
        });

        return {
          symbol: args.symbol,
          action: "SET_STOP_LOSS",
          new_stop_price: stopPriceR,
          quantity: qty,
          position_side: posSide,
          cancelled_previous_sl: cancelled,
          order_result: orderResult,
        };
      }),
  );

  server.registerTool(
    "set_trailing_stop",
    {
      description:
        "Place a native Binance TRAILING_STOP_MARKET algo order on an EXISTING open position.",
      inputSchema: {
        symbol: z.string().describe('e.g. "SUIUSDT", "1000PEPEUSDT", "PHAUSDT"'),
        callback_rate: z
          .number()
          .describe("percentage to trail behind peak (0.1 to 5.0, e.g. 1.0 for 1%)"),
        activation_price: z
          .number()
          .optional()
          .describe("price level that must be reached before trailing activates"),
        quantity: z.number().optional().describe("manual quantity to trail"),
        percentage: z
          .number()
          .default(100)
          .describe("percentage of current position to protect with trailing stop"),
        cancel_existing_sl: z
          .boolean()
          .default(true)
          .describe("cancel prior stop orders so stops don't conflict"),
      },
    },
    async (args) =>
      safe("set_trailing_stop", async () => {
        if (args.callback_rate < 0.1 || args.callback_rate > 5.0) {
          return { error: "callback_rate must be between 0.1% and 5.0%" };
        }

        const client = getClient();
        const [positions, exchangeInfo] = await Promise.all([
          client.getPositionRisk(args.symbol),
          client.getExchangeInfo(),
        ]);

        const position = findOpenPosition(positions, args.symbol);
        if (!position) return { error: `No active open position found for ${args.symbol}` };

        const posAmt = num(position.positionAmt);
        const posSide = String(position.positionSide ?? "BOTH");
        const currentSize = Math.abs(posAmt);
        const side = posAmt > 0 ? "SELL" : "BUY";

        const precision = getSymbolPrecision(exchangeInfo, args.symbol);
        const rawQty =
          args.quantity !== undefined ? args.quantity : currentSize * (args.percentage / 100);
        const orderQty = roundStepQty(rawQty, precision.qty_step, precision.qty_precision);
        if (orderQty <= 0) {
          return { error: "Calculated trailing stop qty is 0. Check size." };
        }

        const cancelled: number[] = [];
        if (args.cancel_existing_sl) {
          try {
            const openAlgos = await client.getOpenAlgoOrders(args.symbol);
            for (const algo of openAlgos) {
              if (
                algo.orderType === "STOP_MARKET" ||
                algo.orderType === "STOP" ||
                algo.orderType === "TRAILING_STOP_MARKET"
              ) {
                try {
                  await client.cancelAlgoOrder(args.symbol, algo.algoId);
                  cancelled.push(algo.algoId);
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  log.warn(`Failed to cancel old stop algo ${algo.algoId}: ${message}`);
                }
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`Could not list open algos: ${message}`);
          }
        }

        const params: Record<string, string | number | boolean> = {
          symbol: args.symbol,
          side,
          type: "TRAILING_STOP_MARKET",
          algoType: "CONDITIONAL",
          quantity: orderQty,
          callbackRate: roundTo(args.callback_rate, 1),
          positionSide: posSide,
          reduceOnly: true,
          workingType: "CONTRACT_PRICE",
        };
        if (args.activation_price !== undefined) {
          params.activationPrice = roundTickPrice(
            args.activation_price,
            precision.price_tick,
            precision.price_precision,
          );
        }

        log.info(
          `Placing Trailing Stop Algo on ${args.symbol}: qty=${orderQty}, rate=${args.callback_rate}%`,
        );
        const orderResult = await client.placeAlgoOrder(params);

        return {
          symbol: args.symbol,
          action: "SET_TRAILING_STOP",
          callback_rate: args.callback_rate,
          activation_price: args.activation_price,
          quantity: orderQty,
          position_side: posSide,
          cancelled_previous_sl: cancelled,
          order_result: orderResult,
        };
      }),
  );

  server.registerTool(
    "set_position_take_profit",
    {
      description:
        "Set a Take Profit target on an EXISTING open position (supports partial TP e.g. 50%).",
      inputSchema: {
        symbol: z.string().describe('e.g. "SUIUSDT", "1000PEPEUSDT", "PHAUSDT"'),
        tp_price: z.number().describe("target price to take profit"),
        percentage: z
          .number()
          .default(50)
          .describe("percentage of position to TP (default 50.0 for partial TP)"),
        qty: z.number().optional().describe("manual quantity override"),
        order_type: z
          .string()
          .default("TAKE_PROFIT_MARKET")
          .describe('"TAKE_PROFIT_MARKET" or "LIMIT"'),
        cancel_existing_tp: z
          .boolean()
          .default(false)
          .describe("cancel prior TP orders for this symbol first"),
      },
    },
    async (args) =>
      safe("set_position_take_profit", async () => {
        const client = getClient();
        const [positions, exchangeInfo] = await Promise.all([
          client.getPositionRisk(args.symbol),
          client.getExchangeInfo(),
        ]);

        const position = findOpenPosition(positions, args.symbol);
        if (!position) return { error: `No active open position found for ${args.symbol}` };

        const posAmt = num(position.positionAmt);
        const posSide = String(position.positionSide ?? "BOTH");
        const currentSize = Math.abs(posAmt);
        const side = posAmt > 0 ? "SELL" : "BUY";

        const precision = getSymbolPrecision(exchangeInfo, args.symbol);
        const rawQty =
          args.qty !== undefined ? args.qty : currentSize * (args.percentage / 100);
        const orderQty = roundStepQty(rawQty, precision.qty_step, precision.qty_precision);
        if (orderQty <= 0) {
          return { error: "Calculated TP qty is 0. Check size." };
        }

        const cancelled: number[] = [];
        if (args.cancel_existing_tp) {
          try {
            const openAlgos = await client.getOpenAlgoOrders(args.symbol);
            for (const algo of openAlgos) {
              if (algo.orderType === "TAKE_PROFIT_MARKET" || algo.orderType === "TAKE_PROFIT") {
                try {
                  await client.cancelAlgoOrder(args.symbol, algo.algoId);
                  cancelled.push(algo.algoId);
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  log.warn(`Failed to cancel old TP algo ${algo.algoId}: ${message}`);
                }
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`Could not list open algos: ${message}`);
          }
          // Also cancel standard LIMIT reduceOnly TP orders (placed as maker).
          try {
            const openOrders = await client.getOpenOrders(args.symbol);
            const tpSide = posAmt > 0 ? "SELL" : "BUY";
            for (const o of openOrders) {
              const oSide = String(o.side ?? "");
              const oType = String(o.type ?? "");
              const oReduceOnly = o.reduceOnly === true;
              if (
                oSide === tpSide &&
                oReduceOnly &&
                (oType === "LIMIT" || oType === "TAKE_PROFIT" || oType === "TAKE_PROFIT_MARKET")
              ) {
                try {
                  await client.cancelOrder(args.symbol, Number(o.orderId));
                  cancelled.push(Number(o.orderId));
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  log.warn(`Failed to cancel old TP order ${o.orderId}: ${message}`);
                }
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`Could not list open orders for TP cancel: ${message}`);
          }
        }

        const tpPriceR = roundTickPrice(
          args.tp_price,
          precision.price_tick,
          precision.price_precision,
        );

        let orderResult: Record<string, unknown>;
        if (args.order_type === "LIMIT") {
          orderResult = await client.placeOrder({
            symbol: args.symbol,
            side,
            type: "LIMIT",
            price: tpPriceR,
            quantity: orderQty,
            timeInForce: "GTC",
            reduceOnly: true,
          });
        } else {
          orderResult = await client.placeAlgoOrder({
            symbol: args.symbol,
            side,
            type: "TAKE_PROFIT_MARKET",
            algoType: "CONDITIONAL",
            triggerPrice: tpPriceR,
            quantity: orderQty,
            positionSide: posSide,
            reduceOnly: true,
            workingType: "CONTRACT_PRICE",
          });
        }

        return {
          symbol: args.symbol,
          action: "SET_TAKE_PROFIT",
          tp_price: tpPriceR,
          quantity: orderQty,
          percentage: args.percentage,
          order_type: args.order_type,
          cancelled_previous_tp: cancelled,
          order_result: orderResult,
        };
      }),
  );

  server.registerTool(
    "cancel_order",
    {
      description: "Cancel a specific open order by ID.",
      inputSchema: {
        symbol: z.string(),
        order_id: z.number().int(),
      },
    },
    async ({ symbol, order_id }) =>
      safe("cancel_order", async () => getClient().cancelOrder(symbol, order_id)),
  );

  server.registerTool(
    "cancel_all_orders",
    {
      description:
        "Cancel ALL open standard orders AND conditional algo orders for a symbol.",
      inputSchema: {
        symbol: z.string(),
      },
    },
    async ({ symbol }) =>
      safe("cancel_all_orders", async () => {
        const client = getClient();
        const results: Record<string, unknown> = {};

        try {
          results.standard_orders = await client.cancelAllOrders(symbol);
        } catch (error) {
          results.standard_orders_error = error instanceof Error ? error.message : String(error);
        }

        const cancelledAlgos: number[] = [];
        try {
          const openAlgos: AlgoOrder[] = await client.getOpenAlgoOrders(symbol);
          for (const algo of openAlgos) {
            try {
              await client.cancelAlgoOrder(symbol, algo.algoId);
              cancelledAlgos.push(algo.algoId);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              log.warn(`Failed to cancel algo ${algo.algoId}: ${message}`);
            }
          }
          results.cancelled_algo_orders = cancelledAlgos;
        } catch (error) {
          results.algo_orders_error = error instanceof Error ? error.message : String(error);
        }

        return { symbol, cancelled: results };
      }),
  );

  server.registerTool(
    "set_leverage",
    {
      description: `Set leverage for a symbol (max ${MAX_LEVERAGE}).`,
      inputSchema: {
        symbol: z.string(),
        leverage: z.number().int(),
      },
    },
    async ({ symbol, leverage }) =>
      safe("set_leverage", async () => {
        if (leverage > MAX_LEVERAGE) {
          return { error: `Max leverage enforced: ${MAX_LEVERAGE}` };
        }
        return getClient().changeLeverage(symbol, leverage);
      }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // MONITORING
  // ═══════════════════════════════════════════════════════════════════════

  server.registerTool(
    "monitor_positions",
    {
      description:
        "Health check all open positions. Returns status, recommended actions, and total portfolio PnL. Run this on cron.",
      inputSchema: {},
    },
    async () =>
      safe("monitor_positions", async () => {
        const client = getClient();
        const [allPositions, account] = await Promise.all([
          client.getPositionRisk(),
          client.getAccount(),
        ]);

        const openPos = allPositions.filter((p) => num(p.positionAmt) !== 0);
        if (openPos.length === 0) {
          return { open_positions: 0, message: "No open positions.", actions_required: [] };
        }

        let totalPnl = 0;
        const actionsRequired: Array<Record<string, unknown>> = [];
        const positionDetails: Array<Record<string, unknown>> = [];

        for (const p of openPos) {
          const raw = p as unknown as Record<string, unknown>;
          const formatted = fmtPos(raw);
          const health = checkPositionHealth(raw);
          positionDetails.push({ ...formatted, ...health });
          totalPnl += num(formatted.unrealized_pnl);
          if (health.action !== "HOLD") {
            actionsRequired.push({
              symbol: formatted.symbol,
              action: health.action,
              reason: health.reason,
              unrealized_pnl: formatted.unrealized_pnl,
            });
          }
        }

        return {
          open_positions: openPos.length,
          total_unrealized_pnl: roundTo(totalPnl, 4),
          available_balance: num(account.availableBalance),
          actions_required: actionsRequired,
          positions: positionDetails,
        };
      }),
  );

  server.registerTool(
    "get_trade_history",
    {
      description: "Get recent realized income (trades, funding, commissions).",
      inputSchema: {
        limit: z.number().int().default(20).describe("number of records (max 1000)"),
      },
    },
    async ({ limit }) =>
      safe("get_trade_history", async () => getClient().getIncomeHistory(limit)),
  );

  return server;
}

export type { SymbolAnalysis, BinanceKline };
