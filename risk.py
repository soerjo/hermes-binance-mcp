"""
Risk management engine for Binance Futures MCP server.
All rule enforcement lives here; server.py delegates to these functions.
"""

from __future__ import annotations

import math
import os
from typing import Any

# ---------------------------------------------------------------------------
# Constants — overridable via environment variables
# ---------------------------------------------------------------------------

MAX_RISK_PER_TRADE_PCT: float = float(os.environ.get("MAX_RISK_PER_TRADE_PCT", "0.02"))
MAX_OPEN_POSITIONS: int = int(os.environ.get("MAX_OPEN_POSITIONS", "3"))
MAX_LEVERAGE: int = int(os.environ.get("MAX_LEVERAGE", "10"))
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
    """Round *value* down to the nearest multiple of *step_size*."""
    step = float(step_size)
    if step == 0:
        return value
    return math.floor(value / step) * step


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
    qty = _round_step(raw_qty, qty_step)

    if qty <= 0:
        raise RiskError(
            f"Calculated quantity {raw_qty:.8f} rounds to zero with step {qty_step}; "
            "insufficient balance or stop too tight"
        )

    notional = qty * entry_price
    margin_required = notional / leverage

    return {
        "qty": qty,
        "notional": round(notional, 2),
        "margin_required": round(margin_required, 2),
        "leverage_used": leverage,
        "dollar_risk": round(dollar_risk, 2),
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


def check_position_health(position: dict[str, Any]) -> dict[str, str]:
    """Evaluate the health of an open position.

    The function reads ``unrealizedProfit`` and ``initialMargin`` (or
    ``isolatedWallet``) from the Binance position dict and applies tiered rules:

    * CRITICAL / CLOSE      -- PnL < -3% of initial margin
    * WARN / TRAIL_STOP     -- PnL > +3% of initial margin (lock in gains)
    * WARN / TRAIL_STOP     -- PnL < -1.5% of initial margin
    * OK / HOLD             -- everything else

    Parameters
    ----------
    position:
        A single position dict from Binance ``/fapi/v2/positionRisk``.

    Returns
    -------
    dict with keys: status, action, reason
    """
    unrealized_pnl = float(position.get("unRealizedProfit") or position.get("unrealizedProfit") or 0)

    # Prefer ``initialMargin``; fall back to ``isolatedWallet`` then ``positionInitialMargin``
    initial_margin = (
        float(position.get("initialMargin", 0))
        or float(position.get("isolatedWallet", 0))
        or float(position.get("positionInitialMargin", 0))
    )

    if initial_margin == 0:
        return {
            "status": "OK",
            "action": "HOLD",
            "reason": "No initial margin data; cannot evaluate health",
        }

    pnl_pct = unrealized_pnl / initial_margin  # signed ratio

    # Critical loss: hard close
    if pnl_pct < -0.03:
        return {
            "status": "CRITICAL",
            "action": "CLOSE",
            "reason": (
                f"Unrealized PnL {pnl_pct:.2%} breaches -3% of initial margin "
                f"(${unrealized_pnl:.2f})"
            ),
        }

    # Profit target exceeded: trail stop to protect gains
    if pnl_pct > 0.03:
        return {
            "status": "WARN",
            "action": "TRAIL_STOP",
            "reason": (
                f"Unrealized PnL {pnl_pct:.2%} exceeds +3%; trail stop to protect gains "
                f"(${unrealized_pnl:.2f})"
            ),
        }

    # Early warning loss
    if pnl_pct < -0.015:
        return {
            "status": "WARN",
            "action": "TRAIL_STOP",
            "reason": (
                f"Unrealized PnL {pnl_pct:.2%} below -1.5% of initial margin "
                f"(${unrealized_pnl:.2f})"
            ),
        }

    return {
        "status": "OK",
        "action": "HOLD",
        "reason": f"Position healthy: PnL {pnl_pct:.2%} (${unrealized_pnl:.2f})",
    }
