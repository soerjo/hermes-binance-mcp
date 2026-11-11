"""
Risk management engine for Binance Futures MCP server.
All rule enforcement lives here; server.py delegates to these functions.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
import math
import os
from typing import Any

# ---------------------------------------------------------------------------
# Constants — overridable via environment variables
# ---------------------------------------------------------------------------

MAX_RISK_PER_TRADE_PCT: float = float(os.environ.get("MAX_RISK_PER_TRADE_PCT", "0.02"))
MAX_OPEN_POSITIONS: int = int(os.environ.get("MAX_OPEN_POSITIONS", "5"))
MAX_LEVERAGE: int = int(os.environ.get("MAX_LEVERAGE", "25"))
MAX_FUNDING_RATE: float = float(os.environ.get("MAX_FUNDING_RATE", "0.001"))
FUNDING_BLACKOUT_MINUTES: int = int(os.environ.get("FUNDING_BLACKOUT_MINUTES", "30"))
MIN_CONFIDENCE: int = int(os.environ.get("MIN_CONFIDENCE", "60"))
MAX_DAILY_LOSS_PCT: float = float(os.environ.get("MAX_DAILY_LOSS_PCT", "0.05"))

# Absolute minimum free margin (USD) to permit any new trade
_MIN_FREE_MARGIN_USD: float = 20.0


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------


class RiskError(Exception):
    """Raised when any risk rule is violated. Message describes the breach."""


# ---------------------------------------------------------------------------
# Helper: parse step size → decimal precision
# ---------------------------------------------------------------------------


def _step_to_precision(step_size: str) -> int:
    """Convert a Binance stepSize / tickSize string to decimal-places count.

    Examples:
        "0.001"  -> 3
        "1"      -> 0
        "0.10"   -> 2
    """
    step = step_size.rstrip("0") if "." in step_size else step_size
    if "." in step:
        return len(step.split(".")[1])
    return 0


def _round_step(value: float, step_size: str) -> float:
    """Round *value* down to the nearest multiple of *step_size* using exact Decimal math."""
    step_dec = Decimal(str(step_size))
    if step_dec <= 0:
        return value
    val_dec = Decimal(str(value))
    steps = (val_dec / step_dec).to_integral_value(rounding=ROUND_DOWN)
    return float(steps * step_dec)


def round_step_qty(value: float, step_size: str, qty_precision: int | None = None) -> float:
    """Round order quantity down to exchange LOT_SIZE stepSize without float artifacts."""
    rounded = _round_step(value, step_size)
    prec = _step_to_precision(step_size) if qty_precision is None else qty_precision
    return round(rounded, prec)


def round_tick_price(value: float, tick_size: str, price_precision: int | None = None) -> float:
    """Round price to nearest exchange PRICE_FILTER tickSize without float artifacts."""
    tick_dec = Decimal(str(tick_size))
    if tick_dec <= 0:
        return value
    val_dec = Decimal(str(value))
    ticks = (val_dec / tick_dec).to_integral_value(rounding=ROUND_HALF_UP)
    prec = _step_to_precision(tick_size) if price_precision is None else price_precision
    return round(float(ticks * tick_dec), prec)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_symbol_precision(exchange_info: dict[str, Any], symbol: str) -> dict[str, Any]:
    """Parse LOT_SIZE and PRICE_FILTER from Binance exchange info for *symbol*.

    Parameters
    ----------
    exchange_info:
        The dict returned by ``GET /fapi/v1/exchangeInfo``.
    symbol:
        E.g. ``"BTCUSDT"``.

    Returns
    -------
    dict with keys:
        qty_precision   -- decimal places for quantity
        price_precision -- decimal places for price
        min_qty         -- minimum order quantity (float)
        min_notional    -- minimum order notional value (float)
        qty_step        -- raw step size string (for rounding)
        price_tick      -- raw tick size string (for rounding)
    """
    symbols: list[dict] = exchange_info.get("symbols", [])
    info = next((s for s in symbols if s["symbol"] == symbol), None)
    if info is None:
        raise RiskError(f"Symbol {symbol!r} not found in exchange info")

    filters: list[dict] = info.get("filters", [])

    lot_size = next((f for f in filters if f["filterType"] == "LOT_SIZE"), None)
    price_filter = next((f for f in filters if f["filterType"] == "PRICE_FILTER"), None)
    min_notional_filter = next(
        (f for f in filters if f["filterType"] in ("MIN_NOTIONAL", "NOTIONAL")), None
    )

    if lot_size is None:
        raise RiskError(f"LOT_SIZE filter missing for {symbol!r}")
    if price_filter is None:
        raise RiskError(f"PRICE_FILTER filter missing for {symbol!r}")

    qty_step: str = lot_size["stepSize"]
    price_tick: str = price_filter["tickSize"]
    min_qty: float = float(lot_size["minQty"])
    min_notional: float = (
        float(min_notional_filter.get("minNotional", min_notional_filter.get("notional", "5")))
        if min_notional_filter is not None
        else 5.0
    )

    return {
        "qty_precision": _step_to_precision(qty_step),
        "price_precision": _step_to_precision(price_tick),
        "min_qty": min_qty,
        "min_notional": min_notional,
        "qty_step": qty_step,
        "price_tick": price_tick,
    }


def calculate_position_size(
    free_balance: float,
    entry_price: float,
    sl_price: float,
    leverage: int,
    qty_step: str = "0.001",
) -> dict[str, Any]:
    """Compute position size using fixed-fractional risk model.

    Risk per trade  = free_balance x MAX_RISK_PER_TRADE_PCT
    SL distance     = |entry_price - sl_price|
    Quantity        = dollar_risk / sl_distance  (capped to exchange step size)
    Notional        = qty x entry_price
    Margin required = notional / leverage

    Parameters
    ----------
    free_balance:
        Available free USDT balance.
    entry_price:
        Intended entry price.
    sl_price:
        Stop-loss price.
    leverage:
        Intended leverage (1-MAX_LEVERAGE).
    qty_step:
        Exchange LOT_SIZE stepSize string (default ``"0.001"``).

    Returns
    -------
    dict with keys: qty, notional, margin_required, leverage_used, dollar_risk, sl_distance
    """
    if leverage < 1 or leverage > MAX_LEVERAGE:
        raise RiskError(
            f"Leverage {leverage}x exceeds maximum allowed {MAX_LEVERAGE}x"
        )
    if entry_price <= 0:
        raise RiskError("entry_price must be positive")
    if sl_price <= 0:
        raise RiskError("sl_price must be positive")

    sl_distance = abs(entry_price - sl_price)
    if sl_distance == 0:
        raise RiskError("entry_price and sl_price must differ")

    dollar_risk = free_balance * MAX_RISK_PER_TRADE_PCT
    raw_qty = dollar_risk / sl_distance

    # Cap position notional so required initial margin never exceeds 90% of free_balance
    max_notional_by_margin = free_balance * 0.90 * leverage
    if raw_qty * entry_price > max_notional_by_margin:
        raw_qty = max_notional_by_margin / entry_price

    qty = round_step_qty(raw_qty, qty_step)

    if qty <= 0:
        raise RiskError(
            f"Calculated quantity {raw_qty:.8f} rounds to zero with step {qty_step}; "
            "insufficient balance or stop too tight"
        )

    notional = qty * entry_price
    margin_required = notional / leverage
    actual_risk = qty * sl_distance

    return {
        "qty": qty,
        "notional": round(notional, 2),
        "margin_required": round(margin_required, 2),
        "leverage_used": leverage,
        "dollar_risk": round(actual_risk, 2),
        "sl_distance": round(sl_distance, 8),
    }


def check_pre_trade(
    account: dict[str, Any],
    positions: list[dict[str, Any]],
    funding_rate: float,
    funding_countdown_seconds: float,
    confidence: int,
) -> None:
    """Enforce pre-trade risk rules. Raises RiskError on any violation.

    Parameters
    ----------
    account:
        Binance account dict; must contain ``"availableBalance"`` (str or float).
    positions:
        List of open position dicts (non-zero ``positionAmt`` entries).
    funding_rate:
        Current funding rate as a decimal (e.g. 0.0008 = 0.08%).
    funding_countdown_seconds:
        Seconds until the next funding settlement.
    confidence:
        Signal confidence score (0-100).
    """
    # 1. Open position cap
    open_count = sum(
        1 for p in positions if float(p.get("positionAmt", 0)) != 0
    )
    if open_count >= MAX_OPEN_POSITIONS:
        raise RiskError(
            f"Too many open positions: {open_count} >= max {MAX_OPEN_POSITIONS}"
        )

    # 2. Funding rate spike
    if abs(funding_rate) >= MAX_FUNDING_RATE:
        raise RiskError(
            f"Funding rate {funding_rate:.4%} exceeds max {MAX_FUNDING_RATE:.4%}; "
            "wait for funding normalisation"
        )

    # 3. Funding blackout window
    blackout_seconds = FUNDING_BLACKOUT_MINUTES * 60
    if funding_countdown_seconds < blackout_seconds:
        mins_left = funding_countdown_seconds / 60
        raise RiskError(
            f"In funding blackout window: {mins_left:.1f}min until next funding "
            f"(blackout = {FUNDING_BLACKOUT_MINUTES}min)"
        )

    # 4. Signal confidence
    if confidence < MIN_CONFIDENCE:
        raise RiskError(
            f"Signal confidence {confidence} is below minimum {MIN_CONFIDENCE}; skipping"
        )

    # 5. Absolute margin floor
    free_margin = float(account.get("availableBalance", 0))
    if free_margin < _MIN_FREE_MARGIN_USD:
        raise RiskError(
            f"Free margin ${free_margin:.2f} is below absolute floor "
            f"${_MIN_FREE_MARGIN_USD:.2f}"
        )


def check_position_health(position: dict[str, Any]) -> dict[str, Any]:
    """Evaluate the health of an open position using trader best practices.

    Evaluates:
    1. Unlevered price movement (%) from entryPrice to markPrice
    2. ROE (%) = unrealizedProfit / initialMargin
    3. Distance to liquidationPrice (%)

    Tiered rules:
    * CRITICAL / CLOSE      -- Liquidation distance < 2.0% OR unlevered loss <= -2.5% OR ROE <= -30%
    * WARN / TRAIL_STOP     -- Unlevered gain >= +2.0% OR ROE >= +25% (lock in partial profit & trail stop)
    * WARN / MOVE_SL_BE     -- Unlevered gain >= +1.2% OR ROE >= +15% (shift SL to breakeven + buffer)
    * WARN / MONITOR_CLOSELY-- Unlevered loss <= -1.2% OR ROE <= -15% (early drawdown warning)
    * OK / HOLD             -- normal fluctuation within risk tolerance
    """
    unrealized_pnl = float(position.get("unRealizedProfit") or position.get("unrealizedProfit") or 0)
    entry_price = float(position.get("entryPrice", 0))
    mark_price = float(position.get("markPrice", 0))
    liq_price = float(position.get("liquidationPrice", 0))
    pos_amt = float(position.get("positionAmt", 0))
    leverage = max(1, int(position.get("leverage", 1)))

    initial_margin = (
        float(position.get("initialMargin", 0))
        or float(position.get("isolatedWallet", 0))
        or float(position.get("positionInitialMargin", 0))
    )
    if initial_margin == 0 and entry_price > 0 and pos_amt != 0:
        initial_margin = abs(pos_amt * entry_price) / leverage

    if initial_margin == 0:
        return {
            "status": "OK",
            "action": "HOLD",
            "reason": "No initial margin data; cannot evaluate health",
        }

    roe_pct = unrealized_pnl / initial_margin  # signed ratio (e.g. -0.15 = -15% ROE)

    price_move_pct = 0.0
    if entry_price > 0 and mark_price > 0 and pos_amt != 0:
        if pos_amt > 0:
            price_move_pct = (mark_price - entry_price) / entry_price
        else:
            price_move_pct = (entry_price - mark_price) / entry_price

    liq_dist_pct = None
    if liq_price > 0 and mark_price > 0:
        liq_dist_pct = abs(mark_price - liq_price) / mark_price

    # 1. Liquidation proximity emergency
    if liq_dist_pct is not None and liq_dist_pct < 0.02:
        return {
            "status": "CRITICAL",
            "action": "CLOSE",
            "roe_pct": round(roe_pct * 100, 2),
            "price_move_pct": round(price_move_pct * 100, 2),
            "reason": (
                f"Mark price is within {liq_dist_pct:.2%} of liquidation (${liq_price}); "
                f"immediate close required (${unrealized_pnl:.2f})"
            ),
        }

    # 2. Critical loss: unlevered move <= -2.5% or ROE <= -30%
    if price_move_pct <= -0.025 or roe_pct <= -0.30:
        return {
            "status": "CRITICAL",
            "action": "CLOSE",
            "roe_pct": round(roe_pct * 100, 2),
            "price_move_pct": round(price_move_pct * 100, 2),
            "reason": (
                f"Drawdown limit breached: price move {price_move_pct:+.2%}, "
                f"ROE {roe_pct:+.2%} (${unrealized_pnl:.2f})"
            ),
        }

    # 3. Profit target zone: trail stop to protect gains
    if price_move_pct >= 0.020 or roe_pct >= 0.25:
        return {
            "status": "WARN",
            "action": "TRAIL_STOP",
            "roe_pct": round(roe_pct * 100, 2),
            "price_move_pct": round(price_move_pct * 100, 2),
            "reason": (
                f"Strong profit: price move {price_move_pct:+.2%}, ROE {roe_pct:+.2%} "
                f"(${unrealized_pnl:.2f}); partial TP / trail stop recommended"
            ),
        }

    # 4. Breakeven zone: shift stop loss to entry + buffer
    if price_move_pct >= 0.012 or roe_pct >= 0.15:
        return {
            "status": "OK",
            "action": "MOVE_SL_BE",
            "roe_pct": round(roe_pct * 100, 2),
            "price_move_pct": round(price_move_pct * 100, 2),
            "reason": (
                f"In profit ({price_move_pct:+.2%} price / {roe_pct:+.2%} ROE, ${unrealized_pnl:.2f}); "
                "eligible for breakeven SL shift"
            ),
        }

    # 5. Early warning loss
    if price_move_pct <= -0.012 or roe_pct <= -0.15:
        return {
            "status": "WARN",
            "action": "TRAIL_STOP",
            "roe_pct": round(roe_pct * 100, 2),
            "price_move_pct": round(price_move_pct * 100, 2),
            "reason": (
                f"Early drawdown warning: price move {price_move_pct:+.2%}, "
                f"ROE {roe_pct:+.2%} (${unrealized_pnl:.2f})"
            ),
        }

    return {
        "status": "OK",
        "action": "HOLD",
        "roe_pct": round(roe_pct * 100, 2),
        "price_move_pct": round(price_move_pct * 100, 2),
        "reason": f"Position healthy: price {price_move_pct:+.2%}, ROE {roe_pct:+.2%} (${unrealized_pnl:.2f})",
    }
