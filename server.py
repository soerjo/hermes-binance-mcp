"""
Binance Futures MCP Server for Hermes Agent
MCP 2.x — MCPServer with dual transport: stdio (subprocess) or SSE (container).

Transport selection via env var:
  MCP_TRANSPORT=stdio  (default, for Hermes subprocess mode)
  MCP_TRANSPORT=sse    (for container/HTTP mode)
  MCP_PORT=8811        (SSE port, default 8811)
  MCP_HOST=0.0.0.0     (SSE bind host)

Env required:
  BINANCE_API_KEY, BINANCE_API_SECRET
"""

import asyncio
import logging
import os
import sys
import time
from typing import Optional

from mcp.server.mcpserver import MCPServer
from client import BinanceClient, BinanceAPIError
from analysis import analyze_symbol, calculate_sl_tp, score_opportunity
from risk import (
    RiskError,
    MAX_LEVERAGE,
    check_pre_trade,
    check_position_health,
    calculate_position_size,
    get_symbol_precision,
)

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    stream=sys.stderr,
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("binance-mcp")

# ── Config from env ───────────────────────────────────────────────────────────
SCAN_TOP_N      = int(os.getenv("SCAN_TOP_N", "15"))
SCAN_INTERVAL   = os.getenv("SCAN_INTERVAL", "15m")
DEFAULT_LEVERAGE = int(os.getenv("DEFAULT_LEVERAGE", "5"))
RISK_REWARD     = float(os.getenv("RISK_REWARD", "2.0"))
MCP_TRANSPORT   = os.getenv("MCP_TRANSPORT", "stdio")
MCP_PORT        = int(os.getenv("MCP_PORT", "8811"))
MCP_HOST        = os.getenv("MCP_HOST", "0.0.0.0")

mcp = MCPServer("binance-futures", version="1.0.0")

import functools

def safe_tool(fn):
    """Decorator to catch exceptions and return a clean dict instead of crashing FastMCP."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except BinanceAPIError as e:
            return {"error": f"Binance API error: {e}"}
        except RiskError as e:
            return {"error": f"Risk rule blocked: {e}"}
        except Exception as e:
            log.exception(f"Tool {fn.__name__} failed: {e}")
            return {"error": f"Error: {e}"}
    return wrapper


# ── Helpers ───────────────────────────────────────────────────────────────────

def _client() -> BinanceClient:
    return BinanceClient()


def _fmt_pos(p: dict) -> dict:
    return {
        "symbol":         p.get("symbol"),
        "side":           p.get("positionSide", p.get("side")),
        "entry_price":    float(p.get("entryPrice", 0)),
        "mark_price":     float(p.get("markPrice", 0)),
        "qty":            float(p.get("positionAmt", 0)),
        "unrealized_pnl": float(p.get("unRealizedProfit", 0)),
        "leverage":       int(p.get("leverage", 1)),
        "margin_type":    p.get("marginType"),
        "initial_margin": float(p.get("initialMargin", 0)),
    }

# ═══════════════════════════════════════════════════════════════════════════════
# MARKET DATA TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
@safe_tool
def get_futures_market(symbol: str, interval: str = "4h", limit: int = 200) -> dict:
    """
    Fetch OHLCV klines + 24h ticker + mark price for a single symbol.

    Args:
        symbol: e.g. "BTCUSDT"
        interval: kline interval e.g. "1h", "4h", "1d"
        limit: number of candles (max 1500)
    """
    with _client() as c:
        klines = c.get_klines(symbol, interval, limit)
        ticker = c.get_ticker_24hr(symbol)
        mark   = c.get_mark_price(symbol)
        book   = c.get_book_ticker(symbol)
    return {"symbol": symbol, "interval": interval,
            "klines": klines, "ticker_24h": ticker,
            "mark_price": mark, "book_ticker": book}


@mcp.tool()
@safe_tool
def scan_market(
    top_n: int = SCAN_TOP_N,
    interval: str = SCAN_INTERVAL,
    min_volume_usdt: float = 50_000_000,
) -> dict:
    """
    Scan top futures markets by 24h volume, run TA, score and rank opportunities.

    Args:
        top_n: how many top-volume symbols to analyze
        interval: kline interval for analysis
        min_volume_usdt: minimum 24h volume filter (USDT)
    """
    with _client() as c:
        all_tickers = c.get_ticker_24hr()

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
                klines    = c.get_klines(sym, interval, 300)
                mark_data = c.get_mark_price(sym)
                funding_rate     = float(mark_data.get("lastFundingRate", 0))
                funding_countdown = int(mark_data.get("nextFundingTime", 0))
                analysis  = analyze_symbol(klines)
                score     = score_opportunity(analysis, funding_rate)
                results.append({
                    "symbol":             sym,
                    "price":              float(mark_data.get("markPrice", 0)),
                    "volume_24h_usdt":    float(next(
                        (t["quoteVolume"] for t in usdt_pairs if t["symbol"] == sym), 0)),
                    "funding_rate":       funding_rate,
                    "funding_countdown_ms": funding_countdown,
                    "signal":             analysis["signal"],
                    "confidence":         analysis["confidence"],
                    "score":              score,
                    "trend":              analysis["trend"],
                    "rsi":                analysis["rsi"]["value"],
                    "macd_cross":         analysis["macd"]["cross"],
                    "atr":                analysis["atr"],
                    "analysis":           analysis,
                })
            except Exception as e:
                log.warning(f"Failed to analyze {sym}: {e}")

    results.sort(key=lambda r: r["score"], reverse=True)
    actionable = [r for r in results if r["signal"] != "SKIP"]
    return {
        "scanned":            len(results),
        "actionable":         len(actionable),
        "interval":           interval,
        "top_opportunities":  results[:10],
        "ranked_actionable":  actionable[:5],
    }


@mcp.tool()
@safe_tool
def analyze_market(symbol: str, interval: str = "15m") -> dict:
    """
    Full technical analysis on a symbol: RSI, MACD, EMA, Bollinger, ATR, trend, signal.

    Args:
        symbol: e.g. "BTCUSDT"
        interval: kline interval
    """
    with _client() as c:
        klines    = c.get_klines(symbol, interval, 300)
        mark_data = c.get_mark_price(symbol)

    funding_rate = float(mark_data.get("lastFundingRate", 0))
    analysis     = analyze_symbol(klines)
    score        = score_opportunity(analysis, funding_rate)
    sl_tp        = calculate_sl_tp(
        entry_price=float(mark_data.get("markPrice", 0)),
        side=analysis["signal"],
        atr=analysis["atr"],
        risk_reward=RISK_REWARD,
    )
    return {
        "symbol":        symbol,
        "interval":      interval,
        "mark_price":    float(mark_data.get("markPrice", 0)),
        "funding_rate":  funding_rate,
        "analysis":      analysis,
        "score":         score,
        "suggested_sl_tp": sl_tp,
    }


@mcp.tool()
@safe_tool
def get_funding_rates(symbols: Optional[list] = None) -> list:
    """
    Get current funding rates for given symbols, or top 20 by abs rate if none given.

    Args:
        symbols: list of symbol strings e.g. ["BTCUSDT", "ETHUSDT"]
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

