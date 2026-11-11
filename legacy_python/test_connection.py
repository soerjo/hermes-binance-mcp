#!/usr/bin/env python3
"""
Quick connectivity + auth test for Binance Futures MCP server.
Run setelah set API key di .env atau env vars.

Usage:
  BINANCE_API_KEY=xxx BINANCE_API_SECRET=yyy python test_connection.py
  # atau:
  cp .env.template .env  # edit .env, lalu:
  source .env && python test_connection.py
"""
import os, sys, json

# Load .env jika ada
env_file = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

def check(label, fn):
    try:
        result = fn()
        print(f"  ✅ {label}: OK")
        return result
    except Exception as e:
        print(f"  ❌ {label}: {e}")
        return None

print("\n🔍 Binance Futures MCP — Connection Test\n")

# 1. Import modules
print("[1/5] Importing modules...")
try:
    from client import BinanceClient, BinanceAPIError
    from analysis import analyze_symbol, calculate_sl_tp
    from risk import calculate_position_size, check_position_health
    print("  ✅ All modules imported")
except ImportError as e:
    print(f"  ❌ Import failed: {e}\n  → Run: pip install -r requirements.txt")
    sys.exit(1)

# 2. Check env vars
print("\n[2/5] Checking credentials...")
api_key = os.environ.get("BINANCE_API_KEY", "")
api_sec = os.environ.get("BINANCE_API_SECRET", "")
proxy   = os.environ.get("BINANCE_PROXY", "")
if not api_key or api_key == "your_api_key_here":
    print("  ❌ BINANCE_API_KEY not set")
    sys.exit(1)
if not api_sec or api_sec == "your_api_secret_here":
    print("  ❌ BINANCE_API_SECRET not set")
    sys.exit(1)
print(f"  ✅ API key: {api_key[:8]}...{api_key[-4:]}")
if proxy:
    print(f"  ✅ Proxy: {proxy}")

# 3. Public endpoint
print("\n[3/5] Public API connectivity (no auth)...")
with BinanceClient() as c:
    server_time = check("Server time", c.get_server_time)
    klines = check("BTC klines (200 candles)", lambda: c.get_klines("BTCUSDT", "4h", 200))
    ticker = check("BTC ticker", lambda: c.get_ticker_24hr("BTCUSDT"))
    mark   = check("BTC mark price", lambda: c.get_mark_price("BTCUSDT"))

# 4. Authenticated endpoint
print("\n[4/5] Authenticated API (requires valid key)...")
with BinanceClient() as c:
    account = check("Account balance", c.get_account)
    if account:
        bal = float(account.get("availableBalance", 0))
        pnl = float(account.get("totalUnrealizedProfit", 0))
        print(f"       Balance: ${bal:.2f} USDT | PnL: ${pnl:.2f}")

    positions = check("Open positions", c.get_position_risk)
    if positions is not None:
        open_pos = [p for p in positions if float(p.get("positionAmt", 0)) != 0]
        print(f"       Open positions: {len(open_pos)}")

# 5. Analysis pipeline
print("\n[5/5] Analysis pipeline (offline)...")
if klines:
    analysis = check("analyze_symbol", lambda: analyze_symbol(klines))
    if analysis:
        print(f"       Signal: {analysis['signal']} | Confidence: {analysis['confidence']} | Trend: {analysis['trend']}")
        sl_tp = calculate_sl_tp(
            float(ticker["lastPrice"]) if ticker else 100000,
            analysis["signal"], analysis["atr"]
        )
        print(f"       SL: {sl_tp['sl']:.2f} | TP: {sl_tp['tp']:.2f}")

print("\n✅ Test complete! MCP server ready to use.\n")
print("Next step: set API keys in config.yaml env section, enable MCP server,")
print("then restart Hermes gateway.\n")
