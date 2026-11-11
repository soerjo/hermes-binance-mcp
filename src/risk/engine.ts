/**
 * Risk engine — port of the Python `risk.py` module.
 *
 * Rule enforcement lives here; the tool handlers only delegate. Every limit is
 * configurable through the same environment variables as before.
 */

import { config } from "../config";
import { roundStepQty, RiskError } from "./precision";

export { RiskError } from "./precision";
export {
  getSymbolPrecision,
  roundStepQty,
  roundTickPrice,
  stepToPrecision,
} from "./precision";

export const MAX_RISK_PER_TRADE_PCT = config.maxRiskPerTradePct;
export const MAX_OPEN_POSITIONS = config.maxOpenPositions;
export const MAX_LEVERAGE = config.maxLeverage;
export const MAX_FUNDING_RATE = config.maxFundingRate;
export const FUNDING_BLACKOUT_MINUTES = config.fundingBlackoutMinutes;
export const MIN_CONFIDENCE = config.minConfidence;
export const MAX_DAILY_LOSS_PCT = config.maxDailyLossPct;

/** Absolute minimum free margin (USD) to permit any new trade. */
export const MIN_FREE_MARGIN_USD = 20.0;

function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function signedPct(value: number, digits = 2): string {
  const rendered = (value * 100).toFixed(digits);
  return value >= 0 ? `+${rendered}%` : `${rendered}%`;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export interface PositionSizeResult {
  qty: number;
  notional: number;
  margin_required: number;
  leverage_used: number;
  dollar_risk: number;
  sl_distance: number;
}

/**
 * Fixed-fractional sizing.
 *
 * Risk per trade = free_balance * MAX_RISK_PER_TRADE_PCT
 * Quantity       = dollar_risk / |entry - sl|
 * Margin         = notional / leverage, capped at 90% of free balance.
 */
export function calculatePositionSize(
  freeBalance: number,
  entryPrice: number,
  slPrice: number,
  leverage: number,
  qtyStep = "0.001",
): PositionSizeResult {
  if (leverage < 1 || leverage > MAX_LEVERAGE) {
    throw new RiskError(`Leverage ${leverage}x exceeds maximum allowed ${MAX_LEVERAGE}x`);
  }
  if (entryPrice <= 0) throw new RiskError("entry_price must be positive");
  if (slPrice <= 0) throw new RiskError("sl_price must be positive");

  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance === 0) throw new RiskError("entry_price and sl_price must differ");

  const dollarRisk = freeBalance * MAX_RISK_PER_TRADE_PCT;
  let rawQty = dollarRisk / slDistance;

  const maxNotionalByMargin = freeBalance * 0.9 * leverage;
  if (rawQty * entryPrice > maxNotionalByMargin) {
    rawQty = maxNotionalByMargin / entryPrice;
  }

  const qty = roundStepQty(rawQty, qtyStep);
  if (qty <= 0) {
    throw new RiskError(
      `Calculated quantity ${rawQty.toFixed(8)} rounds to zero with step ${qtyStep}; ` +
        "insufficient balance or stop too tight",
    );
  }

  const notional = qty * entryPrice;
  const marginRequired = notional / leverage;
  const actualRisk = qty * slDistance;

  return {
    qty,
    notional: Number(notional.toFixed(2)),
    margin_required: Number(marginRequired.toFixed(2)),
    leverage_used: leverage,
    dollar_risk: Number(actualRisk.toFixed(2)),
    sl_distance: Number(slDistance.toFixed(8)),
  };
}

export interface PreTradeInput {
  account: Record<string, unknown>;
  positions: Array<Record<string, unknown>>;
  fundingRate: number;
  fundingCountdownSeconds: number;
  confidence: number;
}

/** Throws RiskError on the first violated rule. */
export function checkPreTrade(input: PreTradeInput): void {
  const { account, positions, fundingRate, fundingCountdownSeconds, confidence } = input;

  // 1. Open position cap
  const openCount = positions.filter((p) => Number(p.positionAmt ?? 0) !== 0).length;
  if (openCount >= MAX_OPEN_POSITIONS) {
    throw new RiskError(
      `Too many open positions: ${openCount} >= max ${MAX_OPEN_POSITIONS}`,
    );
  }

  // 2. Funding rate spike
  if (Math.abs(fundingRate) >= MAX_FUNDING_RATE) {
    throw new RiskError(
      `Funding rate ${pct(fundingRate, 4)} exceeds max ${pct(MAX_FUNDING_RATE, 4)}; ` +
        "wait for funding normalisation",
    );
  }

  // 3. Funding blackout window
  const blackoutSeconds = FUNDING_BLACKOUT_MINUTES * 60;
  if (fundingCountdownSeconds < blackoutSeconds) {
    throw new RiskError(
      `In funding blackout window: ${(fundingCountdownSeconds / 60).toFixed(1)}min until next funding ` +
        `(blackout = ${FUNDING_BLACKOUT_MINUTES}min)`,
    );
  }

  // 4. Signal confidence
  if (confidence < MIN_CONFIDENCE) {
    throw new RiskError(
      `Signal confidence ${confidence} is below minimum ${MIN_CONFIDENCE}; skipping`,
    );
  }

  // 5. Absolute margin floor
  const freeMargin = Number(account.availableBalance ?? 0);
  if (freeMargin < MIN_FREE_MARGIN_USD) {
    throw new RiskError(
      `Free margin ${money(freeMargin)} is below absolute floor ${money(MIN_FREE_MARGIN_USD)}`,
    );
  }
}

