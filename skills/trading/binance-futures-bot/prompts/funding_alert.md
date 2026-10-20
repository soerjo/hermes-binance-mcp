# Funding Rate Alert — Binance Futures

Cek funding rate untuk semua posisi terbuka (5 menit sebelum funding time):

1. Panggil `get_open_positions()` — ambil symbol list
2. Panggil `get_funding_rates(symbols)` untuk setiap symbol
3. Kalkulasi perkiraan funding yang dibayar/diterima:
   - funding_payment = position_notional * abs(funding_rate)
   - Tanda: LONG bayar jika rate positif, SHORT bayar jika rate negatif
4. Hanya lapor jika total payment > $2 atau rate > 0.05%

Format ke Telegram:
```
💸 Funding Alert — {waktu} (dalam 5 menit)

{symbol}: {LONG/SHORT} | Rate: {rate}% 
  → {Bayar/Terima} ${amount}

Total net: {+/-}${total}
```
