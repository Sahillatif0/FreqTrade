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


class PriceActionScalp1m(IStrategy):
    """
    PriceActionScalp1m:
    High-Frequency 1m Price Action & BOS Scalping Engine
    
    Architecture:
    1. 15m Macro Bias: Trend direction via EMA 50/200.
    2. 5m Intermediate Structure: Break of Structure (BOS) & Fair Value Gap (FVG).
    3. 1m Base Execution: Micro-displacement, VWAP reclaim, EMA 9/21 cross, Volume push.
    4. Rapid ROI ladder (0.7% - 2.5%) & tight 0.9% risk management for frequent trade turnover.
    """

    INTERFACE_VERSION = 3

    timeframe = "1m"
    informative_timeframe_15m = "15m"
    informative_timeframe_1h = "1h"
    can_short: bool = False

    # High-Yield ROI Ladder mirrored from Champion PriceActionBOS
    minimal_roi = {
        "0": 0.050,    # 5.0% peak target
        "30": 0.035,   # 3.5% after 30 mins
        "75": 0.022,   # 2.2% after 75 mins
        "150": 0.015   # 1.5% floor target
    }

    # Precision Hard Stop-Loss (-1.4%)
    stoploss = -0.014

    trailing_stop = False
    use_custom_stoploss = True

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False
    }

    startup_candle_count: int = 250

    @property
    def protections(self):
        return [
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 15  # Wait 15 mins after exiting a pair
            },
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 60,
                "trade_limit": 2,
                "stop_duration_candles": 45,
                "only_per_pair": True
            }
        ]

    def informative_pairs(self):
        pairs = self.dp.current_whitelist()
        informative = []
        for pair in pairs:
            informative.append((pair, self.informative_timeframe_15m))
            informative.append((pair, self.informative_timeframe_1h))
        # Market-wide BTC Guardrail on 1h
        informative.append(("BTC/USDT", self.informative_timeframe_1h))
        return informative

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Unconstrained Trailing Engine:
        - At +4.5% profit -> Lock in +3.2%
        - At +3.0% profit -> Lock in +2.0%
        - At +1.8% profit -> Lock in +1.0%
        """
        if current_profit >= 0.045:
            return stoploss_from_open(0.032, current_profit)

        if current_profit >= 0.030:
            return stoploss_from_open(0.020, current_profit)

        if current_profit >= 0.018:
            return stoploss_from_open(0.010, current_profit)

        return 1

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # -------------------------------------------------------------
        # 1. Macro Trend (1h): Asset Trend & Market-wide BTC Trend
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
            btc_1h["btc_bull"] = (
                (btc_1h["close"] > btc_1h["btc_ema_50"]) &
                (btc_1h["btc_ema_50"] > btc_1h["btc_ema_200"])
            )
            dataframe = merge_informative_pair(
                dataframe, btc_1h, self.timeframe, self.informative_timeframe_1h, ffill=True
            )

        # -------------------------------------------------------------
        # 2. Intermediate Structure (15m): BOS, FVG Mitigation & Momentum
        # -------------------------------------------------------------
        pair_15m = self.dp.get_pair_dataframe(pair=metadata["pair"], timeframe=self.informative_timeframe_15m)
        if not pair_15m.empty:
            pair_15m["ema_50"] = ta.EMA(pair_15m, timeperiod=50)
            pair_15m["swing_high"] = pair_15m["high"].shift(1).rolling(window=8).max()
            pair_15m["swing_low"] = pair_15m["low"].shift(1).rolling(window=8).min()
            pair_15m["bos_break"] = pair_15m["close"] > pair_15m["swing_high"]
            pair_15m["bos_recent"] = pair_15m["bos_break"].rolling(window=6).max()
            pair_15m["adx"] = ta.ADX(pair_15m, timeperiod=14)
            pair_15m["trend_15m_bull"] = pair_15m["close"] > pair_15m["ema_50"]

            # 50% True Equilibrium Discount Level (Entries only in true structural discount)
            pair_15m["equilibrium_50"] = pair_15m["swing_low"] + (0.50 * (pair_15m["swing_high"] - pair_15m["swing_low"]))
            pair_15m["in_discount_zone"] = pair_15m["close"] <= pair_15m["equilibrium_50"]

            # 15m Fair Value Gap (FVG) Mitigation
            fvg_15m = pair_15m["low"] - pair_15m["high"].shift(2)
            pair_15m["fvg_bullish"] = (
                (fvg_15m > 0) &
                (pair_15m["close"].shift(1) > pair_15m["open"].shift(1))
            ).astype(int)
            pair_15m["fvg_active"] = pair_15m["fvg_bullish"].rolling(window=4).max()

            dataframe = merge_informative_pair(
                dataframe, pair_15m, self.timeframe, self.informative_timeframe_15m, ffill=True
            )

        # -------------------------------------------------------------
        # 3. Micro Base Frame (1m): High-Frequency Execution
        # -------------------------------------------------------------
        dataframe["ema_9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema_21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # Session VWAP (12-hour session rolling VWAP)
        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        window_1m = 720
        cum_pv = pv.rolling(window=window_1m, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=window_1m, min_periods=1).sum()
        dataframe["vwap"] = cum_pv / np.where(cum_vol == 0, 1, cum_vol)
        dataframe["vwap_upper"] = dataframe["vwap"] + (1.85 * dataframe["atr"])

        # Liquidity / Session Filter (Monday through Friday)
        date_series = pd.to_datetime(dataframe["date"])
        dataframe["is_liquid_session"] = date_series.dt.dayofweek.isin([0, 1, 2, 3, 4])

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Step 1: 1h Macro Trend (Pair & BTC/USDT)
        btc_col = [c for c in dataframe.columns if c.startswith("btc_bull_")]
        macro_btc = dataframe[btc_col[0]] == True if btc_col else pd.Series(True, index=dataframe.index)

        macro_col = [c for c in dataframe.columns if c.startswith("macro_bull_") and "BTC" not in c]
        macro_asset = dataframe[macro_col[0]] == True if macro_col else pd.Series(True, index=dataframe.index)

        trend_aligned = macro_btc & macro_asset

        # Step 2: 15m Confirmed Break of Structure + FVG + Discount Zone + Session Liquidity
        bos_confirmed = dataframe.get("bos_recent_15m", pd.Series(True, index=dataframe.index)) == 1
        trend_15m = dataframe.get("trend_15m_bull_15m", pd.Series(True, index=dataframe.index)) == True
        fvg_mitigated = dataframe.get("fvg_active_15m", pd.Series(True, index=dataframe.index)) == 1
        in_discount = dataframe.get("in_discount_zone_15m", pd.Series(True, index=dataframe.index)) == True
        session_ok = dataframe["is_liquid_session"] == True

        structure_ok = bos_confirmed & trend_15m & fvg_mitigated & in_discount & session_ok

        # Step 3: 1m Micro Execution Entry with genuine volume push & momentum
        scalp_reclaim = (
            trend_aligned &
            structure_ok &
            (dataframe["close"] > dataframe["ema_50"]) &
            (dataframe["close"] > dataframe["ema_9"]) &
            (dataframe["ema_9"] > dataframe["ema_21"]) &
            (dataframe["close"] <= dataframe["ema_9"] * 1.0025) &  # Close to moving average
            (dataframe["close"] >= dataframe["vwap"]) &
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.35) &
            (dataframe["rsi"].between(50, 66))
        )

        dataframe.loc[scalp_reclaim, "enter_long"] = 1
        dataframe.loc[scalp_reclaim, "enter_tag"] = "1m_fvg_bos_scalp"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        conditions = []

        # Overextension above 1m VWAP band + RSI exhaustion
        conditions.append(dataframe["close"] >= dataframe["vwap_upper"])
        conditions.append(dataframe["rsi"] > 80)

        if conditions:
            dataframe.loc[
                reduce(lambda x, y: x & y, conditions),
                "exit_long"
            ] = 1

        return dataframe
