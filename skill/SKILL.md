---
name: binance-futures-bot
description: >
  Autonomous Binance Futures trading assistant. Scans markets, generates
  trade recommendations with full technical analysis, and executes orders
  with automatic position sizing, SL, and TP. Monitors open positions
  for health and acts on critical signals.
version: 1.0.0
author: Mas Soerjo
platforms: [linux]
metadata:
  hermes:
    tags: [binance, futures, trading, crypto, bot, autonomous]
    category: trading
    related_skills: [research, productivity]
---

# Binance Futures Bot Skill

Hermes beroperasi **manual-first** di akun Futures Mas: analisa, rekomendasi,
dan monitoring. Order otomatis hanya berjalan melalui **auto-entry switch**
milik `crypto-trading-engine` (default **OFF**), bukan keputusan bebas Hermes.
Skill ini mendefinisikan workflow, aturan, dan perilaku Hermes.

## Available MCP Tools (26)

| Tool | Purpose |
|---|---|
| `get_futures_market` | Raw OHLCV + ticker + mark price for a symbol |
| `scan_market` | Scan top USDT perps, rank by volume + TA signal (parallel worker pool) |
| `analyze_market` | Deep TA for one symbol: RSI, MACD, EMA, BB, ATR, ADX |
| `analyze_mtf` | Single-call MTF analysis; optional `intervals` (default 4h/1h/15m/5m) |
| `get_funding_rates` | Current funding rates across symbols |
| `get_symbol_precision` | LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL untuk sizing final |
| `get_derivatives_context` | Open Interest + Top Trader Long/Short ratio |
| `recommend_trading_style` | Rekomendasi rezim: swing/intraday/scalp/wait + BTC bias + veto |
| `get_account_status` | Balance, margin, open position count |
| `get_open_positions` | All open positions with health status |
| `get_open_orders` | Pending SL/TP/limit orders |
| `place_futures_order` | Open LONG/SHORT — default sizing = 2% risk rule (kirim `use_auto_sizing=false` + `notional_usdt` untuk notional tetap). SL/TP di-arm SETELAH entry fill; `client_order_id` untuk idempotensi |
| `close_position` | Market-close 100% + cancel its orders |
| `partial_close_position` | Close partial amount (e.g. 50%) of active position |
| `set_position_stop_loss` | Set or update SL (STOP_MARKET) on active position |
| `set_trailing_stop` | Native Binance dynamic Trailing Stop (callback 0.1-5%) |
| `set_position_take_profit` | Set target TP (partial TP, LIMIT or MARKET) |
| `cancel_order` | Cancel single order by ID |
| `cancel_all_orders` | Cancel all orders for a symbol |
| `set_leverage` | Set leverage before opening |
| `monitor_positions` | Health check all positions, get action recommendations |
| `get_trade_history` | Recent income/trade history |
| `get_spot_account_status` | Spot balance + estimated USDT value |
| `get_spot_open_orders` | Spot open orders |
| `place_spot_order` | Place Spot BUY/SELL (MARKET/LIMIT) |
| `cancel_spot_order` | Cancel Spot order by ID or client ID |

---

## Trigger Phrases

Load and apply this skill when Mas says anything like:
- "scan market / cari peluang trade / analisis BTC"
- "buka posisi / long / short / entry"
- "tutup posisi / close / exit / cut loss"
- "cek posisi / posisi saat ini / portfolio"
- "monitor trading / cek PnL"
- "rekomendasi trade / sinyal hari ini"
- Cron task: `binance_morning_scan` / `binance_position_monitor` / `binance_funding_alert`

---

## Workflow 1: Morning Market Scan (Cron 07:00 + 19:00)

**Trigger:** Cron `binance_morning_scan` atau Mas minta scan.

1. Call `get_account_status` → cek balance & kapasitas (max 5 posisi)
2. Call `scan_market(top_n=15, interval="15m")` → dapatkan ranked opportunities
3. Untuk setiap sinyal menonjol:
   - Call `analyze_mtf(symbol)` → detail full TA
   - Call `recommend_trading_style` → konteks rezim pasar & BTC bias
4. Susun laporan singkat:
   ```
   📊 Market Scan — {waktu}
   Balance: ${balance} | Posisi: {open}/{max}

   🟢 PELUANG TERBAIK:
   1. {symbol} {side} — Score: {score}/100
      Entry: ~${price} | SL: ${sl} | TP: ${tp}
      RSI: {rsi} | {trend} | Confidence: {conf}%

   ⚠️ Watch: {symbol2} — menunggu konfirmasi
   ```
5. **Jangan eksekusi otomatis dari cron.** Cron scan hanya melapor. Order
   baru terjadi bila: Mas minta eksplisit (`eksekusi SYMBOL` via engine),
   atau engine auto-entry switch ON (otorisasi Mas, tercatat di
   `auto_entry_state.json`). Jika score 55–69: laporkan, tunggu konfirmasi.
6. Score < 55: skip, tidak dilaporkan.

---

## Workflow 2: Direct Order Execution

**Trigger:** Mas minta buka posisi spesifik.

1. Parse intent: symbol, side, leverage (default 20x)
2. `get_account_status` → cek balance & posisi terbuka
3. `analyze_market(symbol)` → ambil ATR untuk auto SL/TP
4. `get_funding_rates([symbol])` → cek funding rate
5. `place_futures_order(symbol, side, leverage)` → eksekusi
   - SL/TP dihitung otomatis dari ATR jika tidak disebutkan Mas
6. Konfirmasi ke Mas: entry price, SL, TP, qty, leverage

**Jika Mas sebut SL/TP manual:**
- Gunakan nilai dari Mas, bukan auto-calc
- Tetap validasi risk rules (max 2% balance per trade)

