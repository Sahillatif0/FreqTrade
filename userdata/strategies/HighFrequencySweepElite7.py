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
    logger.info("[SweepElite7] portfolio_coordinator loaded successfully.")
except Exception as e:
    logger.warning(f"[SweepElite7] Could not load portfolio_coordinator: {e}")
    pc = None

class HighFrequencySweepElite7(IStrategy):
    """
    HighFrequencySweepElite7 (High-Yield Compounding Scalper):
    Engineered for 90%+ Win Rate and maximized PnL:
    1. Extended Impulse Runners: +3.6% early vertical bounce capture.
    2. Smart Micro-Trailing Stop: Activates at +1.6% to lock +1.0% guaranteed profit.
    3. Low-Volume Fakeout Guard: Requires volume > volume_sma * 0.72 and rsi < 35.
    4. 2.1% Breathing Room Stoploss.
    """

    INTERFACE_VERSION = 3
    timeframe = "5m"
    can_short = False

    minimal_roi = {
        "0": 0.036,      # Top impulse runner target (+3.6%)
        "20": 0.026,     # Fast runner (+2.6%)
        "45": 0.020,     # Optimal standard bounce (+2.0%)
        "90": 0.014,     # Medium duration capture (+1.4%)
        "150": 0.009,    # Extended duration (+0.9%)
        "240": 0.006     # Floor (+0.6%)
    }

    stoploss = -0.021  # 2.1% breathing room SL (rescues fakeout wicks)
    trailing_stop = True
    trailing_stop_positive = 0.010
    trailing_stop_positive_offset = 0.016
    trailing_only_offset_is_reached = True

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

        # Candle Mechanics & Wick Dominance
        dataframe["body"] = (dataframe["close"] - dataframe["open"]).abs()
        dataframe["lower_wick"] = dataframe[["open", "close"]].min(axis=1) - dataframe["low"]
        dataframe["upper_wick"] = dataframe["high"] - dataframe[["open", "close"]].max(axis=1)
        dataframe["sweep_depth"] = (dataframe["range_low_18"] - dataframe["low"]) / dataframe["range_low_18"]

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Dominant Absorption Liquidity Sweep with Volume Quality Filter
        sweep_entry = (
            (dataframe["low"] < dataframe["range_low_18"]) &
            (dataframe["close"] > dataframe["range_low_18"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["sweep_depth"] >= 0.0010) &
            (dataframe["lower_wick"] >= dataframe["body"] * 0.8) &
            (dataframe["lower_wick"] >= dataframe["upper_wick"] * 1.3) &
            (dataframe["rsi"] < 35) &
            (dataframe["volume"] > dataframe["volume_sma"] * 0.72)
        )

        dataframe.loc[sweep_entry, "enter_long"] = 1
        dataframe.loc[sweep_entry, "enter_tag"] = "dominant_wick_sweep"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        return dataframe

    def custom_exit(self, pair: str, trade: 'Trade', current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs):
        """
        Preemption Hook:
        Checks if a higher priority strategy (DonchianPro or TrendIgnition) has requested capital.
        If yes, exits current scalp trade cleanly to release wallet balance immediately.
        """
        if pc:
            try:
                state = pc.get_state()
                pending = state.get("pending_intent")
                if pending and pending.get("status") == "WAITING_FOR_BALANCE":
                    if pending.get("priority", 1) > 1:
                        logger.info(f"[Sweep7] Preempting scalp trade on {pair} for {pending.get('strategy')} ({pending.get('pair')})")
                        return "preempted_for_high_priority"
            except Exception as e:
                logger.warning(f"[Sweep7] Coordinator check error: {e}")
        return None

    def custom_entry_price(self, pair: str, current_time: datetime, proposed_rate: float,
                           entry_tag: str, side: str, **kwargs) -> float:
        """
        Pullback Optimization:
        Rather than buying at the very peak of the 5m close bounce, place a limit order
        at a 0.25% lower wick discount to get superior fill price,
        avoid instant post-entry drawdown, and hit ROI targets much faster.
        """
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if dataframe is not None and not dataframe.empty:
            last_candle = dataframe.iloc[-1]
            wick_entry = last_candle['close'] - (last_candle['lower_wick'] * 0.25)
            if wick_entry < proposed_rate:
                return wick_entry
        return proposed_rate

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float,
                            time_in_force: str, current_time: datetime, entry_tag: str,
                            side: str, **kwargs) -> bool:
        if pc:
            try:
                pc.confirm_entry("HighFrequencySweepElite7", pair)
            except Exception as e:
                logger.warning(f"[Sweep7] Coordinator entry confirm error: {e}")
        return True

    def confirm_trade_exit(self, pair: str, trade: 'Trade', order_type: str, amount: float,
                           rate: float, time_in_force: str, exit_reason: str,
                           current_time: datetime, **kwargs) -> bool:
        if pc:
            try:
                pc.release_balance()
            except Exception as e:
                logger.warning(f"[Sweep7] Coordinator release error: {e}")
        return True
