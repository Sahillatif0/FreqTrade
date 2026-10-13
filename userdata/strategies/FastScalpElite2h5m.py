import logging
from datetime import datetime
import numpy as np
import pandas as pd
from pandas import DataFrame
import talib.abstract as ta
from freqtrade.strategy import IStrategy, merge_informative_pair, stoploss_from_open
from freqtrade.persistence import Trade
import os
import sys

_strat_dir = os.path.dirname(os.path.abspath(__file__))
if _strat_dir not in sys.path:
    sys.path.insert(0, _strat_dir)

logger = logging.getLogger(__name__)

try:
    import portfolio_coordinator as pc
    logger.info("[FastScalpElite2h5m] portfolio_coordinator loaded successfully.")
except Exception as e:
    logger.warning(f"[FastScalpElite2h5m] Could not load portfolio_coordinator: {e}")
    pc = None


class FastScalpElite2h5m(IStrategy):
    """
    FastScalpElite2h5m - 2 to 3 Hour High-PnL Institutional Scalper
    --------------------------------------------------------------
    Engineered for 5m Binance Spot trading with a 2-3 hour holding window.
    
    Architectural Pillars:
    1. Precision Micro-Liquidity Sweep Entry:
       - Sweeps 18-bar (90m) retail swing low stops.
       - Reclaims low level with clean green reversal candle.
       - Buyer absorption lower wick (lower_wick >= 0.50 * body).
       - RSI oversold rebound filter (24 <= RSI < 36).
       - Volume impulse confirmation (volume > 0.70x SMA20).
       - Trend preservation filter: close > EMA50 * 0.989 to avoid waterfall traps.
    2. BTC 5m Macro Guard:
       - Informative BTC 5m check (RSI >= 30 and close >= EMA50 * 0.995).
    3. 2-3 Hour Decaying ROI Engine:
       - 0m: +3.4% (instant runner capture)
       - 60m: +2.4% (early momentum expansion)
       - 120m: +1.6% (2-hour target)
       - 180m: +0.9% (3-hour target)
    4. Dynamic Breakeven & Profit Ratchet:
       - At +1.0% profit: stoploss ratchets to +0.2% (Risk-free + fee covered).
       - At +1.8% profit: stoploss locks +1.2% profit.
    5. Anti-Stagnation & Safety Cutoff:
       - Preserves full 2-3h trade development.
       - Cuts positions only after 270m (4.5 hours) if stagnant in negative territory.
    """
    INTERFACE_VERSION = 3

    timeframe = '5m'
    can_short = False

    # 2 to 3 hour targeted ROI profile
    minimal_roi = {
        "0": 0.034,
        "60": 0.024,
        "120": 0.016,
        "180": 0.009
    }

    # Initial safety stoploss (spot safety buffer)
    stoploss = -0.025

    trailing_stop = False
    use_custom_stoploss = True

    process_only_new_candles = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    order_types = {
        'entry': 'limit',
        'exit': 'limit',
        'stoploss': 'market',
        'stoploss_on_exchange': False
    }

    order_time_in_force = {
        'entry': 'gtc',
        'exit': 'gtc'
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
                "lookback_period_candles": 72,
                "trade_limit": 2,
                "stop_duration_candles": 24,
                "only_per_pair": False
            }
        ]

    def informative_pairs(self):
        stake = self.config.get('stake_currency', 'USDT')
        return [(f"BTC/{stake}", '5m')]

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # 0. Merge BTC 5m macro indicator
        stake = self.config.get('stake_currency', 'USDT')
        btc_pair = f"BTC/{stake}"
        if self.dp:
            btc_5m = self.dp.get_pair_dataframe(btc_pair, '5m')
            if not btc_5m.empty:
                btc_5m["btc_rsi"] = ta.RSI(btc_5m, timeperiod=14)
                btc_5m["btc_ema_50"] = ta.EMA(btc_5m, timeperiod=50)
                btc_5m["btc_safe"] = (
                    (btc_5m["btc_rsi"] >= 30) &
                    (btc_5m["close"] >= btc_5m["btc_ema_50"] * 0.995)
                )
                dataframe = merge_informative_pair(
                    dataframe, btc_5m[["date", "btc_safe"]],
                    self.timeframe, '5m', ffill=True
                )

        # 1. 18-bar (90 minute) swing high & low
        dataframe["range_low_18"] = dataframe["low"].shift(1).rolling(window=18).min()
        dataframe["range_high_18"] = dataframe["high"].shift(1).rolling(window=18).max()

        # 2. Moving Averages & Volume
        dataframe["ema_20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # 3. Momentum & Candlestick Anatomy
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["candle_range"] = dataframe["high"] - dataframe["low"]
        dataframe["body"] = (dataframe["close"] - dataframe["open"]).abs()
        dataframe["body_ratio"] = dataframe["body"] / dataframe["candle_range"].replace(0, np.nan)
        dataframe["lower_wick"] = dataframe[["open", "close"]].min(axis=1) - dataframe["low"]

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # High-Precision Rejection Wick Liquidity Sweep
        sweep_entry = (
            (dataframe["low"] < dataframe["range_low_18"]) &             # Sweeps 90m swing low
            (dataframe["close"] > dataframe["range_low_18"]) &            # Immediate reclaim
            (dataframe["close"] > dataframe["open"]) &                    # Green reversal bar
            (dataframe["body_ratio"] >= 0.12) &                           # Valid real body
            (dataframe["lower_wick"] >= dataframe["body"] * 0.50) &       # Lower rejection wick
            (dataframe["close"] > dataframe["ema_50"] * 0.989) &          # Trend floor protection
            (dataframe["rsi"] >= 24) & (dataframe["rsi"] < 36) &          # High-rebound oversold zone
            (dataframe["volume"] > dataframe["volume_sma"] * 0.70)        # Volume confirmation
        )

        # BTC Macro Waterfall Guard
        if "btc_safe_5m" in dataframe.columns:
            sweep_entry = sweep_entry & (dataframe["btc_safe_5m"] == True)

        dataframe.loc[sweep_entry, "enter_long"] = 1
        dataframe.loc[sweep_entry, "enter_tag"] = "fast_scalp_sweep"

        if len(dataframe) > 0 and bool(dataframe["enter_long"].iloc[-1]):
            if pc:
                try:
                    pc.request_preemption("FastScalpElite2h5m", metadata.get("pair", ""))
                except Exception as e:
                    logger.warning(f"[FastScalpElite2h5m] Preemption request error: {e}")

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        return dataframe

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                        current_rate: float, current_profit: float, after_fill: bool,
                        **kwargs) -> float | None:
        """
        Dynamic Breakeven & Profit Lock Ratchet:
        - At +1.0% profit -> ratchet to +0.2% (Fee-covered risk-free lock)
        - At +1.8% profit -> ratchet to +1.2% (Locks in solid win)
        """
        if current_profit >= 0.018:
            return stoploss_from_open(0.012, current_profit)

        if current_profit >= 0.010:
            return stoploss_from_open(0.002, current_profit)

        return None

    def custom_exit(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs):
        """
        Preempts if higher priority strategy has requested balance, protected by Soft Floor (-0.50%).
        Also cuts stagnant positions after 270 minutes (4.5 hours) if stuck negative.
        """
        if pc:
            try:
                state = pc.get_state()
                pending = state.get("pending_intent")
                if pending and pending.get("status") == "WAITING_FOR_BALANCE":
                    my_prio = pc.PRIORITY.get("FastScalpElite2h5m", 1)
                    if pending.get("priority", 1) > my_prio:
                        if current_profit >= -0.005:
                            logger.info(f"[FastScalpElite2h5m] Preempting for {pending.get('strategy')} (Current PnL: {current_profit:.2%})")
                            return "preempted_for_high_priority"
                        else:
                            pc.reject_preemption("FastScalpElite2h5m", pair, current_profit)
                            logger.info(f"[FastScalpElite2h5m] Preemption blocked by Soft Floor: current profit {current_profit:.2%} < -0.50%")
            except Exception as e:
                logger.warning(f"[FastScalpElite2h5m] Coordinator check error: {e}")

        trade_dur_min = (current_time - trade.open_date_utc).total_seconds() / 60.0
        if trade_dur_min >= 270.0 and current_profit < -0.010:
            return "stagnant_negative_cut"

        return None

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float,
                            time_in_force: str, current_time: datetime, entry_tag: str,
                            side: str, **kwargs) -> bool:
        if self.dp and self.dp.runmode.value in ('backtest', 'hyperopt'):
            return True

        if pc:
            try:
                allowed, reason = pc.can_enter("FastScalpElite2h5m", pair)
                if not allowed:
                    logger.warning(f"[FastScalpElite2h5m] Entry blocked by Coordinator: {reason}")
                    return False
                pc.confirm_entry("FastScalpElite2h5m", pair)
            except Exception as e:
                logger.warning(f"[FastScalpElite2h5m] Confirm entry error: {e}")
        return True

    def confirm_trade_exit(self, pair: str, trade: 'Trade', order_type: str, amount: float,
                           rate: float, time_in_force: str, exit_reason: str,
                           current_time: datetime, **kwargs) -> bool:
        if self.dp and self.dp.runmode.value in ('backtest', 'hyperopt'):
            return True

        if pc:
            try:
                profit_ratio = (rate - trade.open_rate) / trade.open_rate if (trade and trade.open_rate) else None
                pc.confirm_exit("FastScalpElite2h5m", pair, profit_ratio=profit_ratio, exit_reason=exit_reason)
            except Exception as e:
                logger.warning(f"[FastScalpElite2h5m] Confirm exit error: {e}")
        return True
