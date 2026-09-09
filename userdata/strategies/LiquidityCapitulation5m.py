# --- Do not remove these libs ---
from freqtrade.strategy import IStrategy
from pandas import DataFrame
import talib.abstract as ta
import numpy as np
import pandas as pd
from datetime import datetime
from freqtrade.persistence import Trade


class LiquidityCapitulation5m(IStrategy):
    """
    LiquidityCapitulation5m:
    Engineered for the current choppy, range-bound market regime.
    
    Alpha Logic:
    1. Channel Expansion: Lower Bollinger Band (20, 2.2 std deviation).
    2. Capitulation / Liquidity Sweep: Price wicks below lower band into severe oversold territory (RSI < 25).
    3. Rebound Trigger: Candle prints a green reversal close back above low.
    4. Fast Take Profit: Rapid 1.5% - 2.2% mean-reversion target.
    5. Clean Bounded Risk: -2.0% hard stop-loss.
    """

    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    minimal_roi = {
        "0": 0.022,     # 2.2% target
        "25": 0.015,    # 1.5% target after 25 mins
        "60": 0.010,    # 1.0% target after 1 hr
        "120": 0.005    # 0.5% profit floor after 2 hrs
    }

    stoploss = -0.020
    trailing_stop = False

    process_only_new_candles = True
    use_exit_signal = True
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
            },
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 24,
                "trade_limit": 2,
                "stop_duration_candles": 12,
                "only_per_pair": True
            }
        ]

    def informative_pairs(self):
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Bollinger Bands (20, 2.2 std dev)
        bollinger = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.2, nbdevdn=2.2, matype=0)
        dataframe["bb_lower"] = bollinger["lowerband"]
        dataframe["bb_middle"] = bollinger["middleband"]
        dataframe["bb_upper"] = bollinger["upperband"]

        # RSI (14)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)

        # Volume confirmation
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Sweep dip: Price pierced below lower BB band with severe exhaustion (RSI < 25)
        # Rebound: Current bar closes green (buyers step in)
        reversal_dip = (
            (dataframe["low"] <= dataframe["bb_lower"]) &
            (dataframe["rsi"] < 25) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["volume"] > dataframe["volume_sma"] * 0.6)
        )

        dataframe.loc[reversal_dip, "enter_long"] = 1
        dataframe.loc[reversal_dip, "enter_tag"] = "capitulation_bounce"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0

        # Exit if price expands back above upper BB or reaches severe overbought condition (RSI > 72)
        exit_cond = (
            (dataframe["close"] >= dataframe["bb_upper"]) |
            (dataframe["rsi"] >= 72)
        )

        dataframe.loc[exit_cond, "exit_long"] = 1
        return dataframe
