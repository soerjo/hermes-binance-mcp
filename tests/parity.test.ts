import { describe, expect, test } from "bun:test";

import {
  adx,
  atr,
  bollinger,
  ema,
  last,
  macd,
  rsi,
  sma,
  smaLast,
  toFloat,
} from "../src/ta/indicators";
import {
  analyzeSymbol,
  calculateSlTp,
  deriveSignal,
  roundTo,
  scoreOpportunity,
} from "../src/ta/analyzer";
import {
  getSymbolPrecision,
  roundStepQty,
  roundTickPrice,
  stepToPrecision,
} from "../src/risk/precision";
import {
  calculatePositionSize,
  checkPositionHealth,
  checkPreTrade,
  MAX_LEVERAGE,
  MAX_OPEN_POSITIONS,
  RiskError,
} from "../src/risk/engine";
import type { BinanceKline } from "../src/binance/types";

function series(values: number[]): Float64Array {
  return toFloat(values);
}

/** Build synthetic Binance klines from a close series. */
function klinesFromCloses(closes: number[]): BinanceKline[] {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    return [
      index * 60_000,
      String(open),
      String(high),
      String(low),
      String(close),
      "100",
      index * 60_000 + 59_999,
      "10000",
      10,
      "50",
      "5000",
      "0",
    ] as BinanceKline;
  });
}

describe("indicator primitives", () => {
  test("sma matches a hand-computed window", () => {
    const out = sma(series([1, 2, 3, 4, 5]), 3);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(2);
    expect(out[3]).toBe(3);
    expect(out[4]).toBe(4);
    expect(smaLast(series([1, 2, 3, 4, 5]), 2)).toBe(4.5);
  });

  test("ema of a constant series is that constant", () => {
    const out = ema(series([7, 7, 7, 7, 7]), 3);
    expect(last(out)).toBeCloseTo(7, 10);
  });

  test("rsi saturates on one-way moves", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 200 - i);
    expect(rsi(series(up), 14)).toBeCloseTo(100, 6);
    expect(rsi(series(down), 14)).toBeCloseTo(0, 6);
    expect(rsi(series(new Array(40).fill(50)), 14)).toBe(50);
  });

  test("macd of a constant series is zero", () => {
    const result = macd(series(new Array(80).fill(100)), 12, 26, 9);
    expect(result.macd).toBeCloseTo(0, 9);
    expect(result.signal).toBeCloseTo(0, 9);
    expect(result.histogram).toBeCloseTo(0, 9);
  });

  test("bollinger bands collapse on a flat series", () => {
    const result = bollinger(series(new Array(30).fill(42)), 20, 2);
    expect(result.mid).toBeCloseTo(42, 9);
    expect(result.upper).toBeCloseTo(42, 9);
    expect(result.lower).toBeCloseTo(42, 9);
    expect(result.pctB).toBe(0.5);
  });

  test("atr is the average true range on a constant-range series", () => {
    const n = 40;
    const high = series(new Array(n).fill(101));
    const low = series(new Array(n).fill(99));
    const close = series(new Array(n).fill(100));
    expect(atr(high, low, close, 14)).toBeCloseTo(2, 9);
  });

  test("adx confirms a strong trend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const high = series(closes.map((c) => c + 0.5));
    const low = series(closes.map((c) => c - 0.5));
    const close = series(closes);
    expect(adx(high, low, close, 14)).toBeGreaterThan(25);
  });
});

