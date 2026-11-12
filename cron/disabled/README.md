# Disabled cron jobs

Cron di direktori ini **tidak dipasang** oleh langkah instalasi
(`cp cron/binance_*.yaml ~/.hermes/cron/`) karena glob hanya mencakup
`cron/*.yaml`.

| File | Alasan dinonaktifkan |
|---|---|
| `binance_morning_scan.yaml` | Scanning terjadwal adalah domain daemon `scanner` di `crypto-trading-engine` (3 sektor, MTF confluence, filter TradFi/illiquid). Scan paralel dari MCP menghasilkan skor berbeda dan tidak tersimpan di `last_recommendations.json`. |
| `binance_position_monitor.yaml` | Penjagaan posisi adalah domain daemon `sentinel` di `crypto-trading-engine` (interval 30 detik). Cron MCP yang berjalan bersamaan dapat menimpa trailing stop engine atau menghapus TP aktif. |

Yang tetap aktif dan komplementer: **`cron/binance_funding_alert.yaml`**
(peringatan 5 menit sebelum funding settlement).

Jika suatu saat perlu mengaktifkan kembali salah satu job, pindahkan file ke
`cron/` **setelah** memastikan daemon engine yang bersangkutan dimatikan.
