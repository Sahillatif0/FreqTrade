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
    TrendIgnitionSimplePullback (36.2% Tested Engine):
    - Exact logic from backtest-result-2026-09-26_10-42-49 (SL -2.4%).
    - EMA 9 touch + green candle rebound confirmation (close > open).
    - ROI targets: 3.5% -> 2.4% -> 1.8% -> 1.2% -> 0.8%.
    - Wide trailing stop to allow full runner expansion.
    """

    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False
 
    minimal_roi = {
        "0": 0.038,
        "15": 0.030,
        "45": 0.021,
        "90": 0.017,
        "180": 0.012,
        "360": 0.005
    }

    stoploss = -0.024


    trailing_stop = True
    trailing_stop_positive = 0.011
    trailing_stop_positive_offset = 0.022
    trailing_only_offset_is_reached = True

    process_only_new_candles = True
    use_exit_signal = False
    exit_profit_only = False
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

        # Exact Pullback Dip Entry from 36.2% test:
        pullback = (
            (dataframe["ema_9"] > dataframe["ema_21"]) &
            (dataframe["close"] > dataframe["ema_50"]) &
            (dataframe["ema_50_slope"] >= 0.015) &
            (dataframe["low"] <= dataframe["ema_9"] * 1.002) &
            (dataframe["close"] >= dataframe["ema_9"] * 0.998) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["rsi"] >= 46) & (dataframe["rsi"] <= 63) &
            (dataframe["volume"] > dataframe["volume_sma"] * 0.75)
        )

        dataframe.loc[pullback, "enter_long"] = 1
        dataframe.loc[pullback, "enter_tag"] = "pullback_dip_entry"

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
