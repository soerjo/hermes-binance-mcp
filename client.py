"""
Binance Futures REST client (USDT-M, fapi.binance.com).
All signing, timestamping, and error-handling are centralised here.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

BASE_URL = "https://fapi.binance.com"
RECV_WINDOW = 5000  # ms


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------

class BinanceAPIError(Exception):
    """Raised when Binance returns a non-2xx response or an error payload."""

    def __init__(self, code: int, msg: str) -> None:
        self.code = code
        self.msg = msg
        super().__init__(f"BinanceAPIError code={code}: {msg}")


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class BinanceClient:
    """
    Thin synchronous wrapper around the Binance USDT-M Futures REST API.

    Credentials are read from the environment:
        BINANCE_API_KEY
        BINANCE_API_SECRET
    """

    def __init__(self) -> None:
        self._api_key: str = os.environ["BINANCE_API_KEY"]
        self._api_secret: str = os.environ["BINANCE_API_SECRET"]
        # Optional HTTP/HTTPS proxy — set HTTPS_PROXY or BINANCE_PROXY env var
        _proxy = os.environ.get("BINANCE_PROXY") or os.environ.get("HTTPS_PROXY") or None
        self._http = httpx.Client(
            base_url=BASE_URL,
            timeout=10.0,
            headers={
                "X-MBX-APIKEY": self._api_key,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            proxy=_proxy,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _sign(self, params: dict[str, Any]) -> dict[str, Any]:
        """Add timestamp + recvWindow then append HMAC-SHA256 signature."""
        params["timestamp"] = int(time.time() * 1000)
        params["recvWindow"] = RECV_WINDOW
        query = urlencode(params)
        signature = hmac.new(
            self._api_secret.encode("utf-8"),
            query.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        params["signature"] = signature
        return params

    def _get(
        self,
        path: str,
        params: Optional[dict[str, Any]] = None,
        signed: bool = False,
    ) -> Any:
        params = params or {}
        if signed:
            params = self._sign(params)
        logger.debug("GET %s params=%s", path, params)
        resp = self._http.get(path, params=params)
        return self._handle(resp)

    def _post(
        self,
        path: str,
        params: Optional[dict[str, Any]] = None,
        signed: bool = False,
    ) -> Any:
        params = params or {}
        if signed:
            params = self._sign(params)
        logger.debug("POST %s params=%s", path, params)
        resp = self._http.post(path, data=params)
        return self._handle(resp)

    def _delete(
        self,
        path: str,
        params: Optional[dict[str, Any]] = None,
        signed: bool = False,
    ) -> Any:
        params = params or {}
        if signed:
            params = self._sign(params)
        logger.debug("DELETE %s params=%s", path, params)
        resp = self._http.request("DELETE", path, params=params)
        return self._handle(resp)

    @staticmethod
    def _handle(resp: httpx.Response) -> Any:
        try:
            data = resp.json()
        except Exception:
            resp.raise_for_status()
            return resp.text

        # Binance error payloads always contain 'code' < 0
        if isinstance(data, dict) and data.get("code", 0) < 0:
            raise BinanceAPIError(data["code"], data.get("msg", "unknown error"))

        if not resp.is_success:
            raise BinanceAPIError(resp.status_code, resp.text)

        return data

    # ------------------------------------------------------------------
    # Public / market endpoints (unsigned)
    # ------------------------------------------------------------------

    def get_server_time(self) -> dict[str, Any]:
        """Return Binance server timestamp."""
        return self._get("/fapi/v1/time")

    def get_exchange_info(self) -> dict[str, Any]:
        """Return exchange metadata: symbols, filters, rate limits, etc."""
        return self._get("/fapi/v1/exchangeInfo")

    def get_klines(
        self,
        symbol: str,
        interval: str,
        limit: int = 200,
    ) -> list[list[Any]]:
        """
        Return OHLCV candlestick data.

        Each element: [open_time, open, high, low, close, volume,
                       close_time, quote_volume, trades,
                       taker_buy_base_vol, taker_buy_quote_vol, ignore]
        """
        return self._get(
            "/fapi/v1/klines",
            params={"symbol": symbol, "interval": interval, "limit": limit},
        )

    def get_ticker_24hr(
        self, symbol: Optional[str] = None
    ) -> dict[str, Any] | list[dict[str, Any]]:
        """Return 24-hour rolling price statistics (single or all symbols)."""
        params: dict[str, Any] = {}
        if symbol:
            params["symbol"] = symbol
        return self._get("/fapi/v1/ticker/24hr", params=params)

    def get_book_ticker(self, symbol: str) -> dict[str, Any]:
        """Return best bid/ask price and quantity for *symbol*."""
        return self._get("/fapi/v1/ticker/bookTicker", params={"symbol": symbol})

    def get_mark_price(
        self, symbol: Optional[str] = None
    ) -> dict[str, Any] | list[dict[str, Any]]:
        """Return mark price, index price, funding rate, and next funding countdown."""
        params: dict[str, Any] = {}
        if symbol:
            params["symbol"] = symbol
        return self._get("/fapi/v1/premiumIndex", params=params)

    # ------------------------------------------------------------------
    # Account / signed endpoints
    # ------------------------------------------------------------------

    def get_account(self) -> dict[str, Any]:
        """Return account info: balances, positions, and margin summary."""
        return self._get("/fapi/v2/account", signed=True)

    def get_position_risk(
        self, symbol: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """Return open positions with unrealized PnL and leverage details."""
        params: dict[str, Any] = {}
        if symbol:
            params["symbol"] = symbol
        return self._get("/fapi/v2/positionRisk", params=params, signed=True)

    def get_open_orders(
        self, symbol: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """Return all open orders, optionally filtered by *symbol*."""
        params: dict[str, Any] = {}
        if symbol:
            params["symbol"] = symbol
        return self._get("/fapi/v1/openOrders", params=params, signed=True)

    def get_income_history(self, limit: int = 50) -> list[dict[str, Any]]:
        """Return recent income history (realised PnL, funding, commissions)."""
        return self._get(
            "/fapi/v1/income",
            params={"limit": limit},
            signed=True,
        )

    # ------------------------------------------------------------------
    # Order / position management
    # ------------------------------------------------------------------

    def change_leverage(self, symbol: str, leverage: int) -> dict[str, Any]:
        """Set the initial leverage for *symbol* (1-125)."""
        return self._post(
            "/fapi/v1/leverage",
            params={"symbol": symbol, "leverage": leverage},
            signed=True,
        )

    def change_margin_type(self, symbol: str, margin_type: str) -> dict[str, Any]:
        """
        Switch margin type for *symbol*.

        *margin_type*: ``"ISOLATED"`` or ``"CROSSED"``
        """
        margin_type = margin_type.upper()
        if margin_type not in ("ISOLATED", "CROSSED"):
            raise ValueError(
                f"margin_type must be ISOLATED or CROSSED, got {margin_type!r}"
            )
        return self._post(
            "/fapi/v1/marginType",
            params={"symbol": symbol, "marginType": margin_type},
            signed=True,
        )

    def place_order(self, **kwargs: Any) -> dict[str, Any]:
        """
        Place any order type on Binance Futures.

        Required kwargs: ``symbol``, ``side``, ``type``.
        Optional kwargs follow the Binance Futures REST spec verbatim
        (e.g. ``quantity``, ``price``, ``timeInForce``, ``positionSide``,
        ``stopPrice``, ``closePosition``, ``reduceOnly``, etc.).
        """
        return self._post("/fapi/v1/order", params=dict(kwargs), signed=True)

    def cancel_order(self, symbol: str, order_id: int) -> dict[str, Any]:
        """Cancel a single order by *order_id*."""
        return self._delete(
            "/fapi/v1/order",
            params={"symbol": symbol, "orderId": order_id},
            signed=True,
        )

    def cancel_all_orders(self, symbol: str) -> dict[str, Any]:
        """Cancel *all* open orders for *symbol*."""
        return self._delete(
            "/fapi/v1/allOpenOrders",
            params={"symbol": symbol},
            signed=True,
        )

    def close_position(
        self,
        symbol: str,
        position_side: str = "BOTH",
    ) -> dict[str, Any]:
        """
        Market-close an open position.

        Queries current position risk to determine size and direction,
        then submits a reducing market order.

        *position_side*: ``"BOTH"`` (one-way mode), ``"LONG"``, or ``"SHORT"``
                         (hedge mode).
        """
        position_side = position_side.upper()
        positions = self.get_position_risk(symbol=symbol)

        # Locate the matching position entry
        target: Optional[dict[str, Any]] = None
        for pos in positions:
            if pos.get("symbol") != symbol:
                continue
            if position_side == "BOTH":
                # One-way mode: match the first non-zero quantity entry
                if float(pos.get("positionAmt", 0)) != 0:
                    target = pos
                    break
            else:
                if pos.get("positionSide") == position_side:
                    target = pos
                    break

        if target is None:
            raise BinanceAPIError(
                -1, f"No open {position_side} position found for {symbol}"
            )

        qty = float(target["positionAmt"])
        if qty == 0:
            raise BinanceAPIError(-1, f"Position for {symbol} has zero quantity")

        # Closing side is opposite to current exposure
        close_side = "SELL" if qty > 0 else "BUY"
        abs_qty = abs(qty)

        order_params: dict[str, Any] = {
            "symbol": symbol,
            "side": close_side,
            "type": "MARKET",
            "quantity": abs_qty,
            "reduceOnly": "true",
        }
        if position_side != "BOTH":
            # reduceOnly is incompatible with explicit positionSide in hedge mode
            del order_params["reduceOnly"]
            order_params["positionSide"] = position_side

        logger.debug(
            "close_position %s side=%s qty=%s", symbol, close_side, abs_qty
        )
        return self.place_order(**order_params)

    # ------------------------------------------------------------------
    # Context-manager support
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._http.close()

    def __enter__(self) -> "BinanceClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