---

## Workflow 3: Position Monitor (Cron tiap 30 menit)

**Trigger:** Cron `binance_position_monitor`.

1. `monitor_positions()` → dapatkan status semua posisi
2. Untuk setiap posisi:
   - **CRITICAL** (rugi > 3% margin): `close_position(symbol)` + Telegram alert 🔴
   - **TRAIL_STOP** (profit > 3%): Hitung SL baru (breakeven+), update via cancel+replace
   - **WARN**: Telegram notification ⚠️ (no auto-action)
   - **OK**: Silent
3. Jika ada aksi, kirim ringkasan ke Telegram

---

## Workflow 4: Funding Rate Alert (Cron 5 menit sebelum 08:00, 16:00, 00:00)

**Trigger:** Cron `binance_funding_alert`.

1. `get_open_positions()` → list posisi terbuka
2. `get_funding_rates([symbols])` → cek rate setiap posisi
3. Kalkulasi funding yang akan dibayar/diterima per posisi
4. Jika ada posisi yang akan bayar funding > $5: alert ke Mas
5. Format: "💸 Funding in 5min: {symbol} bayar ${amount} (rate: {rate}%)"

---


---

## Workflow: Managing Active Positions (Partial TP & Trailing Stop)

Gunakan workflow ini saat Mas meminta take profit sebagian atau pasang trailing stop pada posisi yang SUDAH BERJALAN:

### 1. Partial Take Profit (50% atau X%)
- Jika Mas minta **"TP 50% sekarang"** (eksekusi langsung):
  👉 Panggil: `partial_close_position(symbol="SUIUSDT", percentage=50.0, order_type="MARKET")`
- Jika Mas minta **"Pasang TP di harga target X untuk 50% posisi"**:
  👉 Panggil: `set_position_take_profit(symbol="SUIUSDT", tp_price=1.05, percentage=50.0, order_type="LIMIT")`

### 2. Trailing Stop Otomatis (Binance Dynamic Trailing Stop)
- Jika Mas minta **"Pasang trailing stop X%"**:
  👉 Panggil: `set_trailing_stop(symbol="SUIUSDT", callback_rate=1.5, cancel_existing_sl=True)`
  *(Order ini otomatis mengikuti kenaikan harga dengan jarak 1.5%. Jika harga berbalik turun 1.5% dari puncak, posisi otomatis ditutup).*

### 3. Update Stop Loss / Geser ke Breakeven (Manual SL Baru)
- Jika Mas minta **"Geser SL ke breakeven / harga entry"** atau ke harga tertentu:
  👉 Panggil: `set_position_stop_loss(symbol="SUIUSDT", stop_price=1.0085, cancel_existing_sl=True)`
  *(Otomatis membatalkan STOP_MARKET lama dan memasang STOP_MARKET baru pada posisi aktif).*

## Risk Rules — NON-NEGOTIABLE

Rules ini dijalankan otomatis di server (`src/risk/*` MCP) dan di engine
(`crypto-trading-engine`). Hermes **tidak bisa** dan **tidak boleh** bypass.

| Rule | Nilai |
|---|---|
| Max risk per trade (MCP) | 2% dari available balance |
| Max risk per trade (engine) | $5.50 / $6.50 (profil) + cap % equity |
| Max posisi bersamaan | 5 |
| Max leverage | 25x (default 5x; engine: profil 5–20x) |
| Funding rate threshold | 0.1% — skip entry jika > ini |
| Funding blackout | 30 menit sebelum/sesudah funding time |
| Min confidence | 60/100 (gate MCP); order otomatis hanya via engine auto-entry |
| Max daily loss | 5% dari balance awal hari |
| Selalu ada SL | WAJIB setiap order |
| Auto-entry switch | Default OFF — hanya dinyalakan atas permintaan Mas |

---

## Laporan Format ke Telegram

### ✅ Order Masuk
```
✅ POSISI BARU — {symbol}
Side: {LONG/SHORT} {leverage}x
Entry: ${price}
SL: ${sl} (-{sl_pct}%)
TP: ${tp} (+{tp_pct}%)
Qty: {qty} | Risk: ${risk_usdt}
```

### 📊 Morning Brief
```
📊 Morning Scan — {tanggal}
Balance: ${balance} | Posisi: {n}/5

Top Peluang:
{daftar simbol dengan score}

Watchlist: {list} | Rezim: {recommended_style}
```

### 🔴 Position Alert
```
🔴 CRITICAL ALERT — {symbol}
PnL: -${loss} ({pct}%)
Action: AUTO-CLOSE EXECUTED
```

### 💰 Position Closed
```
💰 POSISI DITUTUP — {symbol}
{LONG/SHORT} | {leverage}x
Entry: ${entry} → Exit: ${exit}
PnL: {+/-}${amount} ({pct}%)
Reason: {reason}
```

---

## Error Handling

- **RiskError**: Lapor ke Mas dengan alasan jelas, jangan retry
- **BinanceAPIError -2019** (margin insufficient): Cek balance, kurangi leverage
- **BinanceAPIError -1111** (precision): Adjust qty ke step size yang benar
- **Network timeout**: Retry 1x setelah 5 detik, lalu abort dan lapor
- **Semua error**: Log ke memory dengan timestamp untuk audit

---

## Memory & Audit Trail

Setiap trade action dicatat ke Hermes memory:
```
[TRADE] {timestamp} {symbol} {side} entry={price} sl={sl} tp={tp} 
        qty={qty} risk={risk_usdt} score={score} result={status}
```

Daily summary disimpan tiap malam 23:55 ke kanban sebagai task completed.