# ═══════════════════════════════════════════════════════════════════════════════
# ACCOUNT TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
@safe_tool
def get_account_status() -> dict:
    """
    Get current Binance Futures account: balance, margin, open position count.
    Call this before placing any order.
    """
    with _client() as c:
        account = c.get_account()
    assets   = account.get("assets", [])
    usdt     = next((a for a in assets if a.get("asset") == "USDT"), {})
    open_pos = [p for p in account.get("positions", [])
                if float(p.get("positionAmt", 0)) != 0]
    return {
        "total_wallet_balance":   float(account.get("totalWalletBalance", 0)),
        "total_unrealized_pnl":   float(account.get("totalUnrealizedProfit", 0)),
        "total_margin_balance":   float(account.get("totalMarginBalance", 0)),
        "available_balance":      float(account.get("availableBalance", 0)),
        "usdt": {
            "wallet":        float(usdt.get("walletBalance", 0)),
            "available":     float(usdt.get("availableBalance", 0)),
            "unrealized_pnl": float(usdt.get("unrealizedProfit", 0)),
            "initial_margin": float(usdt.get("initialMargin", 0)),
        },
        "open_positions_count": len(open_pos),
        "can_trade":            account.get("canTrade", False),
    }


@mcp.tool()
@safe_tool
def get_open_positions() -> list:
    """
    All open futures positions with health check (OK/WARN/CRITICAL + action).
    """
    with _client() as c:
        all_pos = c.get_position_risk()
    open_pos = [p for p in all_pos if float(p.get("positionAmt", 0)) != 0]
    result = []
    for p in open_pos:
        fmt    = _fmt_pos(p)
        health = check_position_health(p)
        fmt.update(health)
        result.append(fmt)
    return result


