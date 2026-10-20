"""
Binance Futures MCP Server for Hermes Agent
Exposes trading tools via FastMCP protocol.

Run: python server.py
Env: BINANCE_API_KEY, BINANCE_API_SECRET
"""

import logging
import os
import sys
from typing import Optional

from mcp.server.fastmcp import FastMCP
from client import BinanceClient, BinanceAPIError
from analysis import analyze_symbol, calculate_sl_tp, score_opportunity
from risk import (
    RiskError,
    check_pre_trade,
    check_position_health,
    calculate_position_size,
    get_symbol_precision,
)

# ── Logging (stderr only — stdout is MCP protocol) ──────────────────────────
logging.basicConfig(
    stream=sys.stderr,
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("binance-mcp")

# ── Top-N symbols to scan by default ────────────────────────────────────────
SCAN_TOP_N = int(os.getenv("SCAN_TOP_N", "15"))
SCAN_INTERVAL = os.getenv("SCAN_INTERVAL", "4h")
DEFAULT_LEVERAGE = int(os.getenv("DEFAULT_LEVERAGE", "5"))
RISK_REWARD = float(os.getenv("RISK_REWARD", "2.0"))

mcp = FastMCP("binance-futures")

# ── Helper ───────────────────────────────────────────────────────────────────

def _client() -> BinanceClient:
    return BinanceClient()


def _fmt_pos(p: dict) -> dict:
    """Trim position dict to essential fields."""
    return {
        "symbol": p.get("symbol"),
        "side": p.get("positionSide", p.get("side")),
        "entry_price": float(p.get("entryPrice", 0)),
        "mark_price": float(p.get("markPrice", 0)),
        "qty": float(p.get("positionAmt", 0)),
        "unrealized_pnl": float(p.get("unRealizedProfit", 0)),
        "leverage": int(p.get("leverage", 1)),
        "margin_type": p.get("marginType"),
        "initial_margin": float(p.get("initialMargin", 0)),
    }

# ═══════════════════════════════════════════════════════════════════════════
# MARKET DATA TOOLS
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
def get_futures_market(symbol: str, interval: str = "4h", limit: int = 200) -> dict:
    """
    Fetch OHLCV klines + 24h ticker + mark price for a single symbol.
    Use this before analyze_symbol to get raw market data.

    Args:
        symbol: e.g. "BTCUSDT"
        interval: kline interval e.g. "1h", "4h", "1d"
        limit: number of candles (max 1500)
    """
    with _client() as c:
        klines = c.get_klines(symbol, interval, limit)
        ticker = c.get_ticker_24hr(symbol)
        mark = c.get_mark_price(symbol)
        book = c.get_book_ticker(symbol)
    return {
        "symbol": symbol,
        "interval": interval,
        "klines": klines,
        "ticker_24h": ticker,
        "mark_price": mark,
        "book_ticker": book,
    }


@mcp.tool()
def scan_market(
    top_n: int = SCAN_TOP_N,
    interval: str = SCAN_INTERVAL,
    min_volume_usdt: float = 50_000_000,
) -> dict:
    """
    Scan top futures markets by 24h volume, run technical analysis,
    score each, and return ranked opportunities.

    Args:
        top_n: how many top-volume symbols to analyze
        interval: kline interval for analysis
        min_volume_usdt: minimum 24h volume filter (USDT)

    Returns ranked list with signal, confidence, score per symbol.
    """
    with _client() as c:
        all_tickers = c.get_ticker_24hr()

    # Filter USDT perps with sufficient volume
    usdt_pairs = [
        t for t in all_tickers
        if t["symbol"].endswith("USDT")
        and float(t.get("quoteVolume", 0)) >= min_volume_usdt
    ]
    usdt_pairs.sort(key=lambda t: float(t.get("quoteVolume", 0)), reverse=True)
    top_symbols = [t["symbol"] for t in usdt_pairs[:top_n]]

    log.info(f"Scanning {len(top_symbols)} symbols: {top_symbols}")

    results = []
    with _client() as c:
        for sym in top_symbols:
            try:
                klines = c.get_klines(sym, interval, 300)
                mark_data = c.get_mark_price(sym)
                funding_rate = float(mark_data.get("lastFundingRate", 0))
                funding_countdown = int(mark_data.get("nextFundingTime", 0))

                analysis = analyze_symbol(klines)
                score = score_opportunity(analysis, funding_rate)

                results.append({
                    "symbol": sym,
                    "price": float(mark_data.get("markPrice", 0)),
                    "volume_24h_usdt": float(next(
                        (t["quoteVolume"] for t in usdt_pairs if t["symbol"] == sym), 0
                    )),
                    "funding_rate": funding_rate,
                    "funding_countdown_ms": funding_countdown,
                    "signal": analysis["signal"],
                    "confidence": analysis["confidence"],
                    "score": score,
                    "trend": analysis["trend"],
                    "rsi": analysis["rsi"]["value"],
                    "macd_cross": analysis["macd"]["cross"],
                    "atr": analysis["atr"],
                    "analysis": analysis,
                })
            except Exception as e:
                log.warning(f"Failed to analyze {sym}: {e}")

    results.sort(key=lambda r: r["score"], reverse=True)
    actionable = [r for r in results if r["signal"] != "SKIP"]

    return {
        "scanned": len(results),
        "actionable": len(actionable),
        "interval": interval,
        "top_opportunities": results[:10],
        "ranked_actionable": actionable[:5],
    }


@mcp.tool()
def analyze_market(symbol: str, interval: str = "4h") -> dict:
    """
    Run full technical analysis on a symbol.
    Returns RSI, MACD, EMA stack, Bollinger Bands, trend, signal, confidence.

    Args:
        symbol: e.g. "BTCUSDT"
        interval: kline interval
    """
    with _client() as c:
        klines = c.get_klines(symbol, interval, 300)
        mark_data = c.get_mark_price(symbol)

    funding_rate = float(mark_data.get("lastFundingRate", 0))
    analysis = analyze_symbol(klines)
    score = score_opportunity(analysis, funding_rate)
    sl_tp = calculate_sl_tp(
        entry_price=float(mark_data.get("markPrice", 0)),
        side=analysis["signal"],
        atr=analysis["atr"],
        risk_reward=RISK_REWARD,
    )

    return {
        "symbol": symbol,
        "interval": interval,
        "mark_price": float(mark_data.get("markPrice", 0)),
        "funding_rate": funding_rate,
        "analysis": analysis,
        "score": score,
        "suggested_sl_tp": sl_tp,
    }


@mcp.tool()
def get_funding_rates(symbols: Optional[list] = None) -> list:
    """
    Get current funding rates for symbols (or top 20 by volume if none given).

    Args:
        symbols: list of symbol strings, e.g. ["BTCUSDT", "ETHUSDT"]
    """
    with _client() as c:
        if symbols:
            return [c.get_mark_price(s) for s in symbols]
        all_mark = c.get_mark_price()
        if isinstance(all_mark, list):
            return sorted(
                all_mark,
                key=lambda x: abs(float(x.get("lastFundingRate", 0))),
                reverse=True,
            )[:20]
        return [all_mark]

# ═══════════════════════════════════════════════════════════════════════════
# ACCOUNT TOOLS
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
def get_account_status() -> dict:
    """
    Get current Binance Futures account: balance, margin, positions count.
    Always call this before placing any order.
    """
    with _client() as c:
        account = c.get_account()

    assets = account.get("assets", [])
    usdt_asset = next((a for a in assets if a.get("asset") == "USDT"), {})
    positions = [
        p for p in account.get("positions", [])
        if float(p.get("positionAmt", 0)) != 0
    ]

    return {
        "total_wallet_balance": float(account.get("totalWalletBalance", 0)),
        "total_unrealized_pnl": float(account.get("totalUnrealizedProfit", 0)),
        "total_margin_balance": float(account.get("totalMarginBalance", 0)),
        "available_balance": float(account.get("availableBalance", 0)),
        "usdt": {
            "wallet": float(usdt_asset.get("walletBalance", 0)),
            "available": float(usdt_asset.get("availableBalance", 0)),
            "unrealized_pnl": float(usdt_asset.get("unrealizedProfit", 0)),
            "initial_margin": float(usdt_asset.get("initialMargin", 0)),
        },
        "open_positions_count": len(positions),
        "can_trade": account.get("canTrade", False),
    }


@mcp.tool()
def get_open_positions() -> list:
    """
    Get all currently open futures positions with health check.
    Returns positions with status (OK/WARN/CRITICAL) and recommended action.
    """
    with _client() as c:
        all_positions = c.get_position_risk()

    open_pos = [p for p in all_positions if float(p.get("positionAmt", 0)) != 0]
    result = []
    for p in open_pos:
        fmt = _fmt_pos(p)
        health = check_position_health(p)
        fmt.update(health)
        result.append(fmt)

    return result


@mcp.tool()
def get_open_orders(symbol: Optional[str] = None) -> list:
    """
    Get all open orders (limit/stop/TP orders).

    Args:
        symbol: filter by symbol, or None for all
    """
    with _client() as c:
        orders = c.get_open_orders(symbol)
    return orders

# ═══════════════════════════════════════════════════════════════════════════
# ORDER TOOLS
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
def place_futures_order(
    symbol: str,
    side: str,
    leverage: int = DEFAULT_LEVERAGE,
    sl_price: Optional[float] = None,
    tp_price: Optional[float] = None,
    qty: Optional[float] = None,
    use_auto_sizing: bool = True,
    margin_type: str = "ISOLATED",
) -> dict:
    """
    Place a Binance Futures LONG or SHORT order with automatic position sizing,
    SL, and TP. Risk rules are enforced automatically.

    This is the PRIMARY order execution tool. Use this for new positions.

    Args:
        symbol: e.g. "BTCUSDT"
        side: "LONG" or "SHORT"
        leverage: 1–20 (default 5)
        sl_price: stop-loss price (required if use_auto_sizing=True)
        tp_price: take-profit price (optional; auto-calculated if omitted)
        qty: manual quantity override (use_auto_sizing must be False)
        use_auto_sizing: if True, size by 2% risk rule automatically
        margin_type: "ISOLATED" or "CROSSED"
    """
    if leverage > 20:
        return {"error": "Max leverage is 20. Risk rule enforced."}
    if side not in ("LONG", "SHORT"):
        return {"error": "side must be LONG or SHORT"}

    with _client() as c:
        account = c.get_account()
        all_positions = c.get_position_risk()
        mark_data = c.get_mark_price(symbol)
        exchange_info = c.get_exchange_info()

    open_positions = [p for p in all_positions if float(p.get("positionAmt", 0)) != 0]
    funding_rate = float(mark_data.get("lastFundingRate", 0))
    funding_countdown_ms = int(mark_data.get("nextFundingTime", 0))
    import time
    funding_countdown_s = max(0, (funding_countdown_ms - int(time.time() * 1000)) // 1000)
    mark_price = float(mark_data.get("markPrice", 0))
    free_balance = float(account.get("availableBalance", 0))

    # ── Auto-calculate SL/TP from ATR if not provided ──────────────────────
    if sl_price is None or tp_price is None:
        klines = BinanceClient().get_klines(symbol, "4h", 200)
        analysis = analyze_symbol(klines)
        sl_tp = calculate_sl_tp(mark_price, side, analysis["atr"], RISK_REWARD)
        if sl_price is None:
            sl_price = sl_tp["sl"]
        if tp_price is None:
            tp_price = sl_tp["tp"]

    # ── Risk checks ─────────────────────────────────────────────────────────
    from analysis import analyze_symbol as _analyze
    confidence = 60  # default when calling directly without scan
    try:
        check_pre_trade(
            account=account,
            positions=open_positions,
            funding_rate=funding_rate,
            funding_countdown_seconds=funding_countdown_s,
            confidence=confidence,
        )
    except RiskError as e:
        return {"error": f"Risk rule blocked: {e}", "blocked": True}

    # ── Position sizing ─────────────────────────────────────────────────────
    precision = get_symbol_precision(exchange_info, symbol)
    if use_auto_sizing:
        sizing = calculate_position_size(free_balance, mark_price, sl_price, leverage)
        order_qty = sizing["qty"]
        # Round to exchange precision
        import math
        step = 10 ** -precision["qty_precision"]
        order_qty = math.floor(order_qty / step) * step
        order_qty = round(order_qty, precision["qty_precision"])
    else:
        if qty is None:
            return {"error": "qty is required when use_auto_sizing=False"}
        order_qty = qty

    if order_qty <= 0:
        return {"error": "Calculated qty is 0 — insufficient balance or SL too tight"}

    order_side = "BUY" if side == "LONG" else "SELL"
    sl_side = "SELL" if side == "LONG" else "BUY"
    tp_side = "SELL" if side == "LONG" else "BUY"
    sl_type = "STOP_MARKET"
    tp_type = "TAKE_PROFIT_MARKET"

    sl_price_r = round(sl_price, precision["price_precision"])
    tp_price_r = round(tp_price, precision["price_precision"])

    log.info(
        f"Placing {side} {symbol}: qty={order_qty} entry~{mark_price} "
        f"SL={sl_price_r} TP={tp_price_r} lev={leverage}x"
    )

    results = {}
    with _client() as c:
        # Set leverage + margin type
        try:
            c.change_leverage(symbol, leverage)
        except BinanceAPIError as e:
            log.warning(f"Leverage set skipped: {e}")
        try:
            c.change_margin_type(symbol, margin_type)
        except BinanceAPIError as e:
            log.warning(f"Margin type set skipped (already set?): {e}")

        # Market entry
        entry = c.place_order(
            symbol=symbol,
            side=order_side,
            type="MARKET",
            quantity=order_qty,
            reduceOnly=False,
        )
        results["entry"] = entry

        # Stop-loss
        try:
            sl_order = c.place_order(
                symbol=symbol,
                side=sl_side,
                type=sl_type,
                stopPrice=sl_price_r,
                closePosition=True,
                timeInForce="GTC",
            )
            results["stop_loss"] = sl_order
        except BinanceAPIError as e:
            results["stop_loss_error"] = str(e)
            log.error(f"SL placement failed for {symbol}: {e}")

        # Take-profit
        try:
            tp_order = c.place_order(
                symbol=symbol,
                side=tp_side,
                type=tp_type,
                stopPrice=tp_price_r,
                closePosition=True,
                timeInForce="GTC",
            )
            results["take_profit"] = tp_order
        except BinanceAPIError as e:
            results["take_profit_error"] = str(e)
            log.error(f"TP placement failed for {symbol}: {e}")

    results["summary"] = {
        "symbol": symbol,
        "side": side,
        "qty": order_qty,
        "entry_price_approx": mark_price,
        "sl": sl_price_r,
        "tp": tp_price_r,
        "leverage": leverage,
        "risk_usdt": round(free_balance * 0.02, 2),
    }

    return results


@mcp.tool()
def close_position(symbol: str) -> dict:
    """
    Immediately close an open futures position at market price.
    Also cancels any pending SL/TP orders for the symbol.

    Args:
        symbol: e.g. "BTCUSDT"
    """
    with _client() as c:
        # Cancel pending SL/TP orders first
        try:
            cancelled = c.cancel_all_orders(symbol)
        except BinanceAPIError as e:
            cancelled = {"error": str(e)}

        result = c.close_position(symbol)

    return {
        "symbol": symbol,
        "close_result": result,
        "cancelled_orders": cancelled,
    }


@mcp.tool()
def cancel_order(symbol: str, order_id: int) -> dict:
    """
    Cancel a specific open order by ID.

    Args:
        symbol: e.g. "BTCUSDT"
        order_id: integer order ID from Binance
    """
    with _client() as c:
        return c.cancel_order(symbol, order_id)


@mcp.tool()
def cancel_all_orders(symbol: str) -> dict:
    """
    Cancel ALL open orders for a symbol (SL, TP, limit orders).

    Args:
        symbol: e.g. "BTCUSDT"
    """
    with _client() as c:
        return c.cancel_all_orders(symbol)


@mcp.tool()
def set_leverage(symbol: str, leverage: int) -> dict:
    """
    Set leverage for a symbol before placing an order.

    Args:
        symbol: e.g. "BTCUSDT"
        leverage: integer 1–20
    """
    if leverage > 20:
        return {"error": "Max leverage enforced: 20"}
    with _client() as c:
        return c.change_leverage(symbol, leverage)

# ═══════════════════════════════════════════════════════════════════════════
# MONITORING TOOLS
# ═══════════════════════════════════════════════════════════════════════════

@mcp.tool()
def monitor_positions() -> dict:
    """
    Health check all open positions. Returns status, action recommendations,
    and total portfolio PnL. Call this on cron to detect positions needing action.
    """
    with _client() as c:
        all_positions = c.get_position_risk()
        account = c.get_account()

    open_pos = [p for p in all_positions if float(p.get("positionAmt", 0)) != 0]

    if not open_pos:
        return {"open_positions": 0, "message": "No open positions.", "actions_required": []}

    total_pnl = 0.0
    actions_required = []
    position_details = []

    for p in open_pos:
        fmt = _fmt_pos(p)
        health = check_position_health(p)
        fmt.update(health)
        position_details.append(fmt)
        total_pnl += fmt["unrealized_pnl"]

        if health["action"] != "HOLD":
            actions_required.append({
                "symbol": fmt["symbol"],
                "action": health["action"],
                "reason": health["reason"],
                "unrealized_pnl": fmt["unrealized_pnl"],
            })

    return {
        "open_positions": len(open_pos),
        "total_unrealized_pnl": round(total_pnl, 4),
        "available_balance": float(account.get("availableBalance", 0)),
        "actions_required": actions_required,
        "positions": position_details,
    }


@mcp.tool()
def get_trade_history(limit: int = 20) -> list:
    """
    Get recent realized income (trades, funding, commissions).

    Args:
        limit: number of records (max 1000)
    """
    with _client() as c:
        return c.get_income_history(limit)


if __name__ == "__main__":
    log.info("Starting Binance Futures MCP Server...")
    mcp.run(transport="stdio")
