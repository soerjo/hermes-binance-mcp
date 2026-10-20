"""
Technical analysis module using the `ta` library (pandas-compatible).
All functions accept raw Binance klines list and return structured dicts.
"""

import logging
import pandas as pd
import numpy as np
import ta

log = logging.getLogger(__name__)

MIN_CANDLES = 60  # minimum required for reliable indicators


def _build_df(klines: list) -> pd.DataFrame:
    """Convert raw Binance klines to typed DataFrame."""
    df = pd.DataFrame(klines, columns=[
        "open_time", "open", "high", "low", "close", "volume",
        "close_time", "quote_volume", "trades",
        "taker_buy_base", "taker_buy_quote", "ignore"
    ])
    for col in ("open", "high", "low", "close", "volume", "quote_volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    df = df.dropna(subset=["close"]).reset_index(drop=True)
    return df


def analyze_symbol(klines: list) -> dict:
    """
    Full technical analysis on klines data.

    Returns dict with: rsi, macd, ema, bollinger, atr, volume, trend, signal, confidence.
    """
    if len(klines) < MIN_CANDLES:
        return {"signal": "SKIP", "confidence": 0, "reason": f"Need {MIN_CANDLES}+ candles, got {len(klines)}"}

    df = _build_df(klines)

    # ── RSI(14) ──────────────────────────────────────────────────────────────
    rsi_val = float(ta.momentum.RSIIndicator(df["close"], window=14).rsi().iloc[-1])
    if rsi_val < 30:
        rsi_trend = "OVERSOLD"
    elif rsi_val > 70:
        rsi_trend = "OVERBOUGHT"
    else:
        rsi_trend = "NEUTRAL"

    # ── MACD(12,26,9) ────────────────────────────────────────────────────────
    macd_ind = ta.trend.MACD(df["close"], window_slow=26, window_fast=12, window_sign=9)
    macd_val  = float(macd_ind.macd().iloc[-1])
    macd_sig  = float(macd_ind.macd_signal().iloc[-1])
    macd_hist = float(macd_ind.macd_diff().iloc[-1])
    prev_hist = float(macd_ind.macd_diff().iloc[-2])

    if prev_hist < 0 and macd_hist > 0:
        macd_cross = "BULLISH_CROSS"
    elif prev_hist > 0 and macd_hist < 0:
        macd_cross = "BEARISH_CROSS"
    elif macd_hist > 0:
        macd_cross = "BULLISH_MOMENTUM"
    else:
        macd_cross = "BEARISH_MOMENTUM"

    # ── EMA 20/50/200 ────────────────────────────────────────────────────────
    price = float(df["close"].iloc[-1])

    def ema_pos(val: float) -> str:
        diff = (price - val) / val * 100
        if diff > 0.1:
            return "ABOVE"
        elif diff < -0.1:
            return "BELOW"
        return "AT"

    ema20  = float(ta.trend.EMAIndicator(df["close"], window=20).ema_indicator().iloc[-1])
    ema50  = float(ta.trend.EMAIndicator(df["close"], window=50).ema_indicator().iloc[-1])
    ema200 = float(ta.trend.EMAIndicator(df["close"], window=200).ema_indicator().iloc[-1]) \
             if len(df) >= 200 else float(ta.trend.EMAIndicator(df["close"], window=len(df)).ema_indicator().iloc[-1])

    # ── Bollinger Bands(20,2) ────────────────────────────────────────────────
    bb = ta.volatility.BollingerBands(df["close"], window=20, window_dev=2)
    bb_upper = float(bb.bollinger_hband().iloc[-1])
    bb_mid   = float(bb.bollinger_mavg().iloc[-1])
    bb_lower = float(bb.bollinger_lband().iloc[-1])
    bb_width = bb_upper - bb_lower
    bb_pct_b = float((price - bb_lower) / bb_width) if bb_width != 0 else 0.5

    # ── ATR(14) ──────────────────────────────────────────────────────────────
    atr_val = float(ta.volatility.AverageTrueRange(
        df["high"], df["low"], df["close"], window=14
    ).average_true_range().iloc[-1])

    # ── Volume ───────────────────────────────────────────────────────────────
    vol_now = float(df["volume"].iloc[-1])
    vol_avg = float(df["volume"].rolling(20).mean().iloc[-1])
    vol_ratio = vol_now / vol_avg if vol_avg > 0 else 1.0

    # ── Trend bias ───────────────────────────────────────────────────────────
    if ema20 > ema50 > ema200 and price > ema20:
        trend = "BULLISH"
    elif ema20 < ema50 < ema200 and price < ema20:
        trend = "BEARISH"
    else:
        trend = "NEUTRAL"

    # ── Signal & confidence ───────────────────────────────────────────────────
    signal, confidence = _derive_signal(
        trend=trend, rsi_val=rsi_val, rsi_trend=rsi_trend,
        macd_cross=macd_cross, macd_hist=macd_hist,
        bb_pct_b=bb_pct_b, vol_ratio=vol_ratio,
    )

    return {
        "signal": signal,
        "confidence": confidence,
        "trend": trend,
        "price": round(price, 6),
        "rsi": {"value": round(rsi_val, 2), "trend": rsi_trend},
        "macd": {
            "macd": round(macd_val, 6),
            "signal": round(macd_sig, 6),
            "histogram": round(macd_hist, 6),
            "cross": macd_cross,
        },
        "ema": {
            "ema20":  round(ema20, 6),
            "ema50":  round(ema50, 6),
            "ema200": round(ema200, 6),
            "price_vs_ema20":  ema_pos(ema20),
            "price_vs_ema50":  ema_pos(ema50),
            "price_vs_ema200": ema_pos(ema200),
        },
        "bollinger": {
            "upper":   round(bb_upper, 6),
            "mid":     round(bb_mid, 6),
            "lower":   round(bb_lower, 6),
            "pct_b":   round(bb_pct_b, 4),
            "bandwidth": round(bb_width / bb_mid * 100, 4) if bb_mid else 0,
        },
        "atr": round(atr_val, 6),
        "volume": {
            "current": round(vol_now, 2),
            "avg_20":  round(vol_avg, 2),
            "ratio":   round(vol_ratio, 3),
        },
    }


def _derive_signal(
    trend, rsi_val, rsi_trend, macd_cross, macd_hist, bb_pct_b, vol_ratio
) -> tuple[str, int]:
    """Weighted scoring: max 100 pts → LONG/SHORT/SKIP."""
    long_score = 0
    short_score = 0

    # Trend (40 pts)
    if trend == "BULLISH":
        long_score += 40
    elif trend == "BEARISH":
        short_score += 40
    else:
        long_score += 10
        short_score += 10

    # RSI (20 pts)
    if rsi_trend == "OVERSOLD":
        long_score += 20
    elif rsi_trend == "OVERBOUGHT":
        short_score += 20
    elif 45 <= rsi_val <= 55:
        long_score += 5
        short_score += 5
    elif rsi_val > 55:
        long_score += 10
    else:
        short_score += 10

    # MACD (20 pts)
    if macd_cross == "BULLISH_CROSS":
        long_score += 20
    elif macd_cross == "BEARISH_CROSS":
        short_score += 20
    elif macd_cross == "BULLISH_MOMENTUM":
        long_score += 10
    elif macd_cross == "BEARISH_MOMENTUM":
        short_score += 10

    # Bollinger %B (10 pts)
    if bb_pct_b < 0.1:
        long_score += 10   # near lower band
    elif bb_pct_b > 0.9:
        short_score += 10  # near upper band
    elif 0.4 <= bb_pct_b <= 0.6:
        long_score += 3
        short_score += 3

    # Volume (10 pts)
    if vol_ratio > 2.0:
        # High volume confirms direction
        long_score += 5 if long_score >= short_score else 0
        short_score += 5 if short_score > long_score else 0
    elif vol_ratio > 1.3:
        long_score += 3 if long_score >= short_score else 0
        short_score += 3 if short_score > long_score else 0

    net = long_score - short_score
    if net >= 50:
        return "LONG", min(long_score, 100)
    elif net <= -50:
        return "SHORT", min(short_score, 100)
    elif net > 0:
        conf = min(long_score, 100)
        return ("LONG" if conf >= 50 else "SKIP"), conf
    elif net < 0:
        conf = min(short_score, 100)
        return ("SHORT" if conf >= 50 else "SKIP"), conf
    else:
        return "SKIP", 0


def calculate_sl_tp(
    entry_price: float,
    side: str,
    atr: float,
    risk_reward: float = 2.0,
) -> dict:
    """
    Calculate SL and TP based on ATR.
    SL = entry ± 2*ATR, TP = entry ± (2*ATR * risk_reward).
    """
    if side not in ("LONG", "SHORT", "SKIP"):
        side = "LONG"
    if side == "SKIP" or atr == 0:
        return {"sl": None, "tp": None, "sl_distance_pct": 0, "tp_distance_pct": 0}

    sl_dist = 2.0 * atr
    tp_dist = sl_dist * risk_reward

    if side == "LONG":
        sl = entry_price - sl_dist
        tp = entry_price + tp_dist
    else:
        sl = entry_price + sl_dist
        tp = entry_price - tp_dist

    sl_pct = sl_dist / entry_price * 100
    tp_pct = tp_dist / entry_price * 100

    return {
        "sl": round(sl, 8),
        "tp": round(tp, 8),
        "sl_distance_abs": round(sl_dist, 8),
        "tp_distance_abs": round(tp_dist, 8),
        "sl_distance_pct": round(sl_pct, 4),
        "tp_distance_pct": round(tp_pct, 4),
        "risk_reward": risk_reward,
    }


def score_opportunity(analysis: dict, funding_rate: float) -> int:
    """Score 0-100 for ranking symbols. Higher = better opportunity."""
    if analysis.get("signal") == "SKIP":
        return 0

    score = analysis.get("confidence", 0)

    rsi = analysis.get("rsi", {})
    macd = analysis.get("macd", {})
    sig = analysis.get("signal", "SKIP")

    # RSI alignment bonus (+10)
    if sig == "LONG" and rsi.get("trend") == "OVERSOLD":
        score += 10
    elif sig == "SHORT" and rsi.get("trend") == "OVERBOUGHT":
        score += 10

    # MACD fresh cross bonus (+15)
    cross = macd.get("cross", "")
    if sig == "LONG" and cross == "BULLISH_CROSS":
        score += 15
    elif sig == "SHORT" and cross == "BEARISH_CROSS":
        score += 15
    elif sig == "LONG" and cross == "BULLISH_MOMENTUM":
        score += 5
    elif sig == "SHORT" and cross == "BEARISH_MOMENTUM":
        score += 5

    # Volume bonus (+5)
    vol = analysis.get("volume", {})
    vol_ratio = vol.get("ratio", 1.0)
    if vol_ratio > 2.0:
        score += 5
    elif vol_ratio < 0.5:
        score -= 5

    # Funding rate penalty
    abs_rate = abs(funding_rate)
    if abs_rate >= 0.001:
        # Significant funding: penalise if we'd be paying
        is_paying = (sig == "LONG" and funding_rate > 0) or (sig == "SHORT" and funding_rate < 0)
        penalty = 30 if is_paying else 10
        score -= penalty
    elif abs_rate >= 0.0005:
        score -= 5

    return max(0, min(100, score))