export type HealthStatus = "OK" | "WARN" | "CRITICAL";
export type HealthAction = "HOLD" | "CLOSE" | "TRAIL_STOP" | "MOVE_SL_BE" | "MONITOR_CLOSELY";

export interface HealthResult {
  status: HealthStatus;
  action: HealthAction;
  roe_pct?: number;
  price_move_pct?: number;
  reason: string;
}

/**
 * Trader-grade position health check.
 *
 * Uses the unlevered price move, ROE and liquidation distance — the three
 * numbers a discretionary trader actually looks at — rather than raw PnL.
 */
export function checkPositionHealth(
  position: Record<string, unknown>,
): HealthResult {
  const unrealizedPnl = Number(position.unRealizedProfit ?? position.unrealizedProfit ?? 0);
  const entryPrice = Number(position.entryPrice ?? 0);
  const markPrice = Number(position.markPrice ?? 0);
  const liqPrice = Number(position.liquidationPrice ?? 0);
  const posAmt = Number(position.positionAmt ?? 0);
  const leverage = Math.max(1, Math.trunc(Number(position.leverage ?? 1)));

  let initialMargin =
    Number(position.initialMargin ?? 0) ||
    Number(position.isolatedWallet ?? 0) ||
    Number(position.positionInitialMargin ?? 0);
  if (initialMargin === 0 && entryPrice > 0 && posAmt !== 0) {
    initialMargin = Math.abs(posAmt * entryPrice) / leverage;
  }

  if (initialMargin === 0) {
    return {
      status: "OK",
      action: "HOLD",
      reason: "No initial margin data; cannot evaluate health",
    };
  }

  const roe = unrealizedPnl / initialMargin;

  let priceMove = 0;
  if (entryPrice > 0 && markPrice > 0 && posAmt !== 0) {
    priceMove =
      posAmt > 0
        ? (markPrice - entryPrice) / entryPrice
        : (entryPrice - markPrice) / entryPrice;
  }

  let liqDistance: number | null = null;
  if (liqPrice > 0 && markPrice > 0) {
    liqDistance = Math.abs(markPrice - liqPrice) / markPrice;
  }

  const roePct = Number((roe * 100).toFixed(2));
  const priceMovePct = Number((priceMove * 100).toFixed(2));

  // 1. Liquidation proximity emergency
  if (liqDistance !== null && liqDistance < 0.02) {
    return {
      status: "CRITICAL",
      action: "CLOSE",
      roe_pct: roePct,
      price_move_pct: priceMovePct,
      reason:
        `Mark price is within ${pct(liqDistance)} of liquidation ($${liqPrice}); ` +
        `immediate close required (${money(unrealizedPnl)})`,
    };
  }

  // 2. Critical loss: unlevered move <= -2.5% or ROE <= -30%
  if (priceMove <= -0.025 || roe <= -0.3) {
    return {
      status: "CRITICAL",
      action: "CLOSE",
      roe_pct: roePct,
      price_move_pct: priceMovePct,
      reason:
        `Drawdown limit breached: price move ${signedPct(priceMove)}, ` +
        `ROE ${signedPct(roe)} (${money(unrealizedPnl)})`,
    };
  }

  // 3. Profit target zone: trail stop to protect gains
  if (priceMove >= 0.02 || roe >= 0.25) {
    return {
      status: "WARN",
      action: "TRAIL_STOP",
      roe_pct: roePct,
      price_move_pct: priceMovePct,
      reason:
        `Strong profit: price move ${signedPct(priceMove)}, ROE ${signedPct(roe)} ` +
        `(${money(unrealizedPnl)}); partial TP / trail stop recommended`,
    };
  }

  // 4. Breakeven zone: shift stop loss to entry + buffer
  if (priceMove >= 0.012 || roe >= 0.15) {
    return {
      status: "OK",
      action: "MOVE_SL_BE",
      roe_pct: roePct,
      price_move_pct: priceMovePct,
      reason:
        `In profit (${signedPct(priceMove)} price / ${signedPct(roe)} ROE, ${money(unrealizedPnl)}); ` +
        "eligible for breakeven SL shift",
    };
  }

  // 5. Early warning loss
  if (priceMove <= -0.012 || roe <= -0.15) {
    return {
      status: "WARN",
      action: "TRAIL_STOP",
      roe_pct: roePct,
      price_move_pct: priceMovePct,
      reason:
        `Early drawdown warning: price move ${signedPct(priceMove)}, ` +
        `ROE ${signedPct(roe)} (${money(unrealizedPnl)})`,
    };
  }

  return {
    status: "OK",
    action: "HOLD",
    roe_pct: roePct,
    price_move_pct: priceMovePct,
    reason: `Position healthy: price ${signedPct(priceMove)}, ROE ${signedPct(roe)} (${money(unrealizedPnl)})`,
  };
}
