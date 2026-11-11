# Agent Guide — hermes-binance-mcp

> Dokumen ini ditujukan untuk **Hermes Agent** agar memahami cara menggunakan Binance MCP Server (`hermes-binance-mcp`) secara aman dan efisien. Semua tool, argumen, output shape, dan aturan risiko dijelaskan di sini.

## 1. Ringkasan

- **Repo**: `soerjo/hermes-binance-mcp`
- **Runtime**: Bun (TypeScript), port default `8811` (SSE) atau stdio.
- **Transport**: `MCP_TRANSPORT=stdio` (default, untuk subprocess Hermes) atau `sse` (container/HTTP).
- **Fungsi**: Menyediakan 23 MCP tool untuk data pasar Binance USDT-M Futures + Spot, analisis teknikal, manajemen risiko, dan eksekusi order.
- **Keamanan jaringan**: Built-in DoH auto-tunnel (bypass DNS poisoning ISP Indonesia) aktif otomatis bila `BINANCE_PROXY` kosong.

## 2. Konfigurasi Environment (`.env`)

| Variabel | Default | Keterangan |
| :--- | :--- | :--- |
| `BINANCE_API_KEY` | (wajib) | API key Binance (Futures + Spot) |
| `BINANCE_API_SECRET` | (wajib) | API secret Binance |
| `BINANCE_PROXY` | (kosong) | Proxy HTTP/HTTPS (Gluetun). Jika kosong, DoH auto-tunnel aktif |
| `BINANCE_DOH_ENABLED` | `1` | Aktifkan DoH tunnel (`0` untuk nonaktif) |
| `MCP_TRANSPORT` | `stdio` | `stdio` atau `sse` |
| `MCP_HOST` | `0.0.0.0` | Host bind (sse mode) |
| `MCP_PORT` | `8811` | Port (sse mode) |
| `SCAN_TOP_N` | `15` | Default top_n untuk scan_market |
| `SCAN_INTERVAL` | `15m` | Default interval scan_market |
| `DEFAULT_LEVERAGE` | `5` | Default leverage place_futures_order |
| `MAX_LEVERAGE` | `25` | Batas maksimum leverage |
| `RISK_REWARD` | `2.0` | Risk:Reward default untuk SL/TP |
| `MAX_OPEN_POSITIONS` | `5` | Batas posisi terbuka (risk engine) |
| `MAX_RISK_PER_TRADE_PCT` | `0.02` | Risiko per trade (2%) |
| `LOG_LEVEL` | `INFO` | Level log |

## 3. Aturan Wajib untuk Agent (Safety Rules)

1. **Selalu cek kapasitas dulu**: Panggil `get_account_status` sebelum membuka posisi baru. `open_positions_count` tidak boleh melebihi `MAX_OPEN_POSITIONS` (default 5).
2. **Jangan buka posisi kalau balance rendah**: `available_balance` < $20 → jangan buka order.
3. **Gunakan `use_auto_sizing: true`** untuk sizing otomatis (2% risk rule). Jika manual, pastikan `qty` atau `notional_usdt` valid.
4. **SL/TP wajib valid geometri**:
   - LONG: `sl < entry < tp`
   - SHORT: `tp < entry < sl`
   - Server akan menolak jika melanggar (error `Invalid SL/TP geometry`).
5. **Leverage maksimum**: `MAX_LEVERAGE` (default 25x). Server menolak leverage di atas batas.
6. **Funding rate**: Hindari entry saat `|funding_rate| >= 0.001` (0.1%) atau dalam blackout window (30 menit sebelum funding).
7. **Confidence minimum**: Sinyal dengan confidence < `MIN_CONFIDENCE` (60) sebaiknya tidak dieksekusi.
8. **Selalu monitor posisi**: Panggil `monitor_positions` secara berkala (setiap 30 menit) untuk mendeteksi CRITICAL/WARN.
9. **Jangan retry order setelah POST diterima**: Jika response timeout, cek `get_open_orders` / `get_open_positions` dulu sebelum re-send (hindari order ganda).

## 4. Daftar Tool (23) & Cara Pakai

### Market Data

