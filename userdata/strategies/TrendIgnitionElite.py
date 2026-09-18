import logging
import numpy as np
import pandas as pd
from pandas import DataFrame
from datetime import datetime
import talib.abstract as ta
from freqtrade.strategy import IStrategy

logger = logging.getLogger(__name__)

class TrendIgnitionElite(IStrategy):
    """
    TrendIgnitionElite:
    Engineered to capture strong market trends and breakout pumps on the 15m timeframe.
    Complements HighFrequencySweepElite7 (which catches bottom flush reversals on 5m).

    Architecture:
    1. Trend Ignition Gating (15m):
       - Fast EMA 9 crosses above Trend EMA 21
       - Macro Bull Filter: Close > Baseline EMA 50
       - Momentum Momentum Zone: RSI 50 - 68 (Strong momentum without being overbought)
       - Volume Confirmation: Volume > 0.9x 20-period Volume SMA
    2. Dynamic Exit Engine:
       - Trailing profit targets up to +4.5%
       - Trend-exhaustion exit: Candle closes below EMA 21 to lock in run gains
       - Structural Stop Loss: -2.8% (Provides breathing room for normal uptrend retracements)
    """

    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False

    # Tuned Runner Profit Ladder: Captures sweet spot peaks (+1.8% to +2.8%) cleanly
    minimal_roi = {
        "0": 0.028,      # Top-tier impulse target (+2.8%)
        "30": 0.019,     # Fast momentum runner (+1.9%)
        "75": 0.013,     # Mid-range target (+1.3%)
        "150": 0.008     # Capital rotation floor (+0.8%)
    }

    stoploss = -0.022

    trailing_stop = True
    trailing_stop_positive = 0.007
    trailing_stop_positive_offset = 0.013
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

        # 15m Trend Ignition Confirmation
        trend_ignition = (
            # 1. Moving average cross (EMA 9 crosses over EMA 21)
            (dataframe["ema_9"] > dataframe["ema_21"]) &
            (dataframe["ema_9"].shift(1) <= dataframe["ema_21"].shift(1)) &

            # 2. Bullish Macro Trend Confirmation
            (dataframe["close"] > dataframe["ema_50"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["ema_50_slope"] >= 0.02) &

            # 3. High-Conviction Momentum Sweet Spot (eliminates choppy 50-54 crosses)
            (dataframe["rsi"] >= 55) &
            (dataframe["rsi"] <= 68) &

            # 4. Volume participation
            (dataframe["volume"] > dataframe["volume_sma"] * 0.9)
        )

        dataframe.loc[trend_ignition, "enter_long"] = 1
        dataframe.loc[trend_ignition, "enter_tag"] = "trend_ignition_15m"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        dataframe.loc[:, "exit_tag"] = ""

        # Exit when trend momentum breaks: candle closes below EMA 21
        trend_broken = (
            (dataframe["close"] < dataframe["ema_21"]) &
            (dataframe["ema_9"] < dataframe["ema_21"])
        )

        dataframe.loc[trend_broken, "exit_long"] = 1
        dataframe.loc[trend_broken, "exit_tag"] = "trend_exhaustion"

        return dataframe
