/**
 * Zero-dependency technical indicators.
 *
 * All series are `Float64Array` so the hot path does no object allocation.
 * Formulas follow the classic trader definitions:
 *   - EMA  : pandas-style `ewm(span=n, adjust=False)` seeded on the first value
 *   - RSI  : Wilder smoothing (RMA) of gains/losses
 *   - MACD : EMA(12) - EMA(26), signal = EMA(9) of MACD
 *   - BB   : SMA(20) +/- 2 population std-dev
 *   - ATR  : Wilder smoothing of True Range
 *   - ADX  : Wilder directional movement, smoothed with RMA
 *
 * Values before an indicator is defined are `NaN`.
 */

export const NaN_VALUE = Number.NaN;

export function toFloat(values: ArrayLike<number>): Float64Array {
  if (values instanceof Float64Array) return values;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = Number(values[i]);
  return out;
}

/** Simple moving average series (NaN until `window` samples exist). */
export function sma(values: Float64Array, window: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN_VALUE);
  if (window <= 0 || n < window) return out;

  let sum = 0;
  for (let i = 0; i < window; i += 1) sum += values[i];
  out[window - 1] = sum / window;

  for (let i = window; i < n; i += 1) {
    sum += values[i] - values[i - window];
    out[i] = sum / window;
  }
  return out;
}

/** Exponential moving average seeded on the first sample (adjust=False). */
export function ema(values: Float64Array, span: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN_VALUE);
  if (n === 0 || span <= 0) return out;

  const alpha = 2 / (span + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < n; i += 1) {
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's smoothing (a.k.a. RMA): alpha = 1/window.
 * The first `window - 1` outputs are NaN, then the seed is the SMA of the first
 * `window` samples — this is the definition used by Wilder's ATR/RSI/ADX.
 */
export function rma(values: Float64Array, window: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN_VALUE);
  if (window <= 0 || n < window) return out;

  let seed = 0;
  for (let i = 0; i < window; i += 1) seed += values[i];
  seed /= window;
  out[window - 1] = seed;

  const alpha = 1 / window;
  let prev = seed;
  for (let i = window; i < n; i += 1) {
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** Rolling population standard deviation (ddof = 0), matching Bollinger Bands. */
export function rollingStd(values: Float64Array, window: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN_VALUE);
  if (window <= 0 || n < window) return out;

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < window; i += 1) {
    sum += values[i];
    sumSq += values[i] * values[i];
  }
  const finish = (i: number): number => {
    const mean = sum / window;
    const variance = Math.max(0, sumSq / window - mean * mean);
    return Math.sqrt(variance);
  };
  out[window - 1] = finish(window - 1);

  for (let i = window; i < n; i += 1) {
    const outgoing = values[i - window];
    sum += values[i] - outgoing;
    sumSq += values[i] * values[i] - outgoing * outgoing;
    out[i] = finish(i);
  }
  return out;
}

/** Last defined value of a series, or NaN. */
export function last(series: Float64Array): number {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (!Number.isNaN(series[i])) return series[i];
  }
  return NaN_VALUE;
}

/** Wilder RSI. Returns NaN when there is not enough data. */
export function rsi(values: Float64Array, window = 14): number {
  const n = values.length;
  if (n <= window) return NaN_VALUE;

  const gains = new Float64Array(n);
  const losses = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains[i] = diff;
    else losses[i] = -diff;
  }

  // Seed with the simple average of the first `window` deltas (index 1..window).
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= window; i += 1) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= window;
  avgLoss /= window;

  for (let i = window + 1; i < n; i += 1) {
    avgGain = (avgGain * (window - 1) + gains[i]) / window;
    avgLoss = (avgLoss * (window - 1) + losses[i]) / window;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
  prevHistogram: number;
}

export function macd(
  values: Float64Array,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const empty: MacdResult = {
    macd: NaN_VALUE,
    signal: NaN_VALUE,
    histogram: NaN_VALUE,
    prevHistogram: NaN_VALUE,
  };
  if (values.length < slow + signalPeriod) return empty;

  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    macdLine[i] = fastEma[i] - slowEma[i];
  }
  const signalLine = ema(macdLine, signalPeriod);

  const i = values.length - 1;
  const macdValue = macdLine[i];
  const signalValue = signalLine[i];
  return {
    macd: macdValue,
    signal: signalValue,
    histogram: macdValue - signalValue,
    prevHistogram: macdLine[i - 1] - signalLine[i - 1],
  };
}

export interface BollingerResult {
  upper: number;
  mid: number;
  lower: number;
  width: number;
  pctB: number;
}

export function bollinger(
  values: Float64Array,
  window = 20,
  dev = 2,
): BollingerResult {
  const midSeries = sma(values, window);
  const stdSeries = rollingStd(values, window);
  const i = values.length - 1;
  if (i < 0 || Number.isNaN(midSeries[i])) {
    return { upper: NaN_VALUE, mid: NaN_VALUE, lower: NaN_VALUE, width: NaN_VALUE, pctB: NaN_VALUE };
  }
  const mid = midSeries[i];
  const sd = stdSeries[i];
  const upper = mid + dev * sd;
  const lower = mid - dev * sd;
  const width = upper - lower;
  const price = values[i];
  const pctB = width !== 0 ? (price - lower) / width : 0.5;
  return { upper, mid, lower, width, pctB };
}

/** True Range series; index 0 is high - low (previous close unknown). */
export function trueRange(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
): Float64Array {
  const n = high.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const range = high[i] - low[i];
    if (i === 0) {
      out[i] = range;
      continue;
    }
    const prevClose = close[i - 1];
    out[i] = Math.max(range, Math.abs(high[i] - prevClose), Math.abs(low[i] - prevClose));
  }
  return out;
}

