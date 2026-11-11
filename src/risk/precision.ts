/**
 * Exact exchange-precision rounding.
 *
 * Binance rejects orders whose quantity/price is not an exact multiple of
 * `LOT_SIZE.stepSize` / `PRICE_FILTER.tickSize` (error -1111). Doing this with
 * floats silently introduces artifacts (0.1 + 0.2 ...), so every conversion is
 * done with scaled BigInt math instead.
 */

import type { ExchangeInfo, SymbolInfo } from "../binance/types";

export class RiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskError";
  }
}

interface Decimal {
  digits: bigint;
  scale: number;
}

/** Parse a decimal string (including exponent notation) into scaled BigInt. */
export function parseDecimal(input: string): Decimal {
  let text = input.trim();
  let exponent = 0;

  const eIndex = text.search(/[eE]/);
  if (eIndex >= 0) {
    exponent = Number.parseInt(text.slice(eIndex + 1), 10);
    text = text.slice(0, eIndex);
  }

  let sign = 1n;
  if (text.startsWith("-")) {
    sign = -1n;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  const dot = text.indexOf(".");
  let digitsText: string;
  let scale: number;
  if (dot >= 0) {
    digitsText = text.slice(0, dot) + text.slice(dot + 1);
    scale = text.length - dot - 1;
  } else {
    digitsText = text;
    scale = 0;
  }

  digitsText = digitsText.replace(/^0+(?=\d)/, "") || "0";
  let digits = BigInt(digitsText) * sign;

  if (Number.isFinite(exponent) && exponent !== 0) {
    if (exponent > 0) {
      digits *= 10n ** BigInt(exponent);
    } else {
      scale += -exponent;
    }
  }

  return { digits, scale };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Convert a JS float into an exact decimal representation. */
function floatToDecimal(value: number): Decimal {
  const text = value.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  return parseDecimal(text);
}

function decimalToString(digits: bigint, scale: number): string {
  const negative = digits < 0n;
  let text = (negative ? -digits : digits).toString();
  if (scale > 0) {
    if (text.length <= scale) text = text.padStart(scale + 1, "0");
    text = `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
  }
  return negative ? `-${text}` : text;
}

type RoundingMode = "down" | "half-up";

function roundToMultiple(value: number, stepSize: string, mode: RoundingMode): number {
  if (!Number.isFinite(value)) return value;
  const step = parseDecimal(stepSize);
  if (step.digits <= 0n) return value;

  const val = floatToDecimal(value);
  const scale = Math.max(step.scale, val.scale);
  const stepUnits = step.digits * pow10(scale - step.scale);
  const valUnits = val.digits * pow10(scale - val.scale);

  let multiples: bigint;
  if (mode === "down") {
    // Truncation toward zero; quantities are positive in practice.
    multiples = valUnits / stepUnits;
  } else {
    // ROUND_HALF_UP for positive values.
    const numerator = valUnits * 2n + stepUnits;
    multiples = numerator / (stepUnits * 2n);
  }

  const result = multiples * stepUnits;
  return Number(decimalToString(result, scale));
}

/** Decimal places implied by a step/tick string ("0.001" -> 3, "1" -> 0). */
export function stepToPrecision(stepSize: string): number {
  // Python stripped trailing zeros before counting decimals, so "0.10" -> 1.
  const trimmed = stepSize.includes(".") ? stepSize.replace(/0+$/, "") : stepSize;
  const dot = trimmed.indexOf(".");
  return dot >= 0 ? trimmed.length - dot - 1 : 0;
}

/** Round a quantity DOWN to the exchange LOT_SIZE step. */
export function roundStepQty(
  value: number,
  stepSize: string,
  _qtyPrecision?: number,
): number {
  // The BigInt path already returns an exact multiple with the step's own
  // decimal places, so no float re-rounding is needed.
  return roundToMultiple(value, stepSize, "down");
}

/** Round a price to the nearest exchange PRICE_FILTER tick. */
export function roundTickPrice(
  value: number,
  tickSize: string,
  _pricePrecision?: number,
): number {
  return roundToMultiple(value, tickSize, "half-up");
}

export interface SymbolPrecision {
  qty_precision: number;
  price_precision: number;
  min_qty: number;
  min_notional: number;
  qty_step: string;
  price_tick: string;
}

function findSymbol(exchangeInfo: ExchangeInfo, symbol: string): SymbolInfo {
  const info = (exchangeInfo.symbols ?? []).find((s) => s.symbol === symbol);
  if (!info) throw new RiskError(`Symbol '${symbol}' not found in exchange info`);
  return info;
}

function findFilter(info: SymbolInfo, types: string[]) {
  return (info.filters ?? []).find((f) => types.includes(f.filterType));
}

/** Parse LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL for a symbol. */
export function getSymbolPrecision(
  exchangeInfo: ExchangeInfo,
  symbol: string,
): SymbolPrecision {
  const info = findSymbol(exchangeInfo, symbol);
  const lotSize = findFilter(info, ["LOT_SIZE"]);
  const priceFilter = findFilter(info, ["PRICE_FILTER"]);
  const minNotionalFilter = findFilter(info, ["MIN_NOTIONAL", "NOTIONAL"]);

  if (!lotSize) throw new RiskError(`LOT_SIZE filter missing for '${symbol}'`);
  if (!priceFilter) throw new RiskError(`PRICE_FILTER filter missing for '${symbol}'`);

  const qtyStep = String(lotSize.stepSize);
  const priceTick = String(priceFilter.tickSize);
  const minNotionalRaw =
    minNotionalFilter?.minNotional ?? minNotionalFilter?.notional ?? "5";

  return {
    qty_precision: stepToPrecision(qtyStep),
    price_precision: stepToPrecision(priceTick),
    min_qty: Number(lotSize.minQty),
    min_notional: Number(minNotionalRaw),
    qty_step: qtyStep,
    price_tick: priceTick,
  };
}