@mcp.tool()
@safe_tool
def get_open_orders(symbol: Optional[str] = None) -> list:
    """
    Get all open orders (limit / stop / TP orders).

    Args:
        symbol: filter by symbol, or None for all symbols
    """
    with _client() as c:
        return c.get_open_orders(symbol)


@mcp.tool()
@safe_tool
def get_spot_account_status() -> dict:
    """
    Get current Binance Spot account status, non-zero coin balances,
    and estimated total value in USDT.
    """
    with _client() as c:
        account = c.get_spot_account(non_zero_only=True)
        raw_balances = account.get("balances", [])

        # Fetch tickers map for USDT conversion
        try:
            tickers = c.get_spot_ticker()
            price_map = (
                {t["symbol"]: float(t["price"]) for t in tickers if "symbol" in t and "price" in t}
                if isinstance(tickers, list)
                else {}
            )
        except Exception as e:
            log.warning(f"Failed to fetch spot tickers for valuation: {e}")
            price_map = {}

    stablecoins = {"USDT", "USDC", "BUSD", "FDUSD", "TUSD"}
    formatted_balances = []
    total_estimated_usdt = 0.0

    for b in raw_balances:
        asset = b.get("asset", "")
        free = float(b.get("free", 0))
        locked = float(b.get("locked", 0))
        total_qty = free + locked
        if total_qty <= 0:
            continue

        est_usdt = None
        if asset in stablecoins:
            est_usdt = total_qty
        else:
            pair = f"{asset}USDT"
            if pair in price_map:
                est_usdt = total_qty * price_map[pair]
            elif f"{asset}BTC" in price_map and "BTCUSDT" in price_map:
                est_usdt = total_qty * price_map[f"{asset}BTC"] * price_map["BTCUSDT"]

        if est_usdt is not None:
            total_estimated_usdt += est_usdt

        formatted_balances.append({
            "asset": asset,
            "free": free,
            "locked": locked,
            "total": total_qty,
            "estimated_usdt": round(est_usdt, 4) if est_usdt is not None else None,
        })

    # Sort balances by estimated USDT descending
    formatted_balances.sort(
        key=lambda x: x["estimated_usdt"] if x["estimated_usdt"] is not None else -1,
        reverse=True,
    )

    return {
        "account_type": account.get("accountType", "SPOT"),
        "can_trade": account.get("canTrade", False),
        "can_withdraw": account.get("canWithdraw", False),
        "can_deposit": account.get("canDeposit", False),
        "total_estimated_usdt": round(total_estimated_usdt, 2),
        "balances_count": len(formatted_balances),
        "balances": formatted_balances,
    }


@mcp.tool()
@safe_tool
def get_spot_open_orders(symbol: Optional[str] = None) -> list:
    """
    Get all open Spot orders.

    Args:
        symbol: optional filter by symbol e.g. "BTCUSDT"
    """
    with _client() as c:
        raw_orders = c.get_spot_open_orders(symbol=symbol)

    return [
        {
            "symbol": o.get("symbol"),
            "order_id": o.get("orderId"),
            "client_order_id": o.get("clientOrderId"),
            "price": float(o.get("price", 0)),
            "orig_qty": float(o.get("origQty", 0)),
            "executed_qty": float(o.get("executedQty", 0)),
            "status": o.get("status"),
            "type": o.get("type"),
            "side": o.get("side"),
            "time_in_force": o.get("timeInForce"),
            "time": o.get("time"),
        }
        for o in raw_orders
        if isinstance(o, dict)
    ]


@mcp.tool()
@safe_tool
def place_spot_order(
    symbol: str,
    side: str,
    order_type: str = "MARKET",
    qty: Optional[float] = None,
    quote_qty: Optional[float] = None,
    price: Optional[float] = None,
    time_in_force: Optional[str] = None,
) -> dict:
    """
    Place a Binance Spot order (BUY or SELL).

    Args:
        symbol: e.g. "BTCUSDT"
        side: "BUY" or "SELL"
        order_type: "MARKET" or "LIMIT"
        qty: base asset quantity (e.g. 0.01 BTC)
        quote_qty: quote asset quantity for MARKET orders (e.g. 50 USDT)
        price: limit order price
        time_in_force: e.g. "GTC", "IOC", "FOK" (defaults to GTC for LIMIT)
    """
    side_upper = side.upper()
    if side_upper not in ("BUY", "SELL"):
        return {"error": "side must be BUY or SELL"}

    type_upper = order_type.upper()
    if type_upper not in ("MARKET", "LIMIT"):
        return {"error": "order_type must be MARKET or LIMIT"}

    if type_upper == "LIMIT" and price is None:
        return {"error": "price is required for LIMIT orders"}

    if qty is None and quote_qty is None:
        return {"error": "Either qty or quote_qty must be specified"}

    with _client() as c:
        return c.create_spot_order(
            symbol=symbol,
            side=side_upper,
            order_type=type_upper,
            quantity=qty,
            quote_order_qty=quote_qty,
            price=price,
            time_in_force=time_in_force,
        )


