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
            # Solution 2: If a pair hits 1 Stoploss, pause that specific pair for 8 candles (2 hours)
            # Baqi pairs freely trade karenge. Prevents consecutive bleed on AAVE/TIA.
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 12,
                "trade_limit": 1,
                "stop_duration_candles": 8,
                "only_per_pair": True
            },
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 2
            }
        ]

    def informative_pairs(self):
        return [("BTC/USDT", "1h")]

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Informative BTC/USDT 1h Trend Gate
        if self.dp:
            btc_1h = self.dp.get_pair_dataframe("BTC/USDT", "1h")
            if not btc_1h.empty:
                btc_1h["btc_ema_20"] = ta.EMA(btc_1h, timeperiod=20)
                from freqtrade.strategy import merge_informative_pair
                dataframe = merge_informative_pair(
                    dataframe, btc_1h, self.timeframe, "1h", ffill=True
                )

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
        dataframe["adx"] = ta.ADX(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # BTC 1h Bull Market Gate (Trade only when macro market is healthy)
        btc_gate = True
        if "btc_ema_20_1h" in dataframe.columns and "close_1h" in dataframe.columns:
            btc_gate = (dataframe["close_1h"] > dataframe["btc_ema_20_1h"])

        # Exact Pullback Dip Entry:
        pullback = (
            btc_gate &
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