| Tool | Args | Output Utama |
| :--- | :--- | :--- |
| `get_futures_market` | `symbol`, `interval` (default 4h), `limit` (default 200) | `klines`, `ticker_24h`, `mark_price`, `book_ticker` |
| `scan_market` | `top_n` (default 15), `interval` (default 15m), `min_volume_usdt` (default 50M) | `scanned`, `actionable`, `top_opportunities[]`, `ranked_actionable[]` (max 5) |
| `analyze_market` | `symbol`, `interval` (default 15m) | `mark_price`, `funding_rate`, `analysis` (RSI, MACD, EMA, BB, ATR, ADX, trend, signal, confidence), `score`, `suggested_sl_tp` |
| `analyze_mtf` | `symbol` | `mark_price`, `funding_rate`, `timeframes` (4h/1h/15m/5m masing-masing analysis lengkap) — **gunakan ini untuk efisiensi** |
| `get_funding_rates` | `symbols` (opsional, array) | Array mark price + funding rate, diurutkan by abs rate (top 20 jika tanpa symbols) |

### Account & Positions

| Tool | Args | Output Utama |
| :--- | :--- | :--- |
| `get_account_status` | (none) | `total_wallet_balance`, `total_margin_balance`, `available_balance`, `open_positions_count`, `can_trade`, `usdt{}` |
| `get_open_positions` | (none) | Array posisi: `symbol`, `side`, `entry_price`, `mark_price`, `qty`, `unrealized_pnl`, `leverage`, `margin_type`, `initial_margin`, `status`, `action`, `roe_pct`, `price_move_pct`, `reason` |
| `get_open_orders` | `symbol` (opsional) | Array order terbuka |
| `monitor_positions` | (none) | `open_positions`, `total_unrealized_pnl`, `available_balance`, `actions_required[]`, `positions[]` |

### Futures Orders

| Tool | Args | Output Utama |
| :--- | :--- | :--- |
| `place_futures_order` | `symbol`, `side` (LONG/SHORT), `leverage` (default 5), `sl_price`, `tp_price`, `qty`, `notional_usdt`, `use_auto_sizing` (default true), `margin_type` (default ISOLATED), `order_type` (default LIMIT), `price`, `time_in_force` (default GTC) | `entry`, `stop_loss`, `take_profit`, `summary{}` |
| `close_position` | `symbol` | `close_result`, `cancelled_orders`, `cancelled_algo_orders` |
| `partial_close_position` | `symbol`, `percentage` (default 50), `qty`, `order_type` (default MARKET), `price` | `closed_qty`, `remaining_size_approx`, `order_result` |
| `set_position_stop_loss` | `symbol`, `stop_price`, `cancel_existing_sl` (default true) | `new_stop_price`, `quantity`, `cancelled_previous_sl` |
| `set_trailing_stop` | `symbol`, `callback_rate` (0.1-5.0), `activation_price`, `quantity`, `percentage` (default 100), `cancel_existing_sl` (default true) | `callback_rate`, `quantity`, `order_result` |
| `set_position_take_profit` | `symbol`, `tp_price`, `percentage` (default 50), `qty`, `order_type` (default TAKE_PROFIT_MARKET), `cancel_existing_tp` (default false) | `tp_price`, `quantity`, `cancelled_previous_tp`, `order_result` |
| `cancel_order` | `symbol`, `order_id` | hasil cancel |
| `cancel_all_orders` | `symbol` | `cancelled{standard_orders, cancelled_algo_orders}` |
| `set_leverage` | `symbol`, `leverage` | hasil changeLeverage |

### Spot

| Tool | Args | Output Utama |
| :--- | :--- | :--- |
| `get_spot_account_status` | (none) | `account_type`, `can_trade`, `total_estimated_usdt`, `balances[]` (asset, free, locked, total, estimated_usdt) |
| `get_spot_open_orders` | `symbol` (opsional) | Array order spot terbuka |
| `place_spot_order` | `symbol`, `side` (BUY/SELL), `order_type` (MARKET/LIMIT), `qty`, `quote_qty`, `price`, `time_in_force` | hasil order |
| `cancel_spot_order` | `symbol`, `order_id`, `client_order_id` | hasil cancel |

### Spot

| Tool | Args | Output Utama |
| :--- | :--- | :--- |
| `get_trade_history` | `limit` (default 20) | Array income: `symbol`, `incomeType`, `income`, `time`, `tranId` |

## 5. Workflow Agent yang Direkomendasikan

### 5.1 Morning Scan (Cron 07:00 & 19:00 WIB)
1. `get_account_status` → cek balance & kapasitas (max `MAX_OPEN_POSITIONS`)
2. `scan_market(top_n=15, interval="4h")` → ranked opportunities
3. Untuk setiap sinyal dengan score ≥ 65: `analyze_market(symbol, "4h")` atau `analyze_mtf(symbol)`
4. Auto-execute jika score ≥ 70 dan posisi terbuka < 3 (gunakan `place_futures_order`)
5. Kirim laporan ke Telegram

