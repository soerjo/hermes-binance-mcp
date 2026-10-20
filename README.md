# hermes-binance-mcp

Binance Futures MCP (Model Context Protocol) server for [Hermes Agent](https://github.com/NousResearch/hermes-agent).  
Exposes 13 trading tools so Hermes can autonomously scan markets, generate trade signals, and execute Binance Futures orders.

## Features

- **Full technical analysis** — RSI, MACD, EMA stack (20/50/200), Bollinger Bands, ATR, volume ratio
- **Auto position sizing** — 2% risk-per-trade rule, ATR-based SL/TP
- **Risk engine** — max positions, funding rate blackout, confidence floor, daily loss cap
- **13 MCP tools** — market scan, order execution, position monitoring, account status
- **Hermes skill + cron** — autonomous morning scan, 30-min position monitor, funding alerts

## Architecture

```
Hermes Agent
    └── MCP: binance
            ├── server.py       FastMCP server (13 tools)
            ├── client.py       Binance Futures REST (HMAC auth, proxy support)
            ├── analysis.py     Technical indicators (ta library)
            └── risk.py         Risk management engine
```

## Tools Exposed to Hermes

| Tool | Description |
|---|---|
| `scan_market` | Scan top USDT perps by volume, rank by TA signal |
| `analyze_market` | Deep TA for one symbol |
| `get_futures_market` | Raw OHLCV + ticker + mark price |
| `get_funding_rates` | Current funding rates |
| `get_account_status` | Balance, margin, open position count |
| `get_open_positions` | All open positions with health status |
| `get_open_orders` | Pending SL/TP/limit orders |
| `place_futures_order` | Open LONG/SHORT with auto SL/TP + risk sizing |
| `close_position` | Market-close position + cancel its orders |
| `cancel_order` | Cancel single order by ID |
| `cancel_all_orders` | Cancel all orders for a symbol |
| `set_leverage` | Set leverage before opening |
| `monitor_positions` | Health check all positions, action recommendations |
| `get_trade_history` | Recent income/trade history |

## Risk Rules (enforced in `risk.py`)

| Rule | Value |
|---|---|
| Max risk per trade | 2% of available balance |
| Max open positions | 3 |
| Max leverage | 10× (default 5×) |
| Funding rate threshold | 0.1% — skip entry if exceeded |
| Funding blackout | 30 min before/after funding time |
| Min confidence to auto-execute | 70/100 |
| Max daily loss | 5% of balance |

## Setup

### 1. Prerequisites

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 2. API Keys

```bash
cp .env.template .env
# Edit .env — add BINANCE_API_KEY and BINANCE_API_SECRET
# API key must have Futures Trading permission enabled
```

### 3. Test Connection

```bash
source .env
.venv/bin/python test_connection.py
```

### 4. Register in Hermes `config.yaml`

```yaml
mcp_servers:
  binance:
    command: /path/to/.venv/bin/python
    args:
      - /path/to/server.py
    env:
      BINANCE_API_KEY: ${BINANCE_API_KEY}
      BINANCE_API_SECRET: ${BINANCE_API_SECRET}
      # Optional proxy if Binance is blocked from your IP:
      # BINANCE_PROXY: socks5://127.0.0.1:1080
    enabled: true
```

### 5. Add Skill to Hermes

Copy `skill/` contents to `~/.hermes/skills/trading/binance-futures-bot/`  
Copy `cron/` contents to `~/.hermes/cron/`

Add to `config.yaml`:
```yaml
skills:
  always_load:
    - binance-futures-bot
```

### 6. Restart Hermes

```bash
cd ~/my-code/my-hermes
docker compose restart gateway
```

## Cron Schedules

| Job | Schedule | Action |
|---|---|---|
| `binance_morning_scan` | `0 0,12 * * *` (07:00 & 19:00 WIB) | Scan market, auto-execute high-confidence signals |
| `binance_position_monitor` | `*/30 * * * *` | Health check positions, auto-close on critical loss |
| `binance_funding_alert` | `55 7,15,23 * * *` | Alert 5 min before funding time |

## Notes

- **IP restriction**: Binance blocks some Indonesian ISP IPs (Telkom). Set `BINANCE_PROXY` env var if needed.
- **Full-auto mode**: Hermes executes orders autonomously when signal score ≥ 70. No approval prompt.
- **SBE**: Uses standard JSON REST API, not SBE binary encoding (sufficient for this use case).
- Tested on Python 3.11 with `ta>=0.11.0`.

## License

MIT
