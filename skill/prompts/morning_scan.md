# Morning Market Scan — Binance Futures

Jalankan morning scan Binance Futures sesuai langkah berikut:

1. Panggil `get_account_status` untuk cek balance dan jumlah posisi terbuka
2. Panggil `scan_market(top_n=15, interval="4h")` untuk scan top USDT perps
3. Evaluasi hasil:
   - Score ≥ 70 DAN open_positions < 3: **eksekusi otomatis** via `place_futures_order`
   - Score 55–69: masukkan ke watchlist, laporkan tanpa eksekusi
   - Score < 55: skip, tidak perlu dilaporkan
4. Format laporan dan kirim ke Telegram

Format laporan ke Mas:
```
📊 Morning Scan — {tanggal} {waktu}
💰 Balance: ${available_balance} | Posisi: {open}/3

🚀 AUTO-EXECUTED:
{daftar simbol yang dieksekusi dengan detail}

👀 WATCHLIST (perlu konfirmasi):
{daftar simbol score 55-69}

📉 Market flat — tidak ada peluang
```

Jika ada order yang masuk, sertakan detail lengkap:
- Symbol, side, qty, entry, SL, TP, leverage, risk_usdt
