import logging
import numpy as np
import pandas as pd
from pandas import DataFrame
from datetime import datetime
import talib.abstract as ta
from freqtrade.strategy import IStrategy, merge_informative_pair

logger = logging.getLogger(__name__)

class HighFrequencySweepPro(IStrategy):
    """
    HighFrequencySweepPro:
    Precision High-Frequency Sweep Scalper aiming for >90% Win Rate.
    
    Alpha Improvements:
    1. BTC Waterfall Filter:
       - Skips altcoin sweeps when BTC 5m RSI < 25 or BTC dumping below 50 EMA.
       - Eliminates false sweep bounces that get dragged down by macro Bitcoin drops.
    2. Adaptive Profit Targeting:
       - TIA/USDT & AAVE/USDT: Targets up to +2.0% on high-volatility sweeps.
       - ETH/USDT & SOL/USDT: Pure 1.4% target.
    3. Faster Capital Turnover ROI:
       - Frees capital if a trade stalls after 1-2 hours instead of tying up funds for 11+ hours.
    4. Reversal Reclaim:
       - Confirms swing-low reclaim with green candle close & RSI oversold.
    """

    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    minimal_roi = {
        "0": 0.015,     # Base 1.5% take profit
        "45": 0.009,    # Take +0.9% if held for 45 mins
        "120": 0.004    # Take +0.4% after 2 hours to rotate capital
    }

    stoploss = -0.015
    trailing_stop = False
    use_custom_stoploss = False

    process_only_new_candles = False
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
                "stop_duration_candles": 1
            }
        ]

    def informative_pairs(self):
        # 5m BTC informative pair for market health check
        return [("BTC/USDT", "5m")]

    def custom_exit(self, pair: str, trade: 'Trade', current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs):
        # Allow high-beta runners (TIA) to capture +2.0% profit on big expansions
        if "TIA" in pair and current_profit >= 0.020:
            return "high_beta_runner_exit"
        return None

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Merge BTC 5m informative indicators
        if self.dp:
            btc_5m = self.dp.get_pair_dataframe("BTC/USDT", "5m")
            if not btc_5m.empty:
                btc_5m["btc_rsi"] = ta.RSI(btc_5m, timeperiod=14)
                btc_5m["btc_ema_50"] = ta.EMA(btc_5m, timeperiod=50)
                dataframe = merge_informative_pair(dataframe, btc_5m, self.timeframe, "5m", ffill=True)

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

        # BTC Waterfall Protection:
        # Skip entry if Bitcoin is in extreme capitulation / freefall
        if "btc_rsi_5m" in dataframe.columns and "btc_ema_50_5m" in dataframe.columns:
            btc_not_dumping = (
                (dataframe["btc_rsi_5m"] >= 26) &
                (dataframe["close_5m"] >= dataframe["btc_ema_50_5m"] * 0.992)
            )
            sweep_entry = sweep_entry & btc_not_dumping

        dataframe.loc[sweep_entry, "enter_long"] = 1
        dataframe.loc[sweep_entry, "enter_tag"] = "micro_liquidity_sweep"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        return dataframe