/** Wilder ATR. */
export function atr(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  window = 14,
): number {
  if (high.length < window + 1) return NaN_VALUE;
  return last(rma(trueRange(high, low, close), window));
}

/**
 * Wilder ADX.
 *
 * Only the larger of +DM / -DM counts for a bar (standard Wilder rule); the
 * opposite directional movement is zeroed out.
 */
export function adx(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  window = 14,
): number {
  const n = high.length;
  if (n < window * 2 + 1) return NaN_VALUE;

  const plusDm = new Float64Array(n);
  const minusDm = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    if (upMove > downMove && upMove > 0) plusDm[i] = upMove;
    else if (downMove > upMove && downMove > 0) minusDm[i] = downMove;
  }

  const tr = trueRange(high, low, close);
  // The first bar has no directional movement; start both series at index 1.
  const trTail = tr.subarray(1);
  const plusTail = plusDm.subarray(1);
  const minusTail = minusDm.subarray(1);

  const atrSmoothed = rma(trTail, window);
  const plusSmoothed = rma(plusTail, window);
  const minusSmoothed = rma(minusTail, window);

  const dx = new Float64Array(trTail.length).fill(NaN_VALUE);
  for (let i = 0; i < dx.length; i += 1) {
    const a = atrSmoothed[i];
    if (Number.isNaN(a) || a === 0) continue;
    const plusDi = (100 * plusSmoothed[i]) / a;
    const minusDi = (100 * minusSmoothed[i]) / a;
    const sum = plusDi + minusDi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / sum;
  }

  // Wilder smooths DX with the same alpha, but the first ADX value is the
  // average of the first `window` defined DX values.
  const defined: number[] = [];
  for (let i = 0; i < dx.length; i += 1) {
    if (!Number.isNaN(dx[i])) defined.push(dx[i]);
  }
  if (defined.length < window) return NaN_VALUE;

  let value = 0;
  for (let i = 0; i < window; i += 1) value += defined[i];
  value /= window;
  for (let i = window; i < defined.length; i += 1) {
    value = (value * (window - 1) + defined[i]) / window;
  }
  return value;
}

/** Rolling SMA of the last `window` samples (NaN when not enough data). */
export function smaLast(values: Float64Array, window: number): number {
  if (values.length < window || window <= 0) return NaN_VALUE;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i += 1) sum += values[i];
  return sum / window;
}

// ── Extended indicators for regime detection & orderflow ─────────────────────

/** Choppiness Index (CHOP 14). < 38.2 = strong trend, > 61.8 = choppy. */
export function choppiness(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  window = 14,
): number {
  const n = high.length;
  if (n < window + 1) return NaN_VALUE;

  let trSum = 0;
  for (let i = n - window; i < n; i += 1) {
    const range = high[i] - low[i];
    if (i === 0) { trSum += range; continue; }
    const prevClose = close[i - 1];
    trSum += Math.max(range, Math.abs(high[i] - prevClose), Math.abs(low[i] - prevClose));
  }

  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let i = n - window; i < n; i += 1) {
    if (high[i] > maxHigh) maxHigh = high[i];
    if (low[i] < minLow) minLow = low[i];
  }
  const rangeHL = maxHigh - minLow;
  if (rangeHL <= 0) return NaN_VALUE;

  return 100 * (Math.log10(trSum / rangeHL) / Math.log10(window));
}

/** Volume-Weighted Average Price over the last `window` bars. */
export function vwap(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  volume: Float64Array,
  window = 20,
): number {
  const n = high.length;
  if (n < window || window <= 0) return NaN_VALUE;

  let pvSum = 0;
  let volSum = 0;
  for (let i = n - window; i < n; i += 1) {
    const typicalPrice = (high[i] + low[i] + close[i]) / 3;
    pvSum += typicalPrice * volume[i];
    volSum += volume[i];
  }
  if (volSum === 0) return NaN_VALUE;
  return pvSum / volSum;
}

/** Swing High / Swing Low structural levels over the last `window` bars. */
export function swingLevels(
  high: Float64Array,
  low: Float64Array,
  window = 20,
): { swingHigh: number; swingLow: number } {
  const n = high.length;
  if (n < window || window <= 0) {
    return { swingHigh: NaN_VALUE, swingLow: NaN_VALUE };
  }
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let i = n - window; i < n; i += 1) {
    if (high[i] > maxHigh) maxHigh = high[i];
    if (low[i] < minLow) minLow = low[i];
  }
  return {
    swingHigh: Number.isFinite(maxHigh) ? maxHigh : NaN_VALUE,
    swingLow: Number.isFinite(minLow) ? minLow : NaN_VALUE,
  };
}

/** Taker Buy Ratio — fraction of volume that was aggressive (market) buying. */
export function takerBuyRatio(takerBuyVol: number, totalVol: number): number {
  if (totalVol <= 0) return 0.5;
  const ratio = takerBuyVol / totalVol;
  return Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0.5;
}

/** Relative Strength vs BTC — percentage difference over `window` bars. */
export function relativeStrength(
  symbolClose: Float64Array,
  btcClose: Float64Array,
  window = 24,
): number {
  const n = Math.min(symbolClose.length, btcClose.length);
  if (n < window + 1 || window <= 0) return 0;
  const symChange = (symbolClose[n - 1] - symbolClose[n - 1 - window]) / symbolClose[n - 1 - window];
  const btcChange = (btcClose[n - 1] - btcClose[n - 1 - window]) / btcClose[n - 1 - window];
  if (!Number.isFinite(symChange) || !Number.isFinite(btcChange)) return 0;
  return (symChange - btcChange) * 100;
}
