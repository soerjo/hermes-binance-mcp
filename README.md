# hermes-binance-mcp

Autonomous Binance Futures trading MCP server for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Exposes **26 tools** via MCP so Hermes can scan markets, generate signals, and execute orders.

Rewritten in **Bun + TypeScript** for low-latency tool calls. The previous Python
Python implementation is preserved in the Git commit history for reference and rollback.

## Architecture

```
Hermes Agent
    │
    │  HTTP SSE (localhost:8811)          ← container mode (recommended)
    │  stdio subprocess                   ← direct mode (fallback)
    ▼
binance-mcp (Bun)
    ├── src/index.ts          dual transport (stdio / legacy SSE)
    ├── src/tools/handlers.ts 26 MCP tools
    ├── src/binance/client.ts Binance REST (HMAC, proxy, keep-alive)
    ├── src/binance/ws-stream.ts mark-price WebSocket cache
    ├── src/ta/               RSI · MACD · EMA · BB · ATR · ADX
    └── src/risk/             2% risk rule · max 5 pos · funding blackout
          │
          ▼
    fapi.binance.com (Futures REST API)
```

## Tools

| Tool | Description |
|---|---|
| `scan_market` | Scan top USDT perps by volume, rank by TA score |
| `analyze_market` | Deep TA for one symbol |
| `analyze_mtf` | One-call multi-timeframe analysis (default 4h / 1h / 15m / 5m; `intervals` opsional) |
| `get_futures_market` | Raw OHLCV + ticker + mark price |
| `get_funding_rates` | Current funding rates |
| `get_symbol_precision` | LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL untuk sizing final |
| `get_derivatives_context` | Open Interest + Top Trader Long/Short ratio |
| `recommend_trading_style` | Rekomendasi rezim swing/intraday/scalp/wait + BTC bias + veto |
| `get_account_status` | Balance, margin, open position count |
| `get_open_positions` | All positions with health status (OK/WARN/CRITICAL) |
| `get_open_orders` | Pending SL/TP/limit orders |
| `place_futures_order` | Open LONG/SHORT — default sizing = 2% risk rule (kirim `use_auto_sizing=false` + `notional_usdt` untuk notional tetap). SL/TP di-arm SETELAH entry fill; `client_order_id` untuk idempotensi |
| `close_position` | Market-close 100% of position + cancel its orders |
| `partial_close_position` | Close partial (e.g. 50%) of active position (MARKET or LIMIT) |
| `set_position_stop_loss` | Set or update SL (STOP_MARKET) on an active position |
| `set_trailing_stop` | Place native Binance dynamic Trailing Stop (callback 0.1-5%) |
| `set_position_take_profit` | Set target TP order (supports partial TP e.g. 50%) |
| `cancel_order` | Cancel one order by ID |
| `cancel_all_orders` | Cancel all standard + algo orders for a symbol |
| `set_leverage` | Set leverage (max 25×) |
| `monitor_positions` | Health check all positions, return actions needed |
| `get_trade_history` | Recent realized income |
| `get_spot_account_status` | Spot coin balances (free/locked) + estimated total value in USDT |
| `get_spot_open_orders` | Active open spot orders |
| `place_spot_order` | Place Spot BUY/SELL order (MARKET or LIMIT) |
| `cancel_spot_order` | Cancel active Spot order by ID |

## Risk Rules

| Rule | Value |
|---|---|
| Max risk per trade | 2% of available balance |
| Max open positions | 5 |
| Max leverage | 25× (default 5×) |
| Funding rate gate | Skip entry if \|rate\| > 0.1% |
| Funding blackout | 30 min before funding settlement |
| Minimum signal confidence | 60/100 |
| Position sizing margin cap | 90% of free balance |

All limits are environment-overridable (`MAX_RISK_PER_TRADE_PCT`,
`MAX_OPEN_POSITIONS`, `MAX_LEVERAGE`, `MAX_FUNDING_RATE`,
`FUNDING_BLACKOUT_MINUTES`, `MIN_CONFIDENCE`).