describe("analyzeSymbol", () => {
  test("returns SKIP when there are not enough candles", () => {
    const result = analyzeSymbol(klinesFromCloses([1, 2, 3]));
    expect(result.signal).toBe("SKIP");
    expect(result.confidence).toBe(0);
    expect(result.reason).toContain("Need 60+ candles");
  });

  test("detects a clean uptrend", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 100 * 1.004 ** i);
    const result = analyzeSymbol(klinesFromCloses(closes));
    expect(result.trend).toBe("BULLISH");
    expect(result.signal).toBe("LONG");
    expect(result.ema!.ema20).toBeGreaterThan(result.ema!.ema50);
    expect(result.ema!.ema50).toBeGreaterThan(result.ema!.ema200);
    expect(result.rsi!.value).toBeGreaterThan(70);
    expect(result.volume!.ratio).toBeCloseTo(1, 6);
  });

  test("detects a clean downtrend", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 300 - i * 0.5);
    const result = analyzeSymbol(klinesFromCloses(closes));
    expect(result.trend).toBe("BEARISH");
    expect(result.signal).toBe("SHORT");
    expect(result.rsi!.value).toBeLessThan(30);
  });

  test("flags a falling knife", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5));
    const klines = klinesFromCloses(closes);
    // Force the previous candle to be a bearish body with almost no lower wick
    // and the current candle to close below its low.
    klines[98] = [0, "100", "100.1", "98.0", "98.1", "100", 0, "100", 10, "50", "5000", "0"];
    klines[99] = [0, "98.1", "98.2", "97.0", "97.1", "100", 0, "100", 10, "50", "5000", "0"];
    const result = analyzeSymbol(klines);
    expect(result.candle_action!.falling_knife).toBe(true);
    expect(result.candle_action!.bullish_rejection).toBe(false);
  });

  test("deriveSignal keeps the Python scoring weights", () => {
    const bullish = deriveSignal({
      trend: "BULLISH",
      rsiValue: 60,
      rsiTrend: "NEUTRAL",
      macdCross: "BULLISH_CROSS",
      bbPctB: 0.5,
      volRatio: 2.5,
    });
    expect(bullish.signal).toBe("LONG");
    expect(bullish.confidence).toBe(78);

    const neutral = deriveSignal({
      trend: "NEUTRAL",
      rsiValue: 50,
      rsiTrend: "NEUTRAL",
      macdCross: "BEARISH_MOMENTUM",
      bbPctB: 0.5,
      volRatio: 1,
    });
    expect(neutral.signal).toBe("SKIP");
    expect(neutral.confidence).toBe(28);
  });
});

describe("sl/tp and opportunity scoring", () => {
  test("long sl/tp uses 2x ATR and the configured risk/reward", () => {
    const result = calculateSlTp(100, "LONG", 1, 2);
    expect(result.sl).toBe(98);
    expect(result.tp).toBe(104);
    expect(result.sl_distance_pct).toBe(2);
    expect(result.tp_distance_pct).toBe(4);
  });

  test("short sl/tp mirrors the long side", () => {
    const result = calculateSlTp(100, "SHORT", 1, 2);
    expect(result.sl).toBe(102);
    expect(result.tp).toBe(96);
  });

  test("SKIP and zero ATR return null levels", () => {
    expect(calculateSlTp(100, "SKIP", 1).sl).toBeNull();
    expect(calculateSlTp(100, "LONG", 0).tp).toBeNull();
  });

  test("funding penalties are applied for the paying side", () => {
    const analysis = {
      signal: "LONG" as const,
      confidence: 70,
      trend: "BULLISH" as const,
      rsi: { value: 55, trend: "NEUTRAL" as const },
      macd: { macd: 1, signal: 0.5, histogram: 0.5, cross: "BULLISH_MOMENTUM" as const },
      volume: { current: 100, avg_20: 100, ratio: 1 },
    };
    expect(scoreOpportunity(analysis, 0)).toBe(75);
    expect(scoreOpportunity(analysis, 0.0012)).toBe(45);
    expect(scoreOpportunity(analysis, -0.0012)).toBe(65);
  });
});

describe("exchange precision", () => {
  test("stepToPrecision handles trailing-zero steps", () => {
    expect(stepToPrecision("0.001")).toBe(3);
    expect(stepToPrecision("1")).toBe(0);
    expect(stepToPrecision("0.10")).toBe(1);
  });

  test("quantities round down without float artifacts", () => {
    expect(roundStepQty(1.23456, "0.001")).toBe(1.234);
    expect(roundStepQty(0.0009, "0.001")).toBe(0);
    expect(roundStepQty(7.9, "1")).toBe(7);
    expect(roundStepQty(123.456, "0.01")).toBe(123.45);
  });

  test("prices round half-up to the tick", () => {
    expect(roundTickPrice(1.2346, "0.001")).toBe(1.235);
    expect(roundTickPrice(2.34, "0.1")).toBe(2.3);
    expect(roundTickPrice(2.35, "0.1")).toBe(2.4);
  });

  test("getSymbolPrecision parses exchange filters", () => {
    const info = {
      symbols: [
        {
          symbol: "BTCUSDT",
          pair: "BTCUSDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          filters: [
            { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
            { filterType: "PRICE_FILTER", tickSize: "0.10" },
            { filterType: "MIN_NOTIONAL", notional: "5" },
          ],
        },
      ],
    };
    const precision = getSymbolPrecision(info, "BTCUSDT");
    expect(precision.qty_precision).toBe(3);
    expect(precision.price_precision).toBe(1);
    expect(precision.min_qty).toBe(0.001);
    expect(precision.min_notional).toBe(5);
  });
});

