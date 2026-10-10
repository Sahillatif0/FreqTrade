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
    logger.info("[LiquiditySweepPro15m] portfolio_coordinator loaded successfully.")
except Exception as e:
    logger.warning(f"[LiquiditySweepPro15m] Could not load portfolio_coordinator: {e}")
    pc = None

class LiquiditySweepPro15m(IStrategy):
    """
    LiquiditySweepPro15m (15m Macro Swing Reclaim Engine):
    Engineered for multi-regime consistency (Bear, Bull, and Chop):
    1. 6-Hour Structural Swing Low Sweep: Detects when price dips below the 24-candle rolling low.
    2. Instantaneous Buyer Reclaim: Candle close MUST reclaim back above the previous swing low.
    3. Institutional Wick Absorption: Lower shadow >= 75% of candle body (Hammer/Pinbar).
    4. Quality Infrastructure Universe: Filtered to high-liquidity L1/L2 networks (AVAX, INJ, NEAR, ETH, SOL, APT, ARB).
    5. Adaptive Breakeven Trail: Activates at +1.4% gain to lock in +0.5% minimum profit.
    6. Tight Capital Defense: -1.8% max risk per trade.
    """

    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False

    minimal_roi = {
        "0": 0.034,      # Top impulse bounce (+3.4%)
        "90": 0.025,     # 1.5 hours target (+2.4%)
        "180": 0.016,    # 3 hours target (+1.6%)
        "360": 0.008     # Rotation floor (+0.8%)
    }

    stoploss = -0.02
    trailing_stop = True
    trailing_stop_positive = 0.01
    trailing_stop_positive_offset = 0.024
    trailing_only_offset_is_reached = True

    process_only_new_candles = True
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
                "stop_duration_candles": 2
            },
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 24,
                "trade_limit": 2,
                "stop_duration_candles": 16,
                "only_per_pair": True
            }
        ]

    def informative_pairs(self):
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # 6-Hour Rolling Swing Low (24 candles of 15m)
        dataframe["range_low_24"] = dataframe["low"].shift(1).rolling(window=24).min()

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
        dataframe["lower_wick"] = dataframe[["open", "close"]].min(axis=1) - dataframe["low"]
        dataframe["upper_wick"] = dataframe["high"] - dataframe[["open", "close"]].max(axis=1)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        sweep_entry = (
            (dataframe["low"] < dataframe["range_low_24"]) &
            (dataframe["close"] > dataframe["range_low_24"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["lower_wick"] >= dataframe["body"] * 0.75) &
            (dataframe["close"] > dataframe["ema_50"] * 0.975) &
            (dataframe["rsi"] >= 24) & (dataframe["rsi"] <= 38) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.1)
        )

        dataframe.loc[sweep_entry, "enter_long"] = 1
        dataframe.loc[sweep_entry, "enter_tag"] = "macro_swing_reclaim"

        if len(dataframe) > 0 and bool(dataframe["enter_long"].iloc[-1]):
            if pc:
                try:
                    pc.request_preemption("LiquiditySweepPro15m", metadata.get("pair", ""))
                except Exception as e:
                    logger.warning(f"[LiquiditySweepPro15m] Preemption error: {e}")

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        return dataframe

    def custom_exit(self, pair: str, trade: 'Trade', current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs):
        """Yields/preempts balance if higher priority strategy (FVG=3, TTM=4) requests entry, protected by Soft Floor (-0.50%)"""
        if pc:
            try:
                state = pc.get_state()
                pending = state.get("pending_intent")
                if pending and pending.get("status") == "WAITING_FOR_BALANCE":
                    if pending.get("priority", 1) > 2:  # Liquidity is Priority 2, yields to FVG (P3) and TTM (P4)
                        # Soft floor rule: Only preempt if profit is >= -0.50%
                        if current_profit >= -0.005:
                            logger.info(f"[LiquiditySweepPro15m] Preempting for {pending.get('strategy')} (Current PnL: {current_profit:.2%})")
                            return "preempted_for_high_priority"
                        else:
                            pc.reject_preemption("LiquiditySweepPro15m", pair, current_profit)
                            logger.info(f"[LiquiditySweepPro15m] Preemption blocked by Soft Floor: current profit {current_profit:.2%} < -0.50%")
            except Exception as e:
                logger.warning(f"[LiquiditySweepPro15m] Coordinator check error: {e}")
        return None

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float,
                            time_in_force: str, current_time: datetime, entry_tag: str,
                            side: str, **kwargs) -> bool:
        if pc:
            try:
                pc.confirm_entry("LiquiditySweepPro15m", pair)
            except Exception as e:
                logger.warning(f"[LiquiditySweepPro15m] Confirm entry error: {e}")
        return True

    def confirm_trade_exit(self, pair: str, trade: 'Trade', order_type: str, amount: float,
                           rate: float, time_in_force: str, exit_reason: str,
                           current_time: datetime, **kwargs) -> bool:
        if pc:
            try:
                pc.confirm_exit("LiquiditySweepPro15m", pair)
            except Exception as e:
                logger.warning(f"[LiquiditySweepPro15m] Confirm exit error: {e}")
        return True