> **Catatan trading otomatis**: order otomatis dikendalikan oleh engine
> `crypto-trading-engine` (global switch `auto-entry`, default OFF). MCP hanya
> menyediakan tool; scan & position monitor terjadwal dijalankan oleh daemon
> engine, dan cron MCP yang tersisa (`funding_alert`) hanya melapor.

## Quick Start

### Container (Recommended)

```bash
cp .env.template .env
# Edit .env — tambah BINANCE_API_KEY dan BINANCE_API_SECRET
# (API key harus enable Futures Trading permission)

docker compose up -d
docker compose logs -f   # verify running
```

Test:
```bash
curl http://localhost:8811/health
curl http://localhost:8811/sse   # SSE stream
```

### Local development (Bun)

```bash
bun install
bun run start:sse     # SSE on :8811
bun test              # indicator + risk parity tests
bun run typecheck
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
    command: /home/soerjo/.bun/bin/bun
    args:
      - run
      - /path/to/hermes-binance-mcp/src/index.ts
    env:
      BINANCE_API_KEY: ${BINANCE_API_KEY}
      BINANCE_API_SECRET: ${BINANCE_API_SECRET}
      MCP_TRANSPORT: stdio
    enabled: true
```

### Tambah Skill ke Hermes

```bash
mkdir -p ~/.hermes/skills/trading/
cp -r skills/trading/binance-futures-bot ~/.hermes/skills/trading/
# cron/ hanya berisi binance_funding_alert.yaml — scan & monitor ada di engine
cp cron/binance_*.yaml ~/.hermes/cron/
```

`config.yaml`:
```yaml
skills:
  always_load:
    - binance-futures-bot
```

Restart Hermes gateway, lalu bilang ke Hermes: **"scan market sekarang"**.

## Cron Schedules

Scan dan position monitor **tidak** dijadwalkan dari MCP — keduanya dijalankan
oleh daemon `crypto-trading-engine` (`scanner` + `sentinel`) agar tidak ada dua
guardian yang saling menimpa SL/TP.

| Job | Schedule | Action |
|---|---|---|
| `binance_funding_alert` | `55 7,15,23 * * *` | Alert 5 menit sebelum funding time (komplementer) |
| ~~`binance_morning_scan`~~ | — | Dinonaktifkan → `cron/disabled/` (domain engine `scanner`) |
| ~~`binance_position_monitor`~~ | — | Dinonaktifkan → `cron/disabled/` (domain engine `sentinel`) |

## Proxy (IP Block)

Binance memblok beberapa ISP Indonesia (Telkom). Set di `.env`:

```env
BINANCE_PROXY=socks5://your-proxy:1080
# atau
BINANCE_PROXY=http://user:pass@proxy:3128
```

When a proxy is configured the mark-price WebSocket is skipped automatically
(Bun's WebSocket has no proxy option) and REST is used instead.

## Transport Modes

| Env | Value | Use case |
|---|---|---|
| `MCP_TRANSPORT` | `sse` (default in container) | Docker — Hermes pakai `url:` |
| `MCP_TRANSPORT` | `stdio` | Subprocess — Hermes pakai `command:` |
| `MCP_PORT` | `8811` | SSE listen port |
| `MCP_HOST` | `0.0.0.0` | SSE bind host |
| `BINANCE_WS_ENABLED` | `0` | Disable mark-price WebSocket cache |

## Stack

Bun 1.4 · TypeScript · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 1.x · Zod

## Deployment

Runbook lengkap (MCP Docker → engine Bun di host → verifikasi Hermes, batas
kewenangan Agent, rollback):
[`../crypto-trading-engine/docs/DEPLOYMENT.md`](../crypto-trading-engine/docs/DEPLOYMENT.md)

## License

MIT