@mcp.tool()
@safe_tool
def cancel_spot_order(
    symbol: str,
    order_id: Optional[int] = None,
    client_order_id: Optional[str] = None,
) -> dict:
    """
    Cancel an active Binance Spot order by order_id or client_order_id.

    Args:
        symbol: e.g. "BTCUSDT"
        order_id: Binance order ID
        client_order_id: Client order ID string
    """
    if order_id is None and not client_order_id:
        return {"error": "Either order_id or client_order_id must be provided"}

    with _client() as c:
        return c.cancel_spot_order(
            symbol=symbol,
            order_id=order_id,
            orig_client_order_id=client_order_id,
        )

# ═══════════════════════════════════════════════════════════════════════════════
# ORDER TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
@safe_tool
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
    Place a Binance Futures LONG or SHORT with auto position sizing, SL, and TP.
    Risk rules enforced automatically. Primary order execution tool.

    Args:
        symbol: e.g. "BTCUSDT"
        side: "LONG" or "SHORT"
        leverage: 1-10 (default 5)
        sl_price: stop-loss price (auto-calc from ATR if omitted)
        tp_price: take-profit price (auto-calc if omitted)
        qty: manual quantity (only if use_auto_sizing=False)
        use_auto_sizing: size by 2% risk rule automatically
        margin_type: "ISOLATED" or "CROSSED"
    """
    import math

    if leverage > MAX_LEVERAGE:
        return {"error": f"Max leverage is {MAX_LEVERAGE}. Risk rule enforced."}
    if side not in ("LONG", "SHORT"):
        return {"error": "side must be LONG or SHORT"}

    with _client() as c:
        account       = c.get_account()
        all_positions = c.get_position_risk()
        mark_data     = c.get_mark_price(symbol)
        exchange_info = c.get_exchange_info()

    open_positions      = [p for p in all_positions if float(p.get("positionAmt", 0)) != 0]
    funding_rate        = float(mark_data.get("lastFundingRate", 0))
    funding_countdown_ms = int(mark_data.get("nextFundingTime", 0))
    funding_countdown_s = max(0, (funding_countdown_ms - int(time.time() * 1000)) // 1000)
    mark_price          = float(mark_data.get("markPrice", 0))
    free_balance        = float(account.get("availableBalance", 0))

    # Auto SL/TP from ATR
    if sl_price is None or tp_price is None:
        with _client() as c:
            klines   = c.get_klines(symbol, "4h", 200)
        analysis = analyze_symbol(klines)
        sl_tp    = calculate_sl_tp(mark_price, side, analysis["atr"], RISK_REWARD)
        if sl_price is None:
            sl_price = sl_tp["sl"]
        if tp_price is None:
            tp_price = sl_tp["tp"]

    # Risk checks
    try:
        check_pre_trade(
            account=account,
            positions=open_positions,
            funding_rate=funding_rate,
            funding_countdown_seconds=funding_countdown_s,
            confidence=70,  # direct order = assume confident
        )
    except RiskError as e:
        return {"error": f"Risk rule blocked: {e}", "blocked": True}

    # Position sizing
    precision = get_symbol_precision(exchange_info, symbol)
    if use_auto_sizing:
        sizing    = calculate_position_size(free_balance, mark_price, sl_price, leverage)
        step      = 10 ** -precision["qty_precision"]
        order_qty = round(math.floor(sizing["qty"] / step) * step, precision["qty_precision"])
    else:
        if qty is None:
            return {"error": "qty required when use_auto_sizing=False"}
        order_qty = qty

    if order_qty <= 0:
        return {"error": "Calculated qty is 0 — check balance or widen SL"}

    order_side = "BUY"  if side == "LONG"  else "SELL"
    sl_side    = "SELL" if side == "LONG"  else "BUY"
    tp_side    = "SELL" if side == "LONG"  else "BUY"
    sl_price_r = round(sl_price, precision["price_precision"])
    tp_price_r = round(tp_price, precision["price_precision"])

    log.info(f"Placing {side} {symbol}: qty={order_qty} ~{mark_price} SL={sl_price_r} TP={tp_price_r} {leverage}x")

    results = {}
    with _client() as c:
        try:
            c.change_leverage(symbol, leverage)
        except BinanceAPIError as e:
            log.warning(f"Leverage skip: {e}")
        try:
            c.change_margin_type(symbol, margin_type)
        except BinanceAPIError as e:
            log.warning(f"Margin type skip: {e}")

        results["entry"] = c.place_order(
            symbol=symbol, side=order_side, type="MARKET",
            quantity=order_qty, reduceOnly=False,
        )
        # Stop-loss via Algo Order API
        try:
            results["stop_loss"] = c.place_algo_order(
                symbol=symbol,
                side=sl_side,
                type="STOP_MARKET",
                algoType="CONDITIONAL",
                triggerPrice=sl_price_r,
                quantity=order_qty,
                positionSide="BOTH",
                reduceOnly=True,
                workingType="CONTRACT_PRICE",
            )
        except BinanceAPIError as e:
            results["stop_loss_error"] = str(e)
            log.error(f"SL failed {symbol}: {e}")

        # Take-profit via Algo Order API
        try:
            results["take_profit"] = c.place_algo_order(
                symbol=symbol,
                side=tp_side,
                type="TAKE_PROFIT_MARKET",
                algoType="CONDITIONAL",
                triggerPrice=tp_price_r,
                quantity=order_qty,
                positionSide="BOTH",
                reduceOnly=True,
                workingType="CONTRACT_PRICE",
            )
        except BinanceAPIError as e:
            results["take_profit_error"] = str(e)
            log.error(f"TP failed {symbol}: {e}")

    results["summary"] = {
        "symbol": symbol, "side": side, "qty": order_qty,
        "entry_price_approx": mark_price, "sl": sl_price_r,
        "tp": tp_price_r, "leverage": leverage,
        "risk_usdt": round(free_balance * 0.02, 2),
    }
    return results


@mcp.tool()
@safe_tool
def close_position(symbol: str) -> dict:
    """
    Market-close an open position and cancel its pending SL/TP orders.

    Args:
        symbol: e.g. "BTCUSDT"
    """
    with _client() as c:
        try:
            cancelled = c.cancel_all_orders(symbol)
        except BinanceAPIError as e:
            cancelled = {"error": str(e)}
        result = c.close_position(symbol)
    return {"symbol": symbol, "close_result": result, "cancelled_orders": cancelled}


@mcp.tool()
@safe_tool
def partial_close_position(
    symbol: str,
    percentage: Optional[float] = 50.0,
    qty: Optional[float] = None,
    order_type: str = "MARKET",
    price: Optional[float] = None,
) -> dict:
    """
    Close a partial amount (e.g. 50%) or specific quantity of an EXISTING open position.
    Uses reduceOnly=True to guarantee no reverse position is opened.

    Args:
        symbol: e.g. "SUIUSDT", "1000PEPEUSDT", "PHAUSDT"
        percentage: percentage of position to close (e.g. 50.0 for 50%, 25.0, 75.0)
        qty: manual quantity override (used if percentage is None)
        order_type: "MARKET" (immediate execution) or "LIMIT" (at specific price)
        price: target limit price (required if order_type="LIMIT")
    """
    import math

    with _client() as c:
        positions = c.get_position_risk(symbol)
        exchange_info = c.get_exchange_info()

    open_pos = [p for p in positions if p.get("symbol") == symbol and float(p.get("positionAmt", 0)) != 0]
    if not open_pos:
        return {"error": f"No active open position found for {symbol}"}

    pos = open_pos[0]
    pos_amt = float(pos.get("positionAmt", 0))
    current_size = abs(pos_amt)
    side = "SELL" if pos_amt > 0 else "BUY"

    if percentage is not None:
        if percentage <= 0 or percentage > 100:
            return {"error": "percentage must be between 1 and 100"}
        raw_qty = current_size * (percentage / 100.0)
    elif qty is not None:
        raw_qty = qty
    else:
        return {"error": "Must provide either percentage or qty"}

    precision = get_symbol_precision(exchange_info, symbol)
    step = 10 ** -precision["qty_precision"]
    order_qty = round(math.floor(raw_qty / step) * step, precision["qty_precision"])

    if order_qty <= 0:
        return {"error": f"Calculated close qty {order_qty} is 0. Position size too small or precision issue."}

    order_params = {
        "symbol": symbol,
        "side": side,
        "type": order_type,
        "quantity": order_qty,
        "reduceOnly": True,
    }

    if order_type == "LIMIT":
        if price is None:
            return {"error": "price is required when order_type is LIMIT"}
        order_params["price"] = round(price, precision["price_precision"])
        order_params["timeInForce"] = "GTC"

    log.info(f"Partial closing {symbol}: {order_qty} (target ~{percentage}%) via {order_type}")

    with _client() as c:
        order_res = c.place_order(**order_params)

    remaining_approx = round(current_size - order_qty, precision["qty_precision"])
    return {
        "symbol": symbol,
        "action": "PARTIAL_CLOSE",
        "closed_qty": order_qty,
        "original_size": current_size,
        "remaining_size_approx": remaining_approx,
        "percentage_target": percentage,
        "side": side,
        "order_type": order_type,
        "order_result": order_res,
    }


@mcp.tool()
@safe_tool
def set_position_stop_loss(
    symbol: str,
    stop_price: float,
    cancel_existing_sl: bool = True,
) -> dict:
    """
    Set or update Stop Loss for an EXISTING open position.
    Uses Binance Futures Algo Order API (/fapi/v1/algoOrder) with STOP_MARKET.

    Args:
        symbol: e.g. "SUIUSDT", "1000PEPEUSDT", "PHAUSDT"
        stop_price: trigger price for the stop loss
        cancel_existing_sl: cancel existing STOP_MARKET algo orders first (default True)
    """
    with _client() as c:
        positions = c.get_position_risk(symbol)
        exchange_info = c.get_exchange_info()

    open_pos = [p for p in positions if p.get("symbol") == symbol and float(p.get("positionAmt", 0)) != 0]
    if not open_pos:
        return {"error": f"No active open position found for {symbol}"}

    pos = open_pos[0]
    pos_amt = float(pos.get("positionAmt", 0))
    pos_side = pos.get("positionSide", "BOTH")
    sl_side = "SELL" if pos_amt > 0 else "BUY"

    cancelled = []
    if cancel_existing_sl:
        with _client() as c:
            try:
                open_algos = c.get_open_algo_orders(symbol)
                for o in open_algos:
                    if o.get("orderType") in ("STOP_MARKET", "STOP"):
                        try:
                            c.cancel_algo_order(symbol, o["algoId"])
                            cancelled.append(o["algoId"])
                        except Exception as e:
                            log.warning(f"Failed to cancel old SL algo {o['algoId']}: {e}")
            except Exception as e:
                log.warning(f"Could not list open algos: {e}")

    precision = get_symbol_precision(exchange_info, symbol)
    stop_price_r = round(stop_price, precision["price_precision"])
    qty = abs(pos_amt)

    log.info(f"Setting Algo SL for {symbol} to {stop_price_r} (side={sl_side}, qty={qty})")

    with _client() as c:
        order_res = c.place_algo_order(
            symbol=symbol,
            side=sl_side,
            type="STOP_MARKET",
            algoType="CONDITIONAL",
            triggerPrice=stop_price_r,
            quantity=qty,
            positionSide=pos_side,
            reduceOnly=True,
            workingType="CONTRACT_PRICE",
        )

    return {
        "symbol": symbol,
        "action": "SET_STOP_LOSS",
        "new_stop_price": stop_price_r,
        "quantity": qty,
        "position_side": pos_side,
        "cancelled_previous_sl": cancelled,
        "order_result": order_res,
    }


@mcp.tool()
@safe_tool
def set_trailing_stop(
    symbol: str,
    callback_rate: float,
    activation_price: Optional[float] = None,
    quantity: Optional[float] = None,
    percentage: float = 100.0,
    cancel_existing_sl: bool = True,
) -> dict:
    """
    Place a native Binance TRAILING_STOP_MARKET algo order on an EXISTING open position.
    The stop price dynamically trails market price by `callback_rate` percent.

    Args:
        symbol: e.g. "SUIUSDT", "1000PEPEUSDT", "PHAUSDT"
        callback_rate: percentage to trail behind peak (0.1 to 5.0, e.g. 1.0 for 1%, 2.0 for 2%)
        activation_price: price level that must be reached before trailing activates (optional)
        quantity: manual quantity to trail (if None, derived from percentage)
        percentage: percentage of current position to protect with trailing stop (default 100.0)
        cancel_existing_sl: cancel prior stop orders so stops don't conflict (default True)
    """
    import math

    if callback_rate < 0.1 or callback_rate > 5.0:
        return {"error": "callback_rate must be between 0.1% and 5.0%"}

    with _client() as c:
        positions = c.get_position_risk(symbol)
        exchange_info = c.get_exchange_info()

    open_pos = [p for p in positions if p.get("symbol") == symbol and float(p.get("positionAmt", 0)) != 0]
    if not open_pos:
        return {"error": f"No active open position found for {symbol}"}

    pos = open_pos[0]
    pos_amt = float(pos.get("positionAmt", 0))
    pos_side = pos.get("positionSide", "BOTH")
    current_size = abs(pos_amt)
    side = "SELL" if pos_amt > 0 else "BUY"

    precision = get_symbol_precision(exchange_info, symbol)
    step = 10 ** -precision["qty_precision"]

    if quantity is not None:
        raw_qty = quantity
    else:
        raw_qty = current_size * (percentage / 100.0)

    order_qty = round(math.floor(raw_qty / step) * step, precision["qty_precision"])
    if order_qty <= 0:
        return {"error": "Calculated trailing stop qty is 0. Check size."}

    cancelled = []
    if cancel_existing_sl:
        with _client() as c:
            try:
                open_algos = c.get_open_algo_orders(symbol)
                for o in open_algos:
                    if o.get("orderType") in ("STOP_MARKET", "STOP", "TRAILING_STOP_MARKET"):
                        try:
                            c.cancel_algo_order(symbol, o["algoId"])
                            cancelled.append(o["algoId"])
                        except Exception as e:
                            log.warning(f"Failed to cancel old stop algo {o['algoId']}: {e}")
            except Exception as e:
                log.warning(f"Could not list open algos: {e}")

    params = {
        "symbol": symbol,
        "side": side,
        "type": "TRAILING_STOP_MARKET",
        "algoType": "CONDITIONAL",
        "quantity": order_qty,
        "callbackRate": round(callback_rate, 1),
        "positionSide": pos_side,
        "reduceOnly": True,
        "workingType": "CONTRACT_PRICE",
    }

    if activation_price is not None:
        params["activationPrice"] = round(activation_price, precision["price_precision"])

    log.info(f"Placing Trailing Stop Algo on {symbol}: qty={order_qty}, rate={callback_rate}%")

    with _client() as c:
        order_res = c.place_algo_order(**params)

    return {
        "symbol": symbol,
        "action": "SET_TRAILING_STOP",
        "callback_rate": callback_rate,
        "activation_price": activation_price,
        "quantity": order_qty,
        "position_side": pos_side,
        "cancelled_previous_sl": cancelled,
        "order_result": order_res,
    }


@mcp.tool()
@safe_tool
def set_position_take_profit(
    symbol: str,
    tp_price: float,
    percentage: float = 50.0,
    qty: Optional[float] = None,
    order_type: str = "TAKE_PROFIT_MARKET",
    cancel_existing_tp: bool = False,
) -> dict:
    """
    Set a Take Profit target on an EXISTING open position (supports partial TP e.g. 50%).

    Args:
        symbol: e.g. "SUIUSDT", "1000PEPEUSDT", "PHAUSDT"
        tp_price: target price to take profit
        percentage: percentage of position to TP (default 50.0 for partial TP)
        qty: manual quantity override
        order_type: "TAKE_PROFIT_MARKET" or "LIMIT"
        cancel_existing_tp: cancel prior TP orders for this symbol first (default False)
    """
    import math

    with _client() as c:
        positions = c.get_position_risk(symbol)
        exchange_info = c.get_exchange_info()

    open_pos = [p for p in positions if p.get("symbol") == symbol and float(p.get("positionAmt", 0)) != 0]
    if not open_pos:
        return {"error": f"No active open position found for {symbol}"}

    pos = open_pos[0]
    pos_amt = float(pos.get("positionAmt", 0))
    pos_side = pos.get("positionSide", "BOTH")
    current_size = abs(pos_amt)
    side = "SELL" if pos_amt > 0 else "BUY"

    precision = get_symbol_precision(exchange_info, symbol)
    step = 10 ** -precision["qty_precision"]

    if qty is not None:
        raw_qty = qty
    else:
        raw_qty = current_size * (percentage / 100.0)

    order_qty = round(math.floor(raw_qty / step) * step, precision["qty_precision"])
    if order_qty <= 0:
        return {"error": "Calculated TP qty is 0. Check size."}

    cancelled = []
    if cancel_existing_tp:
        with _client() as c:
            try:
                open_algos = c.get_open_algo_orders(symbol)
                for o in open_algos:
                    if o.get("orderType") in ("TAKE_PROFIT_MARKET", "TAKE_PROFIT"):
                        try:
                            c.cancel_algo_order(symbol, o["algoId"])
                            cancelled.append(o["algoId"])
                        except Exception as e:
                            log.warning(f"Failed to cancel old TP algo {o['algoId']}: {e}")
            except Exception as e:
                log.warning(f"Could not list open algos: {e}")

    tp_price_r = round(tp_price, precision["price_precision"])

    with _client() as c:
        if order_type == "LIMIT":
            order_res = c.place_order(
                symbol=symbol,
                side=side,
                type="LIMIT",
                price=tp_price_r,
                quantity=order_qty,
                timeInForce="GTC",
                reduceOnly=True,
            )
        else:
            order_res = c.place_algo_order(
                symbol=symbol,
                side=side,
                type="TAKE_PROFIT_MARKET",
                algoType="CONDITIONAL",
                triggerPrice=tp_price_r,
                quantity=order_qty,
                positionSide=pos_side,
                reduceOnly=True,
                workingType="CONTRACT_PRICE",
            )

    return {
        "symbol": symbol,
        "action": "SET_TAKE_PROFIT",
        "tp_price": tp_price_r,
        "quantity": order_qty,
        "percentage": percentage,
        "order_type": order_type,
        "cancelled_previous_tp": cancelled,
        "order_result": order_res,
    }


@mcp.tool()
@safe_tool
def cancel_order(symbol: str, order_id: int) -> dict:
    """Cancel a specific open order by ID."""
    with _client() as c:
        return c.cancel_order(symbol, order_id)


@mcp.tool()
@safe_tool
def cancel_all_orders(symbol: str) -> dict:
    """Cancel ALL open standard orders AND conditional algo orders for a symbol."""
    results = {}
    with _client() as c:
        try:
            results["standard_orders"] = c.cancel_all_orders(symbol)
        except Exception as e:
            results["standard_orders_error"] = str(e)

        cancelled_algos = []
        try:
            open_algos = c.get_open_algo_orders(symbol)
            for o in open_algos:
                try:
                    c.cancel_algo_order(symbol, o["algoId"])
                    cancelled_algos.append(o["algoId"])
                except Exception as e:
                    log.warning(f"Failed to cancel algo {o['algoId']}: {e}")
            results["cancelled_algo_orders"] = cancelled_algos
        except Exception as e:
            results["algo_orders_error"] = str(e)

    return {"symbol": symbol, "cancelled": results}


@mcp.tool()
@safe_tool
def set_leverage(symbol: str, leverage: int) -> dict:
    """Set leverage for a symbol (max 10)."""
    if leverage > MAX_LEVERAGE:
        return {"error": f"Max leverage enforced: {MAX_LEVERAGE}"}
    with _client() as c:
        return c.change_leverage(symbol, leverage)

# ═══════════════════════════════════════════════════════════════════════════════
# MONITORING TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
@safe_tool
def monitor_positions() -> dict:
    """
    Health check all open positions. Returns status, recommended actions,
    and total portfolio PnL. Run this on cron.
    """
    with _client() as c:
        all_positions = c.get_position_risk()
        account       = c.get_account()

    open_pos = [p for p in all_positions if float(p.get("positionAmt", 0)) != 0]
    if not open_pos:
        return {"open_positions": 0, "message": "No open positions.", "actions_required": []}

    total_pnl       = 0.0
    actions_required = []
    position_details = []

    for p in open_pos:
        fmt    = _fmt_pos(p)
        health = check_position_health(p)
        fmt.update(health)
        position_details.append(fmt)
        total_pnl += fmt["unrealized_pnl"]
        if health["action"] != "HOLD":
            actions_required.append({
                "symbol":         fmt["symbol"],
                "action":         health["action"],
                "reason":         health["reason"],
                "unrealized_pnl": fmt["unrealized_pnl"],
            })

    return {
        "open_positions":      len(open_pos),
        "total_unrealized_pnl": round(total_pnl, 4),
        "available_balance":   float(account.get("availableBalance", 0)),
        "actions_required":    actions_required,
        "positions":           position_details,
    }


@mcp.tool()
@safe_tool
def get_trade_history(limit: int = 20) -> list:
    """
    Get recent realized income (trades, funding, commissions).

    Args:
        limit: number of records (max 1000)
    """
    with _client() as c:
        return c.get_income_history(limit)


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRYPOINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    if MCP_TRANSPORT == "sse":
        log.info(f"Starting Binance Futures MCP Server (SSE) on {MCP_HOST}:{MCP_PORT}")
        asyncio.run(mcp.run_sse_async(host=MCP_HOST, port=MCP_PORT))
    else:
        log.info("Starting Binance Futures MCP Server (stdio)")
        asyncio.run(mcp.run_stdio_async())
