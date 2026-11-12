# Market Scan — Binance Futures

> Scanning rutin 3 sektor dijalankan oleh daemon `scanner` di
> `crypto-trading-engine`. Prompt ini hanya untuk scan ad-hoc saat Mas meminta.

1. Panggil `get_account_status` untuk cek balance dan jumlah posisi terbuka (max 5).
2. Panggil `scan_market(top_n=15, interval="15m")` untuk scan top USDT perps.
3. Untuk kandidat menonjol, panggil `analyze_mtf(symbol)` dan
   `recommend_trading_style` untuk konteks rezim.
4. Evaluasi hasil:
   - **Scan TIDAK mengeksekusi order.** Order hanya terjadi bila Mas meminta
     eksplisit (via engine `execute SYMBOL`), atau engine auto-entry switch ON
     (otorisasi Mas).
   - Score 55–69: masukkan ke watchlist, laporkan tanpa eksekusi
   - Score < 55: skip, tidak perlu dilaporkan
5. Format laporan dan kirim ke Telegram

Format laporan ke Mas:
```
📊 Market Scan — {tanggal} {waktu}
💰 Balance: ${available_balance} | Posisi: {open}/5

🟢 PELUANG TERBAIK:
{daftar simbol dengan score, SL/TP estimasi, R:R, risiko dolar}

👀 WATCHLIST (perlu konfirmasi):
{daftar simbol score 55-69}
```