### 5.2 Position Monitor (Cron */30 menit)
1. `monitor_positions()` → health check semua posisi
2. Jika tidak ada posisi: selesai tanpa laporan
3. CRITICAL (rugi > 3% margin): `close_position(symbol)` + alert Telegram 🔴
4. TRAIL_STOP (profit > 3%): update SL ke breakeven + lapor Telegram ✅
5. WARN: kirim notifikasi ⚠️ tanpa tindakan

### 5.3 Funding Alert (Cron 5 menit sebelum funding time)
1. `get_open_positions()` → ambil posisi terbuka
2. Jika tidak ada posisi: selesai
3. `get_funding_rates(symbols)` → cek rate per posisi
4. Kalkulasi estimasi payment/receipt
5. Kirim alert jika total payment > $2 atau rate > 0.05%

### 5.4 Instant Execution (Mas ketik "eksekusi SYMBOL")
- Gunakan `crypto-trading-engine` CLI: `bun run src/index.ts execute SYMBOL` (lebih cepat, pakai cache rekomendasi).
- Atau langsung via MCP: `place_futures_order(symbol, side, ...)`.

## 6. Best Practices untuk Agent

- **Gunakan `analyze_mtf`** bukan 4x `analyze_market` — hemat 75% round-trip SSE.
- **Gunakan `scan_market`** untuk screening awal, lalu `analyze_mtf` untuk kandidat terpilih.
- **Jangan buka posisi saat funding blackout** (30 menit sebelum funding time).
- **Selalu set SL & TP** — server auto-calc dari ATR jika tidak diberikan, tapi lebih baik agent berikan level eksplisit.
- **Partial TP**: gunakan `partial_close_position(percentage=50)` + `set_position_take_profit` untuk TP bertahap.
- **Trailing stop**: gunakan `set_trailing_stop(callback_rate=1.0)` untuk posisi profit > 3%.
- **Error handling**: jika tool mengembalikan `{ error: "..." }`, jangan retry blind — cek state dulu.

## 7. Docker Deployment

```bash
cd hermes-binance-mcp
cp .env.template .env  # isi API keys
docker compose up -d
# Healthcheck: wget http://127.0.0.1:8811/health
```

Gluetun VPN sidecar: gunakan `docker-compose.vpn.yml` jika perlu proxy. DoH auto-tunnel aktif otomatis bila `BINANCE_PROXY` kosong.

## 8. File Penting

| File | Fungsi |
| :--- | :--- |
| `src/tools/handlers.ts` | 23 tool registrations (kontrak MCP) |
| `src/binance/client.ts` | REST client (HMAC, retry, time-sync) |
| `src/binance/ws-stream.ts` | WebSocket mark-price cache |
| `src/binance/doh-tunnel.ts` | DoH auto-tunnel (bypass DNS poisoning) |
| `src/ta/analyzer.ts` | TA analysis + scoreOpportunity |
| `src/ta/indicators.ts` | Float64Array indicators |
| `src/risk/precision.ts` | BigInt step/tick rounding |
| `src/risk/engine.ts` | Risk rules (position sizing, pre-trade, health) |
| `skill/SKILL.md` | Skill definition untuk Hermes |
| `skills/trading/binance-futures-bot/` | Skill prompts (morning_scan, funding_alert, position_monitor) |
| `cron/*.yaml` | Cron job definitions |
| (git history) | Sumber Python lama tersimpan di riwayat commit Git (referensi/rollback) |

## 9. Referensi Cepat: Argumen Penting

- **`place_futures_order`**: `side` = "LONG"/"SHORT", `leverage` 1-25, `order_type` = "LIMIT"/"MARKET", `use_auto_sizing` = true (default, 2% risk) atau false (manual qty/notional).
- **`partial_close_position`**: `percentage` 1-100, `order_type` "MARKET"/"LIMIT" (price wajib jika LIMIT).
- **`set_position_stop_loss`**: `stop_price` trigger, `cancel_existing_sl` default true.
- **`set_position_take_profit`**: `tp_price`, `percentage` default 50, `order_type` default "TAKE_PROFIT_MARKET", `cancel_existing_tp` default false.
- **`set_trailing_stop`**: `callback_rate` 0.1-5.0, `activation_price` opsional.
- **`analyze_mtf`**: hanya `symbol` — kembalikan 4h/1h/15m/5m sekaligus.
- **`scan_market`**: `top_n` default 15, `interval` default "15m", `min_volume_usdt` default 50M.

---

*Dokumen ini dibuat untuk Hermes Agent. Update seiring perubahan kontrak tool.*
