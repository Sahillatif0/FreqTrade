# --- Do not remove these libs ---
from freqtrade.strategy import IStrategy
from pandas import DataFrame
import talib.abstract as ta
import numpy as np
import pandas as pd
from datetime import datetime
from freqtrade.persistence import Trade


class SmartLiquiditySweep5m(IStrategy):
    """
    SmartLiquiditySweep5m:
    Engineered directly for current sideways, range-bound, and choppy markets.
    
    The Edge (ICT / SMC Turtle Soup):
    - In sideways markets, buying breakouts fails because market makers hunt stops and reverse.
    - Instead, this strategy waits for institutional liquidity sweeps:
      1. Price pierces below the 4-Hour rolling swing low (48 candles on 5m).
      2. Price immediately rejects the sweep and reclaims back above the 4-Hour low.
      3. Candle closes green with oversold exhaustion (RSI < 38).
      4. Quick take-profit into the range mean (+1.5% to +2.0%), keeping exposure minimal.
      5. Strict hard stop-loss at -1.5% to limit downside.
    """

    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    minimal_roi = {
        "0": 0.018,     # 1.8% target
        "15": 0.015,    # 1.5% target after 15 mins
        "40": 0.009,    # 0.9% target after 40 mins
        "90": 0.004     # Breakeven floor after 1.5 hrs
    }

    stoploss = -0.012
    trailing_stop = False

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
        # 4-Hour Rolling Swing Low & High (48 bars of 5m)
        dataframe["range_low_4h"] = dataframe["low"].shift(1).rolling(window=48).min()
        dataframe["range_high_4h"] = dataframe["high"].shift(1).rolling(window=48).max()

        # Moving Averages
        dataframe["ema_20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)

        # Volume confirmation
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
        dataframe["vwap_upper"] = dataframe["vwap"] + (1.2 * dataframe["atr"])

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Turtle Soup / Liquidity Spring:
        # 1. Low penetrated below 4h range low (stop-hunt)
        # 2. Close reclaimed back above 4h range low (fakeout confirmed)
        # 3. Candle closed green (buyers stepped in)
        # 4. RSI indicates oversold pullback (RSI < 38)
        # 5. Non-dead volume
        sweep_reclaim = (
            (dataframe["low"] < dataframe["range_low_4h"]) &
            (dataframe["close"] > dataframe["range_low_4h"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["rsi"] < 32) &
            (dataframe["volume"] > dataframe["volume_sma"] * 0.7)
        )

        dataframe.loc[sweep_reclaim, "enter_long"] = 1
        dataframe.loc[sweep_reclaim, "enter_tag"] = "turtle_soup_sweep"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0

        # Take profit exit into VWAP upper band or overbought RSI (> 68), ONLY IN PROFIT
        exit_cond = (
            (dataframe["close"] >= dataframe["vwap_upper"]) |
            (dataframe["rsi"] >= 68)
        )

        dataframe.loc[exit_cond, "exit_long"] = 1
        return dataframe
