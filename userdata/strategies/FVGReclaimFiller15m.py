import logging
logger = logging.getLogger(__name__)
import numpy as np
import pandas as pd
from pandas import DataFrame
from datetime import datetime
import talib.abstract as ta
from freqtrade.strategy import IStrategy, merge_informative_pair
import sys
import os

_strat_dir = os.path.dirname(os.path.abspath(__file__))
if _strat_dir not in sys.path:
    sys.path.insert(0, _strat_dir)

try:
    import portfolio_coordinator as pc
    logger.info("[FVGReclaimFiller15m] portfolio_coordinator loaded successfully.")
except Exception as e:
    logger.warning(f"[FVGReclaimFiller15m] Could not load portfolio_coordinator: {e}")
    pc = None

class FVGReclaimFiller15m(IStrategy):
    """
    FVGReclaimFiller15m (Institutional Imbalance Reclaim Engine):
    Designed to monetize quiet market gaps between violent sweeps and squeezes.
    
    Mechanisms:
    1. Detects bullish Fair Value Gaps (FVG) where Candle 3 Low > Candle 1 High * 1.008.
    2. Enters when price retraces to retest the imbalance zone above 50 EMA.
    3. Target: +3.00% clean exit, Stoploss: -1.60%.
    4. Protected by -0.50% Soft Floor coordinator hook.
    """

    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False

    minimal_roi = {
        "0": 0.025,      # Optimal take profit target at +2.5%
        "180": 0.015,    # After 3 hours decay to +1.5%
        "360": 0.006     # Capital turnover threshold at +0.6% after 6 hours
    }

    stoploss = -0.016
    trailing_stop = False
    trailing_stop_positive = 0.008
    trailing_stop_positive_offset = 0.020
    trailing_only_offset_is_reached = True

    process_only_new_candles = True
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "limit",
        "stoploss_on_exchange": True,
        "stoploss_on_exchange_limit_ratio": 0.99
    }

    @property
    def protections(self):
        return [
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 1
            },
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 24,
                "trade_limit": 2,
                "stop_duration_candles": 16,
                "only_per_pair": False
            },
            {
                "method": "MaxDrawdown",
                "lookback_period_candles": 96,
                "trade_limit": 1,
                "stop_duration_candles": 48,
                "max_allowed_drawdown": 0.05
            }
        ]

    def informative_pairs(self):
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Macro trend and momentum filters
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["ema_100"] = ta.EMA(dataframe, timeperiod=100)
        dataframe["adx"] = ta.ADX(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()
        
        # Extension filter: prevent chasing parabolic exhaustion tops (> 8.0% above 50 EMA)
        dataframe["dist_ema50"] = (dataframe["close"] - dataframe["ema_50"]) / dataframe["ema_50"] * 100
        
        # 3-Candle Fair Value Gap Detection
        # Candle 1: shift(2), Candle 2: shift(1), Candle 3: shift(0)
        dataframe["fvg_high"] = dataframe["low"]
        dataframe["fvg_low"] = dataframe["high"].shift(2)
        
        # Bullish imbalance formed when Candle 3 low is strictly above Candle 1 high with >= 0.8% gap
        dataframe["has_fvg"] = (dataframe["fvg_high"].shift(1) > dataframe["fvg_low"].shift(1) * 1.008)
        
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # High-Precision 85%+ FVG Reclaim Engine:
        # 2. Bullish FVG created recently
        # 3. Price retraced into the gap (low <= fvg_high of gap)
        # 4. Price holds above gap floor (close > fvg_low of gap)
        # 5. Bullish rejection confirmation (close > open)
        # 6. Macro trend alignment: price above both 50 EMA and 100 EMA
        # 7. Trend strength filter: ADX >= 16 (eliminates dead-market fakeouts)
        # 8. Climax filter: distance to 50 EMA <= 8.0% (avoids buying exhausted tops)
        fvg_retest = (
            dataframe["has_fvg"].shift(1) &
            (dataframe["low"] <= dataframe["fvg_high"].shift(2)) &
            (dataframe["close"] > dataframe["fvg_low"].shift(2)) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["close"] > dataframe["ema_50"]) &
            (dataframe["close"] > dataframe["ema_100"]) &
            (dataframe["adx"] >= 16) &
            (dataframe["dist_ema50"] <= 8.0)
        )

        dataframe.loc[fvg_retest, "enter_long"] = 1
        dataframe.loc[fvg_retest, "enter_tag"] = "fvg_retest_bounce"

        if len(dataframe) > 0 and bool(dataframe["enter_long"].iloc[-1]):
            if pc:
                try:
                    pc.request_preemption("FVGReclaimFiller15m", metadata.get("pair", ""))
                except Exception as e:
                    logger.warning(f"[FVGReclaimFiller15m] Preemption request error: {e}")

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        return dataframe

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float,
                            time_in_force: str, current_time: datetime, entry_tag: str,
                            side: str, **kwargs) -> bool:
        if self.dp and self.dp.runmode.value in ('backtest', 'hyperopt'):
            return True

        if pc:
            try:
                if not pc.can_enter("FVGReclaimFiller15m", pair):
                    logger.info(f"[FVGReclaimFiller15m] Entry blocked by Portfolio Coordinator for {pair}")
                    return False
                pc.confirm_entry("FVGReclaimFiller15m", pair)
            except Exception as e:
                logger.warning(f"[FVGReclaimFiller15m] Coordinator error: {e}")
        return True

    def confirm_trade_exit(self, pair: str, trade: 'Trade', order_type: str, amount: float,
                           rate: float, time_in_force: str, exit_reason: str,
                           current_time: datetime, **kwargs) -> bool:
        if pc:
            try:
                pc.confirm_exit("FVGReclaimFiller15m", pair)
            except Exception as e:
                logger.warning(f"[FVGReclaimFiller15m] Coordinator error: {e}")
        return True

    def custom_exit(self, pair: str, trade: 'Trade', current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs):
        """Yields to Master TTM (Priority 4) protected by Soft Floor (-0.50%)"""
        if pc:
            try:
                state = pc.get_state()
                pending = state.get("pending_intent")
                if pending and pending.get("status") == "WAITING_FOR_BALANCE":
                    # FVG is Priority 3 -> yields only to TTM (Priority 4)
                    if pending.get("priority", 1) > 3:
                        if current_profit >= -0.005:
                            logger.info(f"[FVGReclaimFiller15m] Preempting for {pending.get('strategy')} (Current PnL: {current_profit:.2%})")
                            return "preempted_for_high_priority"
                        else:
                            pc.reject_preemption("FVGReclaimFiller15m", pair, current_profit)
                            logger.info(f"[FVGReclaimFiller15m] Preemption blocked by Soft Floor: current profit {current_profit:.2%} < -0.50%")
            except Exception as e:
                logger.warning(f"[FVGReclaimFiller15m] Coordinator error: {e}")
        return None