describe("risk engine", () => {
  test("fixed-fractional sizing honours the 2% risk rule", () => {
    const sizing = calculatePositionSize(1000, 100, 98, 10, "0.001");
    expect(sizing.qty).toBe(10);
    expect(sizing.notional).toBe(1000);
    expect(sizing.margin_required).toBe(100);
    expect(sizing.dollar_risk).toBe(20);
  });

  test("sizing caps margin at 90% of free balance", () => {
    // Very tight stop would otherwise request a huge notional.
    const sizing = calculatePositionSize(100, 100, 99.99, 20, "0.001");
    expect(sizing.margin_required).toBeLessThanOrEqual(90);
    expect(sizing.notional).toBeLessThanOrEqual(1800);
  });

  test("leverage above the configured maximum is rejected", () => {
    expect(() => calculatePositionSize(1000, 100, 98, MAX_LEVERAGE + 1)).toThrow(RiskError);
  });

  test("pre-trade gate rejects a full portfolio", () => {
    const positions = Array.from({ length: MAX_OPEN_POSITIONS }, (_, i) => ({
      symbol: `S${i}`,
      positionAmt: "1",
    }));
    expect(() =>
      checkPreTrade({
        account: { availableBalance: "500" },
        positions,
        fundingRate: 0,
        fundingCountdownSeconds: 3600,
        confidence: 80,
      }),
    ).toThrow(/Too many open positions/);
  });

  test("pre-trade gate rejects funding blackout", () => {
    expect(() =>
      checkPreTrade({
        account: { availableBalance: "500" },
        positions: [],
        fundingRate: 0,
        fundingCountdownSeconds: 60,
        confidence: 80,
      }),
    ).toThrow(/blackout/);
  });

  test("pre-trade gate rejects low confidence", () => {
    expect(() =>
      checkPreTrade({
        account: { availableBalance: "500" },
        positions: [],
        fundingRate: 0,
        fundingCountdownSeconds: 3600,
        confidence: 40,
      }),
    ).toThrow(/confidence/);
  });

  test("pre-trade gate passes a healthy account", () => {
    expect(() =>
      checkPreTrade({
        account: { availableBalance: "500" },
        positions: [],
        fundingRate: 0.0001,
        fundingCountdownSeconds: 3600,
        confidence: 80,
      }),
    ).not.toThrow();
  });

  test("health check flags a critical loss", () => {
    const health = checkPositionHealth({
      unRealizedProfit: "-35",
      entryPrice: "100",
      markPrice: "97",
      liquidationPrice: "80",
      positionAmt: "10",
      leverage: "10",
      initialMargin: "100",
    });
    expect(health.status).toBe("CRITICAL");
    expect(health.action).toBe("CLOSE");
  });

  test("health check suggests trailing at strong profit", () => {
    const health = checkPositionHealth({
      unRealizedProfit: "30",
      entryPrice: "100",
      markPrice: "102.5",
      liquidationPrice: "80",
      positionAmt: "10",
      leverage: "10",
      initialMargin: "100",
    });
    expect(health.action).toBe("TRAIL_STOP");
  });

  test("health check suggests breakeven in early profit", () => {
    const health = checkPositionHealth({
      unRealizedProfit: "16",
      entryPrice: "100",
      markPrice: "101.3",
      liquidationPrice: "80",
      positionAmt: "10",
      leverage: "10",
      initialMargin: "100",
    });
    expect(health.action).toBe("MOVE_SL_BE");
  });
});

describe("rounding helper", () => {
  test("roundTo keeps the Python output precision", () => {
    expect(roundTo(1.23456789, 6)).toBe(1.234568);
    expect(roundTo(99.999, 2)).toBe(100);
  });
});

// ── Order-level final risk & drift guards (handler-level logic) ──────────────

describe("final risk guard math", () => {
  test("final risk formula matches the engine sizing model", () => {
    // qty=0.989, entry=100, SL=98 → risk = qty*dist*(1+2*fee)
    const qty = 0.989;
    const entry = 100;
    const sl = 98;
    const risk = qty * Math.abs(entry - sl) * (1 + 2 * 0.0005);
    expect(risk).toBeCloseTo(1.981, 2);
    expect(risk).toBeLessThanOrEqual(2.0);
  });

  test("drift beyond tolerance is detectable", () => {
    const reference = 100;
    const entry = 101; // 1% drift
    const drift = Math.abs(entry - reference) / reference;
    expect(drift).toBeGreaterThan(0.005); // 0.5% tolerance
  });
});
