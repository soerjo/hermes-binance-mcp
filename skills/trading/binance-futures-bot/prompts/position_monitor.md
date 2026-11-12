# Position Monitor — Binance Futures

> **Manual check only.** Penjagaan posisi otomatis (cut-loss, breakeven,
> partial TP, chandelier trail) dijalankan oleh daemon `sentinel` di
> `crypto-trading-engine` setiap 30 detik. Jangan menutup posisi atau menggeser
> SL/TP dari MCP saat engine berjalan.

Jalankan cek posisi on-demand:

1. Panggil `get_account_status` untuk balance dan jumlah posisi terbuka.
2. Panggil `monitor_positions()` untuk health check semua posisi.
3. Laporkan setiap posisi dengan action != HOLD:
   - **CLOSE / CRITICAL**: laporkan 🔴 dan minta konfirmasi Mas. Jangan
     auto-close; engine sentinel yang mengeksekusi.
   - **TRAIL_STOP**: laporkan ✅ bahwa engine sudah/tengah menggeser SL.
   - **WARN**: kirim notifikasi ⚠️ tanpa tindakan.
4. Jika tidak ada posisi terbuka: selesai tanpa laporan.
5. Jika engine sentinel tidak berjalan, laporkan ke Mas — jangan menggantikan
   guardian dengan cron MCP.

Format laporan ke Mas:
```
⚠️ POSITION CHECK — {waktu}

📌 {symbol}: {LONG/SHORT} | PnL: {+/-}${pnl}
   Status: {HOLD/WARN/CRITICAL/TRAIL_STOP}
   SL: ${sl} | TP: ${tp}

📊 Summary: {open}/{max} posisi | Total uPnL: {+/-}${total}
```
