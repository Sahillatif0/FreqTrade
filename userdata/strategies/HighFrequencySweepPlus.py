import logging
import numpy as np
import pandas as pd
from pandas import DataFrame
from datetime import datetime
import talib.abstract as ta
from freqtrade.strategy import IStrategy, merge_informative_pair

logger = logging.getLogger(__name__)

class HighFrequencySweepPlus(IStrategy):
    """
    HighFrequencySweepPlus:
    Refined Profit-Maximization Engine:
    1. Pure 1.5% target without prematurely cutting runners.
    2. Adaptive Breakeven:
       - Only locks stop to +0.2% when profit reaches +1.1% (giving trades breathing room to hit 1.5%).
    3. Informative BTC Trend confirmation.
    """

    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    minimal_roi = {
        "0": 0.015,
        "180": 0.005
    }

    stoploss = -0.015
    trailing_stop = False
    use_custom_stoploss = True

    process_only_new_candles = False
    use_exit_signal = False
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
                "stop_duration_candles": 1
            }
        ]

    def informative_pairs(self):
        return [("BTC/USDT", "1h")]

    def custom_stoploss(self, pair: str, trade: 'Trade', current_time: datetime,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        True Breakeven Lock:
        When trade is up +1.1%, protect it by raising stop to +0.2% (guarantees win + covers exchange fees).
        Before +1.1%, allow standard full -1.5% room so normal 5m noise doesn't trigger early stops.
        """
        if current_profit >= 0.011:
            return 0.002 - current_profit

        return -0.015

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        if self.dp:
            btc_1h = self.dp.get_pair_dataframe("BTC/USDT", "1h")
            if not btc_1h.empty:
                btc_1h["btc_ema_20"] = ta.EMA(btc_1h, timeperiod=20)
                btc_1h["btc_ema_50"] = ta.EMA(btc_1h, timeperiod=50)
                btc_1h["btc_rsi"] = ta.RSI(btc_1h, timeperiod=14)
                dataframe = merge_informative_pair(dataframe, btc_1h, self.timeframe, "1h", ffill=True)

        # 1.5-Hour Rolling Swing Low & High (18 candles of 5m)
        dataframe["range_low_18"] = dataframe["low"].shift(1).rolling(window=18).min()
        dataframe["range_high_18"] = dataframe["high"].shift(1).rolling(window=18).max()

        # Moving Averages & Volume
        dataframe["ema_20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # Momentum & Volatility
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        sweep_entry = (
            (dataframe["low"] < dataframe["range_low_18"]) &
            (dataframe["close"] > dataframe["range_low_18"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["rsi"] < 36) &
            (dataframe["volume"] > dataframe["volume_sma"] * 0.6)
        )

        if "btc_ema_20_1h" in dataframe.columns and "btc_ema_50_1h" in dataframe.columns:
            btc_bullish = (
                (dataframe["btc_ema_20_1h"] >= dataframe["btc_ema_50_1h"] * 0.995) |
                (dataframe["btc_rsi_1h"] >= 44)
            )
            sweep_entry = sweep_entry & btc_bullish

        dataframe.loc[sweep_entry, "enter_long"] = 1
        dataframe.loc[sweep_entry, "enter_tag"] = "micro_liquidity_sweep"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        return dataframe
