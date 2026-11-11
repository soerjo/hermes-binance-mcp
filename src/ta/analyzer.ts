/**
 * Symbol analysis — a faithful port of the Python `analysis.py` module.
 *
 * The output object keeps the exact same keys and rounding as before, because
 * Hermes Agent and the crypto-trading-engine parse it positionally by name.
 */

import type { BinanceKline } from "../binance/types";
import {
  adx,
  atr,
  bollinger,
  ema,
  last,
  macd,
  rsi,
  smaLast,
  toFloat,
} from "./indicators";

export const MIN_CANDLES = 60;

/** Python-compatible `round(value, digits)`. */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const text = value.toFixed(Math.min(Math.max(digits, 0), 100));
  return Number(text);
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  openTime: number;
}

export interface CandleAction {
  prev_lower_wick_pct: number;
  prev_upper_wick_pct: number;
  bullish_rejection: boolean;
  bearish_rejection: boolean;
  falling_knife: boolean;
  rocket_chasing: boolean;
}

export interface SymbolAnalysis {
  signal: "LONG" | "SHORT" | "SKIP";
  confidence: number;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  price?: number;
  rsi?: { value: number; trend: "OVERSOLD" | "OVERBOUGHT" | "NEUTRAL" };
  macd?: { macd: number; signal: number; histogram: number; cross: MacdCross };
  ema?: {
    ema20: number;
    ema50: number;
    ema200: number;
    price_vs_ema20: PricePosition;
    price_vs_ema50: PricePosition;
    price_vs_ema200: PricePosition;
  };
  bollinger?: {
    upper: number;
    mid: number;
    lower: number;
    pct_b: number;
    bandwidth: number;
  };
  atr?: number;
  adx?: number;
  candle_action?: CandleAction;
  volume?: { current: number; avg_20: number; ratio: number };
  reason?: string;
}

export type MacdCross =
  | "BULLISH_CROSS"
  | "BEARISH_CROSS"
  | "BULLISH_MOMENTUM"
  | "BEARISH_MOMENTUM";

export type PricePosition = "ABOVE" | "BELOW" | "AT";

/** Parse raw Binance klines, dropping bars with a non-numeric close. */
export function parseKlines(klines: BinanceKline[]): Candle[] {
  const candles: Candle[] = [];
  for (const row of klines) {
    const close = Number(row[4]);
    if (!Number.isFinite(close)) continue;
    candles.push({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close,
      volume: Number(row[5]),
      quoteVolume: Number(row[7]),
    });
  }
  return candles;
}

function pricePosition(price: number, value: number): PricePosition {
  const diff = ((price - value) / value) * 100;
  if (diff > 0.1) return "ABOVE";
  if (diff < -0.1) return "BELOW";
  return "AT";
}

