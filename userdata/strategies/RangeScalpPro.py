# --- Do not remove these libs ---
from freqtrade.strategy import IStrategy
from pandas import DataFrame
import talib.abstract as ta
import numpy as np
import pandas as pd
from datetime import datetime
from freqtrade.persistence import Trade


class RangeScalpPro(IStrategy):
    """
    RangeScalpPro: Engineered specifically for sideways, range-bound, and choppy markets.
    
    Architecture:
    1. Channel Identification: Bollinger Bands (20, 2.0 std) + Keltner Channel confirmation.
    2. Liquidity Sweep: Price punches below Lower BB / Keltner, then wicks or reclaims.
    3. Oscillator Filter: RSI < 35 with StochRSI bullish cross.
    4. Fast Mean Reversion Take-Profit: Exits at VWAP / 20-SMA mean or upper band.
    5. Adaptive Stoploss: Tight 1.8% to keep risk strictly bounded.
    """

    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    # Fast TP ROI targeted at range bounces
    minimal_roi = {
        "0": 0.024,      # 2.4% maximum target
        "20": 0.015,     # 1.5% after 20 mins
        "45": 0.008,     # 0.8% after 45 mins
        "90": 0.004      # Scratch/breakeven after 90 mins
    }

    stoploss = -0.018
    trailing_stop = True
    trailing_stop_positive = 0.008
    trailing_stop_positive_offset_pnl = 0.014
    trailing_only_offset_is_reached = True

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

    def informative_pairs(self):
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Bollinger Bands (20, 2.0 std)
        bollinger = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.0, nbdevdn=2.0, matype=0)
        dataframe["bb_lower"] = bollinger["lowerband"]
        dataframe["bb_middle"] = bollinger["middleband"]
        dataframe["bb_upper"] = bollinger["upperband"]

        # Keltner / ATR Bands
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        dataframe["ema_20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["keltner_lower"] = dataframe["ema_20"] - (1.5 * dataframe["atr"])
        dataframe["keltner_upper"] = dataframe["ema_20"] + (1.5 * dataframe["atr"])

        # RSI & Stochastic RSI
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        stoch = ta.STOCHRSI(dataframe, timeperiod=14, fastk_period=3, fastd_period=3)
        dataframe["fastk"] = stoch["fastk"]
        dataframe["fastd"] = stoch["fastd"]

        # Volume confirmation
        dataframe["volume_mean"] = dataframe["volume"].rolling(window=20).mean()

        # Session VWAP
        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        cum_pv = pv.rolling(window=288, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=288, min_periods=1).sum()
        dataframe["vwap"] = cum_pv / np.where(cum_vol == 0, 1, cum_vol)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Condition: Range Low Liquidity Sweep + Rebound
        # 1. Price touched or dipped below the lower Bollinger Band or Keltner channel
        dip_below_band = (dataframe["low"] <= dataframe["bb_lower"]) | (dataframe["low"] <= dataframe["keltner_lower"])
        
        # 2. Bullish candle close or rejection wick off the low
        candle_rebound = (dataframe["close"] > dataframe["open"]) | (dataframe["close"] > dataframe["bb_lower"])
        
        # 3. Oversold oscillator conditions
        oversold = (dataframe["rsi"] <= 35) & (dataframe["fastk"] > dataframe["fastd"])
        
        # 4. Volume present (avoid dead volume bars)
        has_volume = dataframe["volume"] > (dataframe["volume_mean"] * 0.5)

        entry_cond = dip_below_band & candle_rebound & oversold & has_volume

        dataframe.loc[entry_cond, "enter_long"] = 1
        dataframe.loc[entry_cond, "enter_tag"] = "range_oversold_bounce"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0

        # Exit when price reaches the upper half of the range (Middle BB / VWAP) or overbought RSI
        exit_cond = (
            (dataframe["close"] >= dataframe["bb_middle"]) &
            (dataframe["rsi"] >= 62)
        ) | (
            (dataframe["close"] >= dataframe["bb_upper"])
        )

        dataframe.loc[exit_cond, "exit_long"] = 1
        return dataframe
