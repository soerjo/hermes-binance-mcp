"""
Thin synchronous wrapper around the Binance USDT-M Futures REST API.
Production Base URL: https://fapi.binance.com
"""

import hashlib
import hmac
import logging
import os
import time
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

BASE_URL: str = "https://fapi.binance.com"
RECV_WINDOW: int = 30000  # 30s to absorb VPN latency jitter


class BinanceAPIError(Exception):
    """Raised when the Binance API returns a non-2xx status or an error payload."""

    def __init__(self, code: int, msg: str) -> None:
        self.code = code
        self.msg = msg
        super().__init__(f"BinanceAPIError code={code}: {msg}")


def _clean_params(params: dict[str, Any]) -> dict[str, str]:
    """
    Format query parameters for Binance:
    - Booleans must be lowercase string 'true' / 'false'
    - None values stripped
    - All values converted to string
    """
    cleaned: dict[str, str] = {}
    for k, v in params.items():
        if v is None:
            continue
        if isinstance(v, bool):
            cleaned[k] = "true" if v else "false"
        else:
            cleaned[k] = str(v)
    return cleaned


class BinanceClient:
    """
    Synchronous wrapper around the Binance USDT-M Futures REST API.
    Credentials are read from environment: BINANCE_API_KEY, BINANCE_API_SECRET
    """

    def __init__(self) -> None:
        self._api_key: str = os.environ["BINANCE_API_KEY"]
        self._api_secret: str = os.environ["BINANCE_API_SECRET"]
        _proxy = os.environ.get("BINANCE_PROXY") or os.environ.get("HTTPS_PROXY") or None
        self._http = httpx.Client(
            base_url=BASE_URL,
            timeout=15.0,
            headers={
                "X-MBX-APIKEY": self._api_key,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            proxy=_proxy,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _sign(self, params: dict[str, Any]) -> str:
        """
        Add timestamp + recvWindow, format booleans, compute HMAC-SHA256.
        Returns the exact URL-encoded query string including signature.
        """
        cleaned = _clean_params(params)
        cleaned["timestamp"] = str(int(time.time() * 1000))
        cleaned["recvWindow"] = str(RECV_WINDOW)
        query = urlencode(cleaned)
        signature = hmac.new(
            self._api_secret.encode("utf-8"),
            query.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"{query}&signature={signature}"

    def _get(
        self,
        path: str,
        params: Optional[dict[str, Any]] = None,
        signed: bool = False,
    ) -> Any:
        params = params or {}
        if signed:
            full_query = self._sign(params)
            url = f"{path}?{full_query}"
            logger.debug("GET %s", url)
            resp = self._http.get(url)
        else:
            cleaned = _clean_params(params)
            resp = self._http.get(path, params=cleaned)
        return self._handle(resp)

    def _post(
        self,
        path: str,
        params: Optional[dict[str, Any]] = None,
        signed: bool = False,
    ) -> Any:
        params = params or {}
        if signed:
            full_query = self._sign(params)
            url = f"{path}?{full_query}"
            logger.debug("POST %s", url)
            resp = self._http.post(url)
        else:
            cleaned = _clean_params(params)
            resp = self._http.post(path, data=cleaned)
        return self._handle(resp)

    def _delete(
        self,
        path: str,
        params: Optional[dict[str, Any]] = None,
        signed: bool = False,
    ) -> Any:
        params = params or {}
        if signed:
            full_query = self._sign(params)
            url = f"{path}?{full_query}"
            logger.debug("DELETE %s", url)
            resp = self._http.delete(url)
        else:
            cleaned = _clean_params(params)
            resp = self._http.delete(path, params=cleaned)
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

        resp.raise_for_status()
        return data

    # ------------------------------------------------------------------
    # Public market data
    # ------------------------------------------------------------------

    def get_server_time(self) -> dict[str, Any]:
        """Check server connectivity and get current Binance server time."""
        return self._get("/fapi/v1/time")

    def get_exchange_info(self) -> dict[str, Any]:
        """Fetch current exchange trading rules and symbol information."""
        return self._get("/fapi/v1/exchangeInfo")

    def get_klines(
        self,
        symbol: str,
        interval: str,
        limit: int = 200,
    ) -> list[list[Any]]:
        """Fetch historical klines (candlestick) data."""
        return self._get(
            "/fapi/v1/klines",
            params={"symbol": symbol, "interval": interval, "limit": limit},
        )

    def get_ticker_24hr(
        self,
        symbol: Optional[str] = None,
    ) -> Any:
        """Fetch 24-hour rolling window price change statistics."""
        params = {"symbol": symbol} if symbol else {}
        return self._get("/fapi/v1/ticker/24hr", params=params)

    def get_book_ticker(self, symbol: str) -> dict[str, Any]:
        """Fetch best price/qty on the order book for a symbol."""
        return self._get("/fapi/v1/ticker/bookTicker", params={"symbol": symbol})

    def get_mark_price(
        self,
        symbol: Optional[str] = None,
    ) -> Any:
        """Fetch mark price and funding rate."""
        params = {"symbol": symbol} if symbol else {}
        return self._get("/fapi/v1/premiumIndex", params=params)

    # ------------------------------------------------------------------
    # Account & Position (SIGNED)
    # ------------------------------------------------------------------

    def get_account(self) -> dict[str, Any]:
        """Fetch current account information (balances, margin, canTrade)."""
        return self._get("/fapi/v2/account", signed=True)

    def get_position_risk(
        self,
        symbol: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Fetch current position information with unrealized PnL."""
        params = {"symbol": symbol} if symbol else {}
        return self._get("/fapi/v2/positionRisk", params=params, signed=True)

    def get_open_orders(
        self,
        symbol: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Fetch all open standard orders."""
        params = {"symbol": symbol} if symbol else {}
        return self._get("/fapi/v1/openOrders", params=params, signed=True)

    def get_income_history(self, limit: int = 50) -> list[dict[str, Any]]:
        """Fetch income history (realized PnL, funding fees, commissions)."""
        return self._get(
            "/fapi/v1/income",
            params={"limit": limit},
            signed=True,
        )

    # ------------------------------------------------------------------
    # Standard Order Management (SIGNED)
    # ------------------------------------------------------------------

    def change_leverage(self, symbol: str, leverage: int) -> dict[str, Any]:
        """Change user's initial leverage of specific symbol market."""
        return self._post(
            "/fapi/v1/leverage",
            params={"symbol": symbol, "leverage": leverage},
            signed=True,
        )

    def change_margin_type(self, symbol: str, margin_type: str) -> dict[str, Any]:
        """Change margin type to ISOLATED or CROSSED."""
        return self._post(
            "/fapi/v1/marginType",
            params={"symbol": symbol, "marginType": margin_type},
            signed=True,
        )

    def place_order(self, **kwargs: Any) -> dict[str, Any]:
        """
        Place standard order on Binance Futures (MARKET, LIMIT).
        """
        return self._post("/fapi/v1/order", params=dict(kwargs), signed=True)

    def cancel_order(self, symbol: str, order_id: int) -> dict[str, Any]:
        """Cancel a single standard order by order_id."""
        return self._delete(
            "/fapi/v1/order",
            params={"symbol": symbol, "orderId": order_id},
            signed=True,
        )

    def cancel_all_orders(self, symbol: str) -> dict[str, Any]:
        """Cancel all open standard orders for symbol."""
        return self._delete(
            "/fapi/v1/allOpenOrders",
            params={"symbol": symbol},
            signed=True,
        )

    # ------------------------------------------------------------------
    # Algo & Conditional Order Management (SIGNED)
    # Required for STOP_MARKET, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET
    # ------------------------------------------------------------------

    def place_algo_order(self, **kwargs: Any) -> dict[str, Any]:
        """Place a conditional order (STOP_MARKET, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET)."""
        return self._post("/fapi/v1/algoOrder", params=dict(kwargs), signed=True)

    def cancel_algo_order(self, symbol: str, algo_id: int) -> dict[str, Any]:
        """Cancel a conditional algo order by algoId."""
        return self._delete(
            "/fapi/v1/algoOrder",
            params={"symbol": symbol, "algoId": algo_id},
            signed=True,
        )

    def get_open_algo_orders(
        self,
        symbol: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Fetch open conditional algo orders."""
        params = {"symbol": symbol} if symbol else {}
        res = self._get("/fapi/v1/openAlgoOrders", params=params, signed=True)
        return res if isinstance(res, list) else res.get("orders", [])

    def close_position(
        self,
        symbol: str,
        position_side: str = "BOTH",
    ) -> dict[str, Any]:
        """
        Close an existing position at market price with reduceOnly=true.
        """
        positions = self.get_position_risk(symbol=symbol)
        pos = next(
            (p for p in positions if p.get("symbol") == symbol and float(p.get("positionAmt", 0)) != 0),
            None,
        )
        if pos is None:
            return {"symbol": symbol, "status": "NO_OPEN_POSITION"}

        amt = float(pos["positionAmt"])
        side = "SELL" if amt > 0 else "BUY"
        qty = abs(amt)

        return self.place_order(
            symbol=symbol,
            side=side,
            type="MARKET",
            quantity=qty,
            reduceOnly=True,
        )

    # ------------------------------------------------------------------
    # Context manager & cleanup
    # ------------------------------------------------------------------

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "BinanceClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
