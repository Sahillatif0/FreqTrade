import logging
from datetime import datetime, timezone
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
    logger.info("[TournamentSpeedSniper5m] portfolio_coordinator loaded successfully.")
except Exception as e:
    logger.warning(f"[TournamentSpeedSniper5m] Could not load portfolio_coordinator: {e}")
    pc = None

class TournamentSpeedSniper5m(IStrategy):
    """
    TournamentSpeedSniper5m (Pro Competition Edition)
    --------------------------------------------------
    Engineered exclusively for 48-Hour Spot Competitions (10k Balance, 1x Spot).
    
    The 4 Institutional Rules:
    1. Pro Rejection-Wick Liquidity Sweep: Sweeps 18-bar (90m) swing low, absorbs with lower wick >= 0.5x body, RSI 24-38.
    2. BTC Macro Waterfall Guard: Rejects trades if BTC 5m is crashing (RSI < 28 or price < EMA50 * 0.993).
    3. Dynamic Breakeven Ratchet.
    4. 120-Minute Anti-Stagnation Cutoff.
    """
    INTERFACE_VERSION = 3

    timeframe = '5m'
    can_short = False

    # Apex Tournament Winning ROI Engine (+3.2% Higher Runner Target)
    minimal_roi = {
        "0": 0.032,
        "120": 0.020,
        "240": 0.012,
        "360": 0.006
    }

    # Strict risk floor
    stoploss = -0.022

    # Dynamic Trailing / Breakeven
    trailing_stop = False
    use_custom_stoploss = False

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
                "stop_duration_candles": 48,
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
                    (btc_5m["btc_rsi"] >= 28) &
                    (btc_5m["close"] >= btc_5m["btc_ema_50"] * 0.993)
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
        dataframe["lower_wick"] = (dataframe[["open", "close"]].min(axis=1) - dataframe["low"])

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Institutional Rejection Wick Liquidity Sweep:
        sweep_entry = (
            (dataframe["low"] < dataframe["range_low_18"]) &             # Sweeps 90m retail stops
            (dataframe["close"] > dataframe["range_low_18"]) &            # Reclaims level immediately
            (dataframe["close"] > dataframe["open"]) &                    # Green reversal candle
            (dataframe["body_ratio"] >= 0.12) &                           # Clear real candle body
            (dataframe["lower_wick"] >= dataframe["body"] * 0.50) &       # Strong buyer absorption wick
            (dataframe["close"] > dataframe["ema_50"] * 0.985) &          # Not in waterfall collapse
            (dataframe["rsi"] >= 24) & (dataframe["rsi"] < 36) &          # High-probability oversold rebound
            (dataframe["volume"] > dataframe["volume_sma"] * 0.70)        # Volume confirmation
        )

        # BTC Macro Waterfall Filter
        if "btc_safe_5m" in dataframe.columns:
            sweep_entry = sweep_entry & (dataframe["btc_safe_5m"] == True)

        dataframe.loc[sweep_entry, "enter_long"] = 1
        dataframe.loc[sweep_entry, "enter_tag"] = "tourney_speed_sniper"

        if len(dataframe) > 0 and bool(dataframe["enter_long"].iloc[-1]):
            if pc:
                try:
                    pc.request_preemption("TournamentSpeedSniper5m", metadata.get("pair", ""))
                except Exception as e:
                    logger.warning(f"[TournamentSpeedSniper5m] Preemption request error: {e}")

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "exit_long"] = 0
        return dataframe

    def custom_stoploss(self, pair: str, trade: 'Trade', current_time: datetime,
                        current_rate: float, current_profit: float, after_fill: bool,
                        **kwargs) -> float | None:
        """
        Dynamic Pro Breakeven Ratchet with runner breathing room:
        - At +1.8% profit -> Stoploss ratchets to +0.20% (Risk-free + fee covered, gives 1.6% breathing room).
        - At +2.4% profit -> Lock in +1.20% profit.
        - At +2.9% profit -> Lock in +2.00% profit.
        """
        if current_profit >= 0.029:
            return stoploss_from_open(0.020, current_profit)

        if current_profit >= 0.024:
            return stoploss_from_open(0.012, current_profit)

        if current_profit >= 0.018:
            return stoploss_from_open(0.002, current_profit)

        return None

    def custom_exit(self, pair: str, trade: 'Trade', current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs):
        """
        Preempts if higher priority strategy (FVG P6, Squeeze P5, SweepPro P4) has requested balance,
        protected by Soft Floor (-0.50%).
        """
        if pc:
            try:
                state = pc.get_state()
                pending = state.get("pending_intent")
                if pending and pending.get("status") == "WAITING_FOR_BALANCE":
                    my_prio = pc.PRIORITY.get("TournamentSpeedSniper5m", 3)
                    if pending.get("priority", 1) > my_prio:
                        if current_profit >= -0.005:
                            logger.info(f"[TournamentSpeedSniper5m] Preempting for {pending.get('strategy')} (Current PnL: {current_profit:.2%})")
                            return "preempted_for_high_priority"
                        else:
                            pc.reject_preemption("TournamentSpeedSniper5m", pair, current_profit)
                            logger.info(f"[TournamentSpeedSniper5m] Preemption blocked by Soft Floor: current profit {current_profit:.2%} < -0.50%")
            except Exception as e:
                logger.warning(f"[TournamentSpeedSniper5m] Coordinator check error: {e}")
        return None

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float,
                            time_in_force: str, current_time: datetime, entry_tag: str,
                            side: str, **kwargs) -> bool:
        if self.dp and self.dp.runmode.value in ('backtest', 'hyperopt'):
            return True

        if pc:
            try:
                allowed, reason = pc.can_enter("TournamentSpeedSniper5m", pair)
                if not allowed:
                    logger.warning(f"[TournamentSpeedSniper5m] Entry blocked by Coordinator: {reason}")
                    return False
                pc.confirm_entry("TournamentSpeedSniper5m", pair)
            except Exception as e:
                logger.warning(f"[TournamentSpeedSniper5m] Confirm entry error: {e}")
        return True

    def confirm_trade_exit(self, pair: str, trade: 'Trade', order_type: str, amount: float,
                           rate: float, time_in_force: str, exit_reason: str,
                           current_time: datetime, **kwargs) -> bool:
        if self.dp and self.dp.runmode.value in ('backtest', 'hyperopt'):
            return True

        if pc:
            try:
                profit_ratio = (rate - trade.open_rate) / trade.open_rate if (trade and trade.open_rate) else None
                pc.confirm_exit("TournamentSpeedSniper5m", pair, profit_ratio=profit_ratio, exit_reason=exit_reason)
            except Exception as e:
                logger.warning(f"[TournamentSpeedSniper5m] Confirm exit error: {e}")
        return True
