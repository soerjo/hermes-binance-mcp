# Position Monitor — Binance Futures

Jalankan monitor posisi terbuka:

1. Panggil `monitor_positions()` untuk health check semua posisi
2. Untuk setiap posisi dengan action != HOLD:
   - **CLOSE** (CRITICAL): Panggil `close_position(symbol)` segera, laporkan ke Telegram 🔴
   - **TRAIL_STOP** (profit > 3%): 
     a. Ambil posisi saat ini via `get_open_positions()`
     b. Hitung SL baru = entry_price (breakeven minimal)  
     c. Cancel SL lama via `cancel_all_orders(symbol)`
     d. Pasang SL baru via `place_futures_order` dengan reduceOnly
     e. Lapor ke Telegram ✅
3. Jika tidak ada posisi terbuka: diam, tidak perlu laporan
4. Jika semua posisi OK: kirim summary singkat hanya jika ada posisi aktif

Format alert ke Mas:
```
⚠️ POSITION ALERT — {waktu}

🔴 AUTO-CLOSED: {symbol}
   PnL: -${loss} | Reason: {reason}

🔄 TRAIL STOP UPDATED: {symbol}
   SL baru: ${new_sl} (dari ${old_sl})
   Floating PnL: +${profit}

📊 Summary semua posisi:
{list posisi dengan status}
```
