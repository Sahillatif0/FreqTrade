import logging
logger = logging.getLogger(__name__)
import os
import sys

_strat_dir = os.path.dirname(os.path.abspath(__file__))
if _strat_dir not in sys.path:
    sys.path.insert(0, _strat_dir)

try:
    import portfolio_coordinator as pc
    logger.info("[HighFrequencySweepApex5m] portfolio_coordinator loaded successfully.")
except Exception as e:
    logger.warning(f"[HighFrequencySweepApex5m] Could not load portfolio_coordinator: {e}")
    pc = None
import numpy as np
import pandas as pd
from pandas import DataFrame
from datetime import datetime
import talib.abstract as ta
from freqtrade.strategy import IStrategy
from freqtrade.persistence import Trade


class HighFrequencySweepApex5m(IStrategy):
    """
    HighFrequencySweepApex5m:
    Portfolio engineered with optimal 6-pair set:
    SUI/USDT, TAO/USDT, DOT/USDT, INJ/USDT, NEAR/USDT, TIA/USDT.
    """

    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    minimal_roi = {
        "0": 0.0220,    # Cap runner target at +2.20%
        "180": 0.008    # Breakeven after 3 hours
    }

    stoploss = -0.016
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
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # 1.5-Hour Rolling Swing Low & High (18 candles of 5m)
        dataframe["range_low_18"] = dataframe["low"].shift(1).rolling(window=18).min()
        dataframe["range_high_18"] = dataframe["high"].shift(1).rolling(window=18).max()

        # Moving Averages & Volume
        dataframe["ema_20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # Momentum & Volatility
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)

        # Candlestick anatomy: Body size, candle range, and lower rejection wick
        dataframe["candle_range"] = dataframe["high"] - dataframe["low"]
        dataframe["body"] = (dataframe["close"] - dataframe["open"]).abs()
        dataframe["body_ratio"] = dataframe["body"] / dataframe["candle_range"].replace(0, np.nan)
        dataframe["lower_wick"] = (dataframe[["open", "close"]].min(axis=1) - dataframe["low"])

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Top Alpha Rotation Set
        #allowed_pairs = [
        #    "TAO/USDT", "SUI/USDT", "INJ/USDT"
        #]
        #if metadata.get("pair") not in allowed_pairs:
        #    return dataframe

        sweep_entry = (
            (dataframe["low"] < dataframe["range_low_18"]) &
            (dataframe["close"] > dataframe["range_low_18"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["body_ratio"] >= 0.12) &
            (dataframe["lower_wick"] >= dataframe["body"] * 0.5) &
            (dataframe["close"] > dataframe["ema_50"] * 0.985) &
            (dataframe["rsi"] >= 24) & (dataframe["rsi"] < 36) &
            (dataframe["volume"] > dataframe["volume_sma"] * 0.7)
        )

        dataframe.loc[sweep_entry, "enter_long"] = 1
        dataframe.loc[sweep_entry, "enter_tag"] = "micro_liquidity_sweep"

        if len(dataframe) > 0 and bool(dataframe["enter_long"].iloc[-1]):
            if pc:
                try:
                    pc.request_preemption("HighFrequencySweepApex5m", metadata.get("pair", ""))
                except Exception as e:
                    logger.warning(f"[HighFrequencySweepApex5m] Preemption error: {e}")

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        return dataframe

    def custom_exit(self, pair: str, trade: 'Trade', current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs):
        """Preempts if higher priority strategy (TTM=3 or TIE=2) requested balance"""
        if pc:
            try:
                state = pc.get_state()
                pending = state.get("pending_intent")
                if pending and pending.get("status") == "WAITING_FOR_BALANCE":
                    if pending.get("priority", 1) > 1:
                        logger.info(f"[HighFrequencySweepApex5m] Preempting for higher priority: {pending.get('strategy')}")
                        return "preempted_for_high_priority"
            except Exception as e:
                logger.warning(f"[HighFrequencySweepApex5m] Coordinator check error: {e}")
        return None

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float,
                            time_in_force: str, current_time: datetime, entry_tag: str,
                            side: str, **kwargs) -> bool:
        if pc:
            try:
                pc.confirm_entry("HighFrequencySweepApex5m", pair)
            except Exception as e:
                logger.warning(f"[HighFrequencySweepApex5m] Confirm entry error: {e}")
        return True

    def confirm_trade_exit(self, pair: str, trade: 'Trade', order_type: str, amount: float,
                           rate: float, time_in_force: str, exit_reason: str,
                           current_time: datetime, **kwargs) -> bool:
        if pc:
            try:
                pc.confirm_exit("HighFrequencySweepApex5m", pair)
            except Exception as e:
                logger.warning(f"[HighFrequencySweepApex5m] Confirm exit error: {e}")
        return True
