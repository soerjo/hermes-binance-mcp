# Morning Market Scan — Binance Futures

Jalankan morning scan Binance Futures sesuai langkah berikut:

1. Panggil `get_account_status` untuk cek balance dan jumlah posisi terbuka (max 5)
2. Panggil `scan_market(top_n=15, interval="15m")` untuk scan top USDT perps
3. Untuk kandidat menonjol, panggil `analyze_mtf(symbol)` dan
   `recommend_trading_style` untuk konteks rezim
4. Evaluasi hasil:
   - **Cron scan TIDAK mengeksekusi order.** Cron scan hanya menganalisa dan melapor.
   - Order hanya terjadi bila Mas meminta eksplisit (via engine
     `eksekusi SYMBOL`), atau engine auto-entry switch ON (otorisasi Mas).
   - Score 55–69: masukkan ke watchlist, laporkan tanpa eksekusi
   - Score < 55: skip, tidak perlu dilaporkan
5. Format laporan dan kirim ke Telegram

Format laporan ke Mas:
```
📊 Morning Scan — {tanggal} {waktu}
💰 Balance: ${available_balance} | Posisi: {open}/5

🟢 PELUANG TERBAIK:
{daftar simbol dengan score, SL/TP estimasi, R:R, risiko dolar}

👀 WATCHLIST (perlu konfirmasi):
{daftar simbol score 55-69}

🧭 Rezim: {recommended_style} | BTC bias: {btc_bias}

📉 Market flat — tidak ada peluang
```