export function analyzeSymbol(klines: BinanceKline[]): SymbolAnalysis {
  if (!Array.isArray(klines) || klines.length < MIN_CANDLES) {
    return {
      signal: "SKIP",
      confidence: 0,
      trend: "NEUTRAL",
      reason: `Need ${MIN_CANDLES}+ candles, got ${Array.isArray(klines) ? klines.length : 0}`,
    };
  }

  const candles = parseKlines(klines);
  if (candles.length < MIN_CANDLES) {
    return {
      signal: "SKIP",
      confidence: 0,
      trend: "NEUTRAL",
      reason: `Need ${MIN_CANDLES}+ candles, got ${candles.length}`,
    };
  }

  const close = toFloat(candles.map((c) => c.close));
  const high = toFloat(candles.map((c) => c.high));
  const low = toFloat(candles.map((c) => c.low));
  const volume = toFloat(candles.map((c) => c.volume));
  const price = close[close.length - 1];

  // ── RSI(14) ──────────────────────────────────────────────────────────────
  const rsiValue = rsi(close, 14);
  const rsiTrend =
    rsiValue < 30 ? "OVERSOLD" : rsiValue > 70 ? "OVERBOUGHT" : "NEUTRAL";

  // ── MACD(12,26,9) ────────────────────────────────────────────────────────
  const macdResult = macd(close, 12, 26, 9);
  let macdCross: MacdCross;
  if (macdResult.prevHistogram < 0 && macdResult.histogram > 0) {
    macdCross = "BULLISH_CROSS";
  } else if (macdResult.prevHistogram > 0 && macdResult.histogram < 0) {
    macdCross = "BEARISH_CROSS";
  } else if (macdResult.histogram > 0) {
    macdCross = "BULLISH_MOMENTUM";
  } else {
    macdCross = "BEARISH_MOMENTUM";
  }

  // ── EMA 20/50/200 ────────────────────────────────────────────────────────
  const ema20 = last(ema(close, 20));
  const ema50 = last(ema(close, 50));
  const ema200 = last(ema(close, close.length >= 200 ? 200 : close.length));

  // ── Bollinger Bands(20, 2) ───────────────────────────────────────────────
  const bb = bollinger(close, 20, 2);

  // ── ATR(14) & ADX(14) ────────────────────────────────────────────────────
  const atrValue = atr(high, low, close, 14);
  let adxValue = adx(high, low, close, 14);
  if (!Number.isFinite(adxValue)) adxValue = 20.0;

  // ── Price action (last two candles) ──────────────────────────────────────
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  const pRange = Math.max(prev.high - prev.low, 1e-10);
  const pLowerWick = (Math.min(prev.open, prev.close) - prev.low) / pRange;
  const pUpperWick = (prev.high - Math.max(prev.open, prev.close)) / pRange;
  const cIsBullish = curr.close >= curr.open;
  const cIsBearish = curr.close <= curr.open;

  const fallingKnife =
    prev.close < prev.open && pLowerWick < 0.15 && curr.close < prev.low;
  const rocketChasing =
    prev.close > prev.open && pUpperWick < 0.15 && curr.close > prev.high;
  const bullishRejection =
    !fallingKnife &&
    (pLowerWick >= 0.35 ||
      (prev.close > prev.open && curr.close >= prev.close) ||
      (cIsBullish && curr.close > prev.close));
  const bearishRejection =
    !rocketChasing &&
    (pUpperWick >= 0.35 ||
      (prev.close < prev.open && curr.close <= prev.close) ||
      (cIsBearish && curr.close < prev.close));

  // ── Volume ───────────────────────────────────────────────────────────────
  const volNow = volume[volume.length - 1];
  const volAvg = smaLast(volume, 20);
  const volRatio = volAvg > 0 ? volNow / volAvg : 1.0;

  // ── Trend bias ───────────────────────────────────────────────────────────
  let trend: SymbolAnalysis["trend"];
  if (ema20 > ema50 && ema50 > ema200 && price > ema20) {
    trend = "BULLISH";
  } else if (ema20 < ema50 && ema50 < ema200 && price < ema20) {
    trend = "BEARISH";
  } else {
    trend = "NEUTRAL";
  }

  const { signal, confidence } = deriveSignal({
    trend,
    rsiValue,
    rsiTrend,
    macdCross,
    bbPctB: bb.pctB,
    volRatio,
  });

  return {
    signal,
    confidence,
    trend,
    price: roundTo(price, 6),
    rsi: { value: roundTo(rsiValue, 2), trend: rsiTrend },
    macd: {
      macd: roundTo(macdResult.macd, 6),
      signal: roundTo(macdResult.signal, 6),
      histogram: roundTo(macdResult.histogram, 6),
      cross: macdCross,
    },
    ema: {
      ema20: roundTo(ema20, 6),
      ema50: roundTo(ema50, 6),
      ema200: roundTo(ema200, 6),
      price_vs_ema20: pricePosition(price, ema20),
      price_vs_ema50: pricePosition(price, ema50),
      price_vs_ema200: pricePosition(price, ema200),
    },
    bollinger: {
      upper: roundTo(bb.upper, 6),
      mid: roundTo(bb.mid, 6),
      lower: roundTo(bb.lower, 6),
      pct_b: roundTo(bb.pctB, 4),
      bandwidth: bb.mid ? roundTo((bb.width / bb.mid) * 100, 4) : 0,
    },
    atr: roundTo(atrValue, 6),
    adx: roundTo(adxValue, 2),
    candle_action: {
      prev_lower_wick_pct: roundTo(pLowerWick, 4),
      prev_upper_wick_pct: roundTo(pUpperWick, 4),
      bullish_rejection: bullishRejection,
      bearish_rejection: bearishRejection,
      falling_knife: fallingKnife,
      rocket_chasing: rocketChasing,
    },
    volume: {
      current: roundTo(volNow, 2),
      avg_20: roundTo(volAvg, 2),
      ratio: roundTo(volRatio, 3),
    },
  };
}

interface DeriveInput {
  trend: SymbolAnalysis["trend"];
  rsiValue: number;
  rsiTrend: "OVERSOLD" | "OVERBOUGHT" | "NEUTRAL";
  macdCross: MacdCross;
  bbPctB: number;
  volRatio: number;
}

