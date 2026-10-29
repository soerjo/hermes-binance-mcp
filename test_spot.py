"""
Unit tests for Binance Spot API methods and MCP tools.
"""

import os
import unittest
from unittest.mock import MagicMock, patch

# Provide dummy env vars for client initialization
os.environ["BINANCE_API_KEY"] = "dummy_api_key_for_testing"
os.environ["BINANCE_API_SECRET"] = "dummy_api_secret_for_testing"

from client import BinanceClient
import server


class TestSpotClient(unittest.TestCase):
    def setUp(self):
        self.client = BinanceClient()

    def tearDown(self):
        self.client.close()

    @patch.object(BinanceClient, "_spot_get")
    def test_get_spot_account_filters_non_zero(self, mock_get):
        mock_get.return_value = {
            "accountType": "SPOT",
            "canTrade": True,
            "balances": [
                {"asset": "BTC", "free": "0.5000", "locked": "0.0000"},
                {"asset": "ETH", "free": "0.0000", "locked": "1.2000"},
                {"asset": "SOL", "free": "0.0000", "locked": "0.0000"},
            ],
        }

        res = self.client.get_spot_account(non_zero_only=True)
        mock_get.assert_called_once_with("/api/v3/account", signed=True)
        self.assertEqual(len(res["balances"]), 2)
        assets = [b["asset"] for b in res["balances"]]
        self.assertIn("BTC", assets)
        self.assertIn("ETH", assets)
        self.assertNotIn("SOL", assets)

    @patch.object(BinanceClient, "_spot_get")
    def test_get_spot_open_orders(self, mock_get):
        mock_get.return_value = [{"symbol": "BTCUSDT", "orderId": 12345}]

        res = self.client.get_spot_open_orders("btcusdt")
        mock_get.assert_called_once_with(
            "/api/v3/openOrders", params={"symbol": "BTCUSDT"}, signed=True
        )
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["orderId"], 12345)

    @patch.object(BinanceClient, "_spot_get")
    def test_get_spot_ticker(self, mock_get):
        mock_get.return_value = {"symbol": "BTCUSDT", "price": "65000.00"}

        res = self.client.get_spot_ticker("BTCUSDT")
        mock_get.assert_called_once_with(
            "/api/v3/ticker/price", params={"symbol": "BTCUSDT"}, signed=False
        )
        self.assertEqual(res["price"], "65000.00")

    @patch.object(BinanceClient, "_spot_post")
    def test_create_spot_order(self, mock_post):
        mock_post.return_value = {"orderId": 999, "status": "FILLED"}

        res = self.client.create_spot_order(
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=0.01,
            price=60000.0,
            time_in_force="GTC",
        )
        mock_post.assert_called_once_with(
            "/api/v3/order",
            params={
                "symbol": "BTCUSDT",
                "side": "BUY",
                "type": "LIMIT",
                "quantity": 0.01,
                "price": 60000.0,
                "timeInForce": "GTC",
            },
            signed=True,
        )
        self.assertEqual(res["orderId"], 999)

    @patch.object(BinanceClient, "_spot_delete")
    def test_cancel_spot_order(self, mock_delete):
        mock_delete.return_value = {"orderId": 999, "status": "CANCELED"}

        res = self.client.cancel_spot_order("BTCUSDT", order_id=999)
        mock_delete.assert_called_once_with(
            "/api/v3/order",
            params={"symbol": "BTCUSDT", "orderId": 999},
            signed=True,
        )
        self.assertEqual(res["status"], "CANCELED")


class TestSpotServerTools(unittest.TestCase):
    @patch.object(BinanceClient, "get_spot_account")
    @patch.object(BinanceClient, "get_spot_ticker")
    def test_get_spot_account_status_valuation(self, mock_ticker, mock_account):
        mock_account.return_value = {
            "accountType": "SPOT",
            "canTrade": True,
            "canWithdraw": True,
            "canDeposit": True,
            "balances": [
                {"asset": "USDT", "free": "100.0", "locked": "0.0"},
                {"asset": "BTC", "free": "0.1", "locked": "0.0"},
            ],
        }
        mock_ticker.return_value = [
            {"symbol": "BTCUSDT", "price": "60000.00"},
        ]

        status = server.get_spot_account_status()
        self.assertNotIn("error", status)
        self.assertEqual(status["account_type"], "SPOT")
        self.assertEqual(status["balances_count"], 2)

        # BTC: 0.1 * 60000 = 6000 USDT. USDT: 100 USDT. Total = 6100 USDT.
        self.assertEqual(status["total_estimated_usdt"], 6100.0)

        # BTC should be first because its estimated USDT value is higher
        self.assertEqual(status["balances"][0]["asset"], "BTC")
        self.assertEqual(status["balances"][0]["estimated_usdt"], 6000.0)
        self.assertEqual(status["balances"][1]["asset"], "USDT")
        self.assertEqual(status["balances"][1]["estimated_usdt"], 100.0)

    @patch.object(BinanceClient, "get_spot_open_orders")
    def test_get_spot_open_orders_tool(self, mock_orders):
        mock_orders.return_value = [
            {
                "symbol": "BTCUSDT",
                "orderId": 123456,
                "clientOrderId": "order_1",
                "price": "62000.00",
                "origQty": "0.05",
                "executedQty": "0.00",
                "status": "NEW",
                "type": "LIMIT",
                "side": "BUY",
                "timeInForce": "GTC",
                "time": 1700000000000,
            }
        ]

        res = server.get_spot_open_orders("BTCUSDT")
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["symbol"], "BTCUSDT")
        self.assertEqual(res[0]["price"], 62000.0)
        self.assertEqual(res[0]["orig_qty"], 0.05)


if __name__ == "__main__":
    unittest.main()
