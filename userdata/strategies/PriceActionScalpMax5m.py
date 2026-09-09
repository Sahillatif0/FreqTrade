from datetime import datetime
from functools import reduce
import numpy as np
import pandas as pd
import talib.abstract as ta
from pandas import DataFrame

from freqtrade.persistence import Trade
from freqtrade.strategy import (
    IStrategy,
    merge_informative_pair,
    stoploss_from_open,
)


class PriceActionScalpMax5m(IStrategy):
    """
    PriceActionScalpMax5m:
    
    1. Multi-Timeframe BOS & Price Action (1h Macro + 15m BOS + 5m Candlestick trigger).
    2. Dynamic profit trailing (+2.0% -> lock +1.0%, +3.5% -> lock +2.2%, +5.0% -> lock +3.5%).
    3. 50% Equilibrium Discount Entry & FVG Mitigation Reclaim.
    4. Minimal ROI ladder giving trades sufficient room to reach targets.
    """

    INTERFACE_VERSION = 3

    timeframe = "5m"
    informative_timeframe_15m = "15m"
    informative_timeframe_1h = "1h"
    can_short: bool = False

    # Optimized High-Yield ROI Ladder
    minimal_roi = {
        "0": 0.055,    # 5.5% peak target
        "30": 0.038,   # 3.8% target after 30 mins
        "75": 0.024,   # 2.4% target after 75 mins
        "150": 0.016   # 1.6% floor target after 2.5 hours
    }

    # Precision Hard Stop-Loss (-1.4% for max risk-reward)
    stoploss = -0.014

    trailing_stop = False
    use_custom_stoploss = True

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False
    }

    startup_candle_count: int = 150

    @property
    def protections(self):
        return [
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 3  # Wait 15 mins after exiting
            },
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 24,
                "trade_limit": 2,
                "stop_duration_candles": 36,
                "only_per_pair": False
            }
        ]

    def informative_pairs(self):
        pairs = self.dp.current_whitelist()
        informative = []
        for pair in pairs:
            informative.append((pair, self.informative_timeframe_15m))
            informative.append((pair, self.informative_timeframe_1h))
        informative.append(("BTC/USDT", self.informative_timeframe_1h))
        return informative

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Pure v6 Unconstrained Trailing Engine:
        - At +5.0% profit -> Lock in +3.5%
        - At +3.5% profit -> Lock in +2.2%
        - At +1.8% profit -> Lock in +1.0%
        """
        if current_profit >= 0.050:
            return stoploss_from_open(0.035, current_profit)

        if current_profit >= 0.035:
            return stoploss_from_open(0.022, current_profit)

        if current_profit >= 0.024:
            return stoploss_from_open(0.012, current_profit)

        return 1

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # -------------------------------------------------------------
        # 1. Macro Higher Timeframe (1h): Trend & Structure Direction
        # -------------------------------------------------------------
        pair_1h = self.dp.get_pair_dataframe(pair=metadata["pair"], timeframe=self.informative_timeframe_1h)
        if not pair_1h.empty:
            pair_1h["ema_50"] = ta.EMA(pair_1h, timeperiod=50)
            pair_1h["ema_200"] = ta.EMA(pair_1h, timeperiod=200)
            pair_1h["macro_bull"] = (
                (pair_1h["close"] > pair_1h["ema_50"]) &
                (pair_1h["ema_50"] > pair_1h["ema_200"])
            )
            dataframe = merge_informative_pair(
                dataframe, pair_1h, self.timeframe, self.informative_timeframe_1h, ffill=True
            )

        btc_1h = self.dp.get_pair_dataframe(pair="BTC/USDT", timeframe=self.informative_timeframe_1h)
        if not btc_1h.empty:
            btc_1h["btc_ema_50"] = ta.EMA(btc_1h, timeperiod=50)
            btc_1h["btc_ema_200"] = ta.EMA(btc_1h, timeperiod=200)
            btc_1h["btc_bull"] = (btc_1h["close"] > btc_1h["btc_ema_50"]) & (btc_1h["btc_ema_50"] > btc_1h["btc_ema_200"])
            dataframe = merge_informative_pair(
                dataframe, btc_1h, self.timeframe, self.informative_timeframe_1h, ffill=True
            )

        # -------------------------------------------------------------
        # 2. Intermediate Timeframe (15m): BOS + 50% Discount Equilibrium
        # -------------------------------------------------------------
        pair_15m = self.dp.get_pair_dataframe(pair=metadata["pair"], timeframe=self.informative_timeframe_15m)
        if not pair_15m.empty:
            pair_15m["swing_high"] = pair_15m["high"].shift(1).rolling(window=8).max()
            pair_15m["swing_low"] = pair_15m["low"].shift(1).rolling(window=8).min()

            # Break of Structure (BOS)
            pair_15m["bos_break"] = pair_15m["close"] > pair_15m["swing_high"]

            # 50% Equilibrium Discount Level
            pair_15m["equilibrium_50"] = pair_15m["swing_low"] + (0.50 * (pair_15m["swing_high"] - pair_15m["swing_low"]))
            pair_15m["in_discount_zone"] = pair_15m["close"] <= pair_15m["equilibrium_50"]

            # 15m Fair Value Gap (FVG)
            fvg_15m = pair_15m["low"] - pair_15m["high"].shift(2)
            pair_15m["fvg_bullish"] = (
                (fvg_15m > 0) &
                (pair_15m["close"].shift(1) > pair_15m["open"].shift(1))
            ).astype(int)
            pair_15m["fvg_active"] = pair_15m["fvg_bullish"].rolling(window=4).max()

            pair_15m["rsi"] = ta.RSI(pair_15m, timeperiod=14)
            pair_15m["adx"] = ta.ADX(pair_15m, timeperiod=14)
            pair_15m["bos_recent"] = pair_15m["bos_break"].rolling(window=6).max()

            dataframe = merge_informative_pair(
                dataframe, pair_15m, self.timeframe, self.informative_timeframe_15m, ffill=True
            )

        # -------------------------------------------------------------
        # 3. Base Execution Timeframe (5m): Precision Price Action
        # -------------------------------------------------------------
        dataframe["ema_9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema_21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # Session VWAP
        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        window_5m = 288
        cum_pv = pv.rolling(window=window_5m, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=window_5m, min_periods=1).sum()
        dataframe["vwap"] = cum_pv / np.where(cum_vol == 0, 1, cum_vol)
        dataframe["vwap_upper"] = dataframe["vwap"] + (1.50 * dataframe["atr"])

        # Candlestick Price Action: Bullish Engulfing Pattern
        is_green = dataframe["close"] > dataframe["open"]
        prior_red = dataframe["close"].shift(1) < dataframe["open"].shift(1)
        engulfs_body = (dataframe["close"] > dataframe["open"].shift(1)) & (dataframe["open"] <= dataframe["close"].shift(1))
        dataframe["bullish_engulfing"] = is_green & prior_red & engulfs_body

        # Liquidity / Weekend Filter (Monday through Friday)
        date_series = pd.to_datetime(dataframe["date"])
        dataframe["is_liquid_session"] = date_series.dt.dayofweek.isin([0, 1, 2, 3, 4])

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Step 1: 1h Macro Trend Alignment
        # When merging BTC/USDT informative pair, column name is: btc_bull_{pair_name}_{timeframe}
        btc_col = [c for c in dataframe.columns if c.startswith("btc_bull_")]
        macro_btc = dataframe[btc_col[0]] == True if btc_col else pd.Series(True, index=dataframe.index)

        macro_col = [c for c in dataframe.columns if c.startswith("macro_bull_")]
        macro_asset = dataframe[macro_col[0]] == True if macro_col else pd.Series(True, index=dataframe.index)

        trend_aligned = macro_btc & macro_asset

        # Step 2: 15m BOS Confirmed + Momentum Expansion (ADX > 16)
        bos_confirmed = dataframe.get("bos_recent_15m", pd.Series(True, index=dataframe.index)) == 1
        adx_15m = dataframe.get("adx_15m", pd.Series(20, index=dataframe.index)) > 16

        # Step 3: Session Liquidity Check
        session_ok = dataframe["is_liquid_session"] == True

        base_context = trend_aligned & bos_confirmed & adx_15m & session_ok

        # Setup 1: Institutional FVG Mitigation + Trend Reclaim (The Winning Core)
        fvg_mitigated = dataframe.get("fvg_active_15m", pd.Series(True, index=dataframe.index)) == 1
        fvg_reclaim = (
            base_context &
            fvg_mitigated &
            (dataframe["close"] > dataframe["ema_9"]) &
            (dataframe["ema_9"] > dataframe["ema_21"]) &
            (dataframe["close"] >= dataframe["vwap"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.15) &
            (dataframe["rsi"].between(48, 66))
        )
        dataframe.loc[fvg_reclaim, "enter_long"] = 1
        dataframe.loc[fvg_reclaim, "enter_tag"] = "fvg_reclaim"

        # Setup 2: EMA 21 Pullback Reclaim in Confirmed 15m BOS Bull
        ema_pullback = (
            base_context &
            (dataframe["low"].shift(1) <= dataframe["ema_21"].shift(1)) &
            (dataframe["close"] > dataframe["ema_9"]) &
            (dataframe["ema_9"] > dataframe["ema_21"]) &
            (dataframe["close"] >= dataframe["vwap"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.25) &
            (dataframe["rsi"].between(50, 65))
        )
        dataframe.loc[ema_pullback, "enter_long"] = 1
        dataframe.loc[ema_pullback, "enter_tag"] = "ema_pullback"

        # Setup 3: Institutional VWAP Sweep Reclaim with Micro MSS
        swept_below_vwap = dataframe["low"].rolling(window=3).min() < dataframe["vwap"]
        closed_above_vwap = dataframe["close"] > dataframe["vwap"]
        micro_mss = dataframe["close"] > dataframe["high"].shift(1)
        vwap_reclaim = (
            base_context &
            swept_below_vwap &
            closed_above_vwap &
            micro_mss &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.20) &
            (dataframe["rsi"].between(45, 62))
        )
        dataframe.loc[vwap_reclaim, "enter_long"] = 1
        dataframe.loc[vwap_reclaim, "enter_tag"] = "vwap_reclaim"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        conditions = []

        # Technical Exhaustion: High Overextension above VWAP Upper Band + RSI Extreme (> 78)
        conditions.append(dataframe["close"] >= dataframe["vwap_upper"])
        conditions.append(dataframe["rsi"] > 78)

        if conditions:
            dataframe.loc[
                reduce(lambda x, y: x & y, conditions),
                "exit_long"
            ] = 1

        return dataframe
