# hermes-binance-mcp

Autonomous Binance Futures trading MCP server for [Hermes Agent](https://github.com/NousResearch/hermes-agent).  
Exposes **18 tools** via MCP so Hermes can scan markets, generate signals, and execute orders — fully autonomous.

## Architecture

```
Hermes Agent
    │
    │  HTTP SSE (localhost:8811)          ← container mode (recommended)
    │  stdio subprocess                   ← direct mode (fallback)
    ▼
binance-mcp container
    ├── server.py     MCPServer — 14 tools, dual transport (stdio/SSE)
    ├── client.py     Binance Futures REST (HMAC, proxy support)
    ├── analysis.py   RSI · MACD · EMA(20/50/200) · BB · ATR
    └── risk.py       2% risk rule · max 3 pos · funding blackout
          │
          ▼
    fapi.binance.com (Futures REST API)
```

## Tools

| Tool | Description |
|---|---|
| `scan_market` | Scan top USDT perps by volume, rank by TA score |
| `analyze_market` | Deep TA for one symbol |
| `get_futures_market` | Raw OHLCV + ticker + mark price |
| `get_funding_rates` | Current funding rates |
| `get_account_status` | Balance, margin, open position count |
| `get_open_positions` | All positions with health status (OK/WARN/CRITICAL) |
| `get_open_orders` | Pending SL/TP/limit orders |
| `place_futures_order` | Open LONG/SHORT — auto sizing, auto SL/TP via ATR |
| `close_position` | Market-close 100% of position + cancel its orders |
| `partial_close_position` | Close partial (e.g. 50%) of active position (MARKET or LIMIT) |
| `set_position_stop_loss` | Set or update SL (STOP_MARKET) on an active position |
| `set_trailing_stop` | Place native Binance dynamic Trailing Stop (callback 0.1-5%) |
| `set_position_take_profit` | Set target TP order (supports partial TP e.g. 50%) |
| `cancel_order` | Cancel one order by ID |
| `cancel_all_orders` | Cancel all orders for a symbol |
| `set_leverage` | Set leverage (max 10×) |
| `monitor_positions` | Health check all positions, return actions needed |
| `get_trade_history` | Recent realized income |

## Risk Rules

| Rule | Value |
|---|---|
| Max risk per trade | 2% of available balance |
| Max open positions | 3 |
| Max leverage | 10× (default 5×) |
| Funding rate gate | Skip entry if \|rate\| > 0.1% |
| Funding blackout | 30 min before/after each funding time |
| Auto-execute threshold | confidence ≥ 70/100 |

## Quick Start

### Container (Recommended)

```bash
git clone https://github.com/soerjo/hermes-binance-mcp
cd hermes-binance-mcp

cp .env.template .env
# Edit .env — tambah BINANCE_API_KEY dan BINANCE_API_SECRET
# (API key harus enable Futures Trading permission)

docker compose up -d
docker compose logs -f   # verify running
```

Test:
```bash
curl http://localhost:8811/sse   # should respond with SSE stream
```

### Hermes `config.yaml` — SSE mode

```yaml
mcp_servers:
  binance:
    url: http://localhost:8811/sse
    enabled: true
```

### Hermes `config.yaml` — stdio mode (tanpa container)

```yaml
mcp_servers:
  binance:
    command: /path/to/.venv/bin/python
    args:
      - /path/to/server.py
    env:
      BINANCE_API_KEY: ${BINANCE_API_KEY}
      BINANCE_API_SECRET: ${BINANCE_API_SECRET}
      MCP_TRANSPORT: stdio
    enabled: true
```

### Tambah Skill ke Hermes

```bash
mkdir -p ~/.hermes/skills/trading/binance-futures-bot
cp skill/SKILL.md ~/.hermes/skills/trading/binance-futures-bot/
cp -r skill/prompts ~/.hermes/skills/trading/binance-futures-bot/
cp cron/binance_*.yaml ~/.hermes/cron/
```

`config.yaml`:
```yaml
skills:
  always_load:
    - binance-futures-bot
```

Restart Hermes gateway, lalu bilang ke Hermes: **"scan market sekarang"** — dia langsung jalan.

## Cron Schedules

| Job | Schedule | Action |
|---|---|---|
| `binance_morning_scan` | `0 0,12 * * *` | 07:00 + 19:00 WIB — scan & auto-execute |
| `binance_position_monitor` | `*/30 * * * *` | Monitor posisi, auto-close critical loss |
| `binance_funding_alert` | `55 7,15,23 * * *` | Alert 5 menit sebelum funding time |

## Proxy (IP Block)

Binance memblok beberapa ISP Indonesia (Telkom). Set di `.env`:

```env
BINANCE_PROXY=socks5://your-proxy:1080
# atau
BINANCE_PROXY=http://user:pass@proxy:3128
```

## Transport Modes

| Env | Value | Use case |
|---|---|---|
| `MCP_TRANSPORT` | `sse` (default in container) | Docker — Hermes pakai `url:` |
| `MCP_TRANSPORT` | `stdio` | Subprocess — Hermes pakai `command:` |
| `MCP_PORT` | `8811` | SSE listen port |
| `MCP_HOST` | `0.0.0.0` | SSE bind host |

## Stack

Python 3.11 · [mcp](https://github.com/modelcontextprotocol/python-sdk) 2.x · httpx · pandas · ta · uvicorn

## License

MIT
