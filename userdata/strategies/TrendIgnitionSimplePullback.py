import logging
logger = logging.getLogger(__name__)
import numpy as np
import pandas as pd
from pandas import DataFrame
from datetime import datetime
import talib.abstract as ta
from freqtrade.strategy import IStrategy

import sys
import os
_strat_dir = os.path.dirname(os.path.abspath(__file__))
if _strat_dir not in sys.path:
    sys.path.insert(0, _strat_dir)

try:
    import portfolio_coordinator as pc
    logger.info("[TrendIgnitionSimplePullback] portfolio_coordinator loaded successfully.")
except Exception as e:
    logger.warning(f"[TrendIgnitionSimplePullback] Could not load portfolio_coordinator: {e}")
    pc = None

class TrendIgnitionSimplePullback(IStrategy):
    """
    TrendIgnitionSimplePullback (Optimized Dip-Buy Engine):
    - Replaces Breakout top-buying with EMA support retest dip entries.
    - Optimal ROI Ladder up to +4.5% peak runner.
    - Calibrated Stoploss: -2.4% with trailing stop.
    """

    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False

    minimal_roi = {
        "0": 0.045,      # Top impulse runner (+4.5%)
        "30": 0.032,     # High momentum runner (+3.2%)
        "60": 0.024,     # Core profit target (+2.4%)
        "120": 0.016,    # Standard target (+1.6%)
        "240": 0.009     # Rotation floor (+0.9%)
    }

    stoploss = -0.024

    trailing_stop = True
    trailing_stop_positive = 0.008
    trailing_stop_positive_offset = 0.015
    trailing_only_offset_is_reached = True

    process_only_new_candles = True
    use_exit_signal = True
    exit_profit_only = True
    ignore_roi_if_entry_signal = False

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False
    }

    @property
    def protections(self):
        return [
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 2
            }
        ]

    def informative_pairs(self):
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Moving Averages
        dataframe["ema_9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema_21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["ema_200"] = ta.EMA(dataframe, timeperiod=200)

        # Volume & Slopes
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()
        dataframe["ema_50_slope"] = (dataframe["ema_50"] - dataframe["ema_50"].shift(4)) / dataframe["ema_50"].shift(4) * 100

        # Momentum & Volatility
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Simple Pullback Dip Entry:
        # 1. Strong uptrend: EMA 9 > EMA 21 > EMA 50
        # 2. Price dips into EMA 9/21 support band
        # 3. RSI cooled down (46-63)
        # 4. Volume participation
        pullback_entry = (
            (dataframe["ema_9"] > dataframe["ema_21"]) &
            (dataframe["ema_21"] > dataframe["ema_50"]) &
            (dataframe["close"] > dataframe["ema_50"]) &
            (dataframe["ema_50_slope"] >= 0.015) &
            (dataframe["low"] <= dataframe["ema_9"] * 1.004) &
            (dataframe["close"] >= dataframe["ema_21"] * 0.995) &
            (dataframe["rsi"] >= 46) &
            (dataframe["rsi"] <= 63) &
            (dataframe["volume"] > dataframe["volume_sma"] * 0.7)
        )

        dataframe.loc[pullback_entry, "enter_long"] = 1
        dataframe.loc[pullback_entry, "enter_tag"] = "pullback_dip_15m"

        if len(dataframe) > 0 and bool(dataframe["enter_long"].iloc[-1]):
            if pc:
                try:
                    pc.request_preemption("TrendIgnitionSimplePullback", metadata.get("pair", ""))
                except Exception as e:
                    logger.warning(f"[TrendIgnitionSimplePullback] Preemption request error: {e}")

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        dataframe.loc[:, "exit_tag"] = ""

        # Trend exhaustion exit: candle closes below EMA 21 and EMA 9 breaks EMA 21
        trend_broken = (
            (dataframe["close"] < dataframe["ema_21"]) &
            (dataframe["ema_9"] < dataframe["ema_21"])
        )

        dataframe.loc[trend_broken, "exit_long"] = 1
        dataframe.loc[trend_broken, "exit_tag"] = "trend_exhaustion"

        return dataframe

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float,
                            time_in_force: str, current_time, entry_tag: str,
                            side: str, **kwargs) -> bool:
        if pc:
            try:
                pc.confirm_entry("TrendIgnitionSimplePullback", pair)
            except Exception as e:
                logger.warning(f"[TrendIgnitionSimplePullback] Confirm entry error: {e}")
        return True

    def confirm_trade_exit(self, pair: str, trade: 'Trade', order_type: str, amount: float,
                           rate: float, time_in_force: str, exit_reason: str,
                           current_time, **kwargs) -> bool:
        if pc:
            try:
                pc.confirm_exit("TrendIgnitionSimplePullback", pair)
            except Exception as e:
                logger.warning(f"[TrendIgnitionSimplePullback] Confirm exit error: {e}")
        return True
