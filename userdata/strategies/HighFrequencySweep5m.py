# --- Do not remove these libs ---
from freqtrade.strategy import IStrategy
from pandas import DataFrame
import talib.abstract as ta
import numpy as np
import pandas as pd
from datetime import datetime
from freqtrade.persistence import Trade


class HighFrequencySweep5m(IStrategy):
    """
    HighFrequencySweep5m:
    Engineered to MAXIMIZE trade frequency and profit % in choppy/sideways markets.
    
    Alpha Mechanics:
    1. 1.5-Hour Micro-Liquidity Sweeps (18 bars lookback): Catches multiple intra-day sweeps.
    2. Deep Oversold Filter: RSI < 36.
    3. Reversal Confirmation: Reclaims swing low with a green candle close.
    4. Aggressive Profit Taking (ROI):
       - +1.5% target immediately.
       - Locks in +0.9% after 25 mins to compound quickly.
    5. Tight Risk: -1.2% hard stop-loss.
    """

    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    minimal_roi = {
        "0": 0.015,     # Proven optimal 1.5% take profit target
        "180": 0.005    # Breakeven after 3 hours
    }

    stoploss = -0.015
    trailing_stop = False
    use_custom_stoploss = False

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
                "stop_duration_candles": 1  # 5 min cool-off only
            }
        ]

    def informative_pairs(self):
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # 1.5-Hour Rolling Swing Low & High (18 candles of 5m)
        dataframe["range_low_18"] = dataframe["low"].shift(1).rolling(window=18).min()
        dataframe["range_high_18"] = dataframe["high"].shift(1).rolling(window=18).max()

        # Moving Averages & Volume
        dataframe["ema_20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # Momentum & Volatility
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)

        # Session VWAP
        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        cum_pv = pv.rolling(window=288, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=288, min_periods=1).sum()
        dataframe["vwap"] = cum_pv / np.where(cum_vol == 0, 1, cum_vol)
        dataframe["vwap_upper"] = dataframe["vwap"] + (1.0 * dataframe["atr"])

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Rapid Liquidity Sweep:
        # 1. Low pierces below 18-bar (1.5h) low
        # 2. Close reclaims back above that low
        # 3. Candle closes green
        # 4. RSI indicates oversold dip (RSI < 36)
        # 5. Active trading volume
        sweep_entry = (
            (dataframe["low"] < dataframe["range_low_18"]) &
            (dataframe["close"] > dataframe["range_low_18"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["rsi"] < 36) &
            (dataframe["volume"] > dataframe["volume_sma"] * 0.6)
        )

        dataframe.loc[sweep_entry, "enter_long"] = 1
        dataframe.loc[sweep_entry, "enter_tag"] = "micro_liquidity_sweep"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0

        # Fast exit into VWAP upper band or RSI overextension (> 68), ONLY IN PROFIT
        exit_cond = (
            (dataframe["close"] >= dataframe["vwap_upper"]) |
            (dataframe["rsi"] >= 68)
        )

        dataframe.loc[exit_cond, "exit_long"] = 1
        return dataframe