/** Weighted scoring: max 100 pts → LONG/SHORT/SKIP. */
export function deriveSignal(input: DeriveInput): {
  signal: "LONG" | "SHORT" | "SKIP";
  confidence: number;
} {
  let longScore = 0;
  let shortScore = 0;

  // Trend (40 pts)
  if (input.trend === "BULLISH") longScore += 40;
  else if (input.trend === "BEARISH") shortScore += 40;
  else {
    longScore += 10;
    shortScore += 10;
  }

  // RSI (20 pts)
  if (input.rsiTrend === "OVERSOLD") longScore += 20;
  else if (input.rsiTrend === "OVERBOUGHT") shortScore += 20;
  else if (input.rsiValue >= 45 && input.rsiValue <= 55) {
    longScore += 5;
    shortScore += 5;
  } else if (input.rsiValue > 55) longScore += 10;
  else shortScore += 10;

  // MACD (20 pts)
  if (input.macdCross === "BULLISH_CROSS") longScore += 20;
  else if (input.macdCross === "BEARISH_CROSS") shortScore += 20;
  else if (input.macdCross === "BULLISH_MOMENTUM") longScore += 10;
  else if (input.macdCross === "BEARISH_MOMENTUM") shortScore += 10;

  // Bollinger %B (10 pts)
  if (input.bbPctB < 0.1) longScore += 10;
  else if (input.bbPctB > 0.9) shortScore += 10;
  else if (input.bbPctB >= 0.4 && input.bbPctB <= 0.6) {
    longScore += 3;
    shortScore += 3;
  }

  // Volume (10 pts)
  if (input.volRatio > 2.0) {
    if (longScore >= shortScore) longScore += 5;
    else shortScore += 5;
  } else if (input.volRatio > 1.3) {
    if (longScore >= shortScore) longScore += 3;
    else shortScore += 3;
  }

  const net = longScore - shortScore;
  if (net >= 50) return { signal: "LONG", confidence: Math.min(longScore, 100) };
  if (net <= -50) return { signal: "SHORT", confidence: Math.min(shortScore, 100) };
  if (net > 0) {
    const conf = Math.min(longScore, 100);
    return { signal: conf >= 50 ? "LONG" : "SKIP", confidence: conf };
  }
  if (net < 0) {
    const conf = Math.min(shortScore, 100);
    return { signal: conf >= 50 ? "SHORT" : "SKIP", confidence: conf };
  }
  return { signal: "SKIP", confidence: 0 };
}

export interface SlTpResult {
  sl: number | null;
  tp: number | null;
  sl_distance_abs?: number;
  tp_distance_abs?: number;
  sl_distance_pct: number;
  tp_distance_pct: number;
  risk_reward?: number;
}

/** SL = entry ∓ 2*ATR, TP = entry ± 2*ATR*riskReward. */
export function calculateSlTp(
  entryPrice: number,
  side: string,
  atrValue: number,
  riskReward = 2.0,
): SlTpResult {
  const normalizedSide = ["LONG", "SHORT", "SKIP"].includes(side) ? side : "LONG";
  if (normalizedSide === "SKIP" || atrValue === 0) {
    return { sl: null, tp: null, sl_distance_pct: 0, tp_distance_pct: 0 };
  }

  const slDist = 2.0 * atrValue;
  const tpDist = slDist * riskReward;

  let sl: number;
  let tp: number;
  if (normalizedSide === "LONG") {
    sl = entryPrice - slDist;
    tp = entryPrice + tpDist;
  } else {
    sl = entryPrice + slDist;
    tp = entryPrice - tpDist;
  }

  return {
    sl: roundTo(sl, 8),
    tp: roundTo(tp, 8),
    sl_distance_abs: roundTo(slDist, 8),
    tp_distance_abs: roundTo(tpDist, 8),
    sl_distance_pct: roundTo((slDist / entryPrice) * 100, 4),
    tp_distance_pct: roundTo((tpDist / entryPrice) * 100, 4),
    risk_reward: riskReward,
  };
}

/** Score 0-100 for ranking symbols. Higher = better opportunity. */
export function scoreOpportunity(analysis: SymbolAnalysis, fundingRate: number): number {
  if (analysis.signal === "SKIP") return 0;

  let score = analysis.confidence ?? 0;
  const rsiTrend = analysis.rsi?.trend;
  const cross = analysis.macd?.cross ?? "";
  const signal = analysis.signal;

  // RSI alignment bonus (+10)
  if (signal === "LONG" && rsiTrend === "OVERSOLD") score += 10;
  else if (signal === "SHORT" && rsiTrend === "OVERBOUGHT") score += 10;

  // MACD fresh cross bonus (+15)
  if (signal === "LONG" && cross === "BULLISH_CROSS") score += 15;
  else if (signal === "SHORT" && cross === "BEARISH_CROSS") score += 15;
  else if (signal === "LONG" && cross === "BULLISH_MOMENTUM") score += 5;
  else if (signal === "SHORT" && cross === "BEARISH_MOMENTUM") score += 5;

  // Volume bonus (+5)
  const volRatio = analysis.volume?.ratio ?? 1.0;
  if (volRatio > 2.0) score += 5;
  else if (volRatio < 0.5) score -= 5;

  // Funding rate penalty
  const absRate = Math.abs(fundingRate);
  if (absRate >= 0.001) {
    const isPaying =
      (signal === "LONG" && fundingRate > 0) ||
      (signal === "SHORT" && fundingRate < 0);
    score -= isPaying ? 30 : 10;
  } else if (absRate >= 0.0005) {
    score -= 5;
  }

  return Math.max(0, Math.min(100, score));
}
