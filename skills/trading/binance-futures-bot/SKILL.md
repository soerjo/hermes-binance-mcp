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

Hermes operates as a **full-auto futures trading bot** for Mas's Binance account.
This skill defines all workflows, rules, and behaviors Hermes must follow.

## Available MCP Tools

| Tool | Purpose |
|---|---|
| `scan_market` | Scan top USDT perps, rank by volume + TA signal |
| `analyze_market` | Deep TA for one symbol: RSI, MACD, EMA, BB, ATR |
| `get_futures_market` | Raw OHLCV + ticker + mark price for a symbol |
| `get_funding_rates` | Current funding rates across symbols |
| `get_account_status` | Balance, margin, open position count |
| `get_open_positions` | All open positions with health status |
| `get_open_orders` | Pending SL/TP/limit orders |
| `place_futures_order` | Open new LONG or SHORT with auto SL/TP |
| `close_position` | Market-close 100% of a position + cancel its orders |
| `partial_close_position` | Close partial amount (e.g. 50%) of active position |
| `set_position_stop_loss` | Set or update SL (STOP_MARKET) on active position |
| `set_trailing_stop` | Set native Binance dynamic Trailing Stop (callback 0.1-5%) |
| `set_position_take_profit` | Set target TP order (supports partial TP e.g. 50%) |
| `cancel_order` | Cancel single order by ID |
| `cancel_all_orders` | Cancel all orders for a symbol |
| `set_leverage` | Set leverage before opening |
| `monitor_positions` | Health check all positions, get action recommendations |
| `get_trade_history` | Recent income/trade history |

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

1. Call `get_account_status` → cek balance & kapasitas (max 3 posisi)
2. Call `scan_market(top_n=15, interval="4h")` → dapatkan ranked opportunities
3. Untuk setiap sinyal dengan score ≥ 65:
   - Call `analyze_market(symbol, "4h")` → detail full TA
   - Hitung posisi sizing berdasarkan balance saat ini
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
5. Jika score ≥ 70 DAN `open_positions < MAX_OPEN_POSITIONS`:
   - **Eksekusi otomatis** `place_futures_order`
   - Lapor ke Mas via Telegram: "✅ Order masuk: {symbol} {side}"
6. Jika score 55–69: Lapor ke Mas, tunggu konfirmasi manual
7. Jika score < 55: Skip, tidak dilaporkan

---

## Workflow 2: Direct Order Execution

**Trigger:** Mas minta buka posisi spesifik.

1. Parse intent: symbol, side, leverage (default 5x)
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

Semua rules ini dijalankan di `risk.py` secara otomatis. Hermes **tidak bisa** dan **tidak boleh** bypass rules ini.

| Rule | Nilai |
|---|---|
| Max risk per trade | 2% dari available balance |
| Max posisi bersamaan | 3 |
| Max leverage | 10x (default 5x) |
| Funding rate threshold | 0.1% — skip entry jika > ini |
| Funding blackout | 30 menit sebelum/sesudah funding time |
| Min confidence untuk auto-execute | 70/100 |
| Max daily loss | 5% dari balance awal hari |
| Selalu ada SL | WAJIB setiap order |

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
Balance: ${balance} | Posisi: {n}/3

Top Peluang:
{daftar simbol dengan score}

Auto-executed: {list} / Watchlist: {list}
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
