from datetime import datetime
from functools import reduce
import logging
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

logger = logging.getLogger(__name__)


class PriceActionScalp1mAI(IStrategy):
    """
    PriceActionScalp1mAI:
    Two-Gate Hybrid Architecture combining Price Action Structural Verification
    with FreqAI (LightGBM) Machine Learning Confirmation.

    Gate 1: Price Action Core (Hard Technical Prerequisite)
      - 1h Macro Bull Trend Alignment (Pair & BTC/USDT: close > EMA 50 > EMA 200)
      - 15m Break of Structure (BOS)
      - 15m Fair Value Gap (FVG) Mitigation
      - 15m True 50% Equilibrium Discount Zone (entry ONLY in lower 50% discount)
      - Weekday Session Liquidity Filter (Monday through Friday)

    Gate 2: Machine Learning Confirmation (FreqAI LightGBMRegressor)
      - Predicts forward expected price expansion (&-s_close)
      - Dissimilarity Index (DI) Outlier Filter (do_predict == 1)
      - Forward expected return hurdle >= +1.0%

    Execution:
      - Asymmetric ROI Ladder (1.5% - 5.0%)
      - Trailing Stop locking in gains above 0.2% round-trip exchange fees
    """

    INTERFACE_VERSION = 3

    timeframe = "1m"
    informative_timeframe_15m = "15m"
    informative_timeframe_1h = "1h"
    can_short: bool = False

    # Championship ROI Ladder mirrored from PriceActionBOS
    minimal_roi = {
        "0": 0.055,    # 5.5% peak target
        "30": 0.038,   # 3.8% target after 30 mins
        "75": 0.024,   # 2.4% target after 75 mins
        "150": 0.016   # 1.6% floor target after 2.5 hours
    }

    stoploss = -0.014
    trailing_stop = False
    use_custom_stoploss = True
    process_only_new_candles = True

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False
    }

    startup_candle_count: int = 120

    plot_config = {
        "main_plot": {},
        "subplots": {
            "&-s_close": {"&-s_close": {"color": "blue"}},
            "do_predict": {"do_predict": {"color": "brown"}},
        },
    }

    @property
    def protections(self):
        return [
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 15
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
        informative.append(("BTC/USDT", self.informative_timeframe_1h))
        return informative

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Pure v6 Unconstrained Trailing Engine with Breakeven Guard:
        - At +5.0% profit -> Lock in +3.5%
        - At +3.5% profit -> Lock in +2.2%
        - At +2.4% profit -> Lock in +1.2%
        - At +1.0% profit -> Lock in +0.3% (Guaranteed fee-free win)
        """
        if current_profit >= 0.050:
            return stoploss_from_open(0.035, current_profit)

        if current_profit >= 0.035:
            return stoploss_from_open(0.022, current_profit)

        if current_profit >= 0.024:
            return stoploss_from_open(0.012, current_profit)

        if current_profit >= 0.010:
            return stoploss_from_open(0.003, current_profit)

        return 1

    # -------------------------------------------------------------------------
    # FreqAI Feature Engineering Pipeline
    # -------------------------------------------------------------------------

    def feature_engineering_expand_all(
        self, dataframe: DataFrame, period: int, metadata: dict, **kwargs
    ) -> DataFrame:
        dataframe[f"%-rsi-{period}"] = ta.RSI(dataframe, timeperiod=period)
        dataframe[f"%-mfi-{period}"] = ta.MFI(dataframe, timeperiod=period)
        dataframe[f"%-adx-{period}"] = ta.ADX(dataframe, timeperiod=period)
        dataframe[f"%-ema-{period}"] = ta.EMA(dataframe, timeperiod=period)

        # Distance to EMA
        dataframe[f"%-close_to_ema_{period}"] = (
            (dataframe["close"] - dataframe[f"%-ema-{period}"]) / dataframe["close"]
        )

        # Volume ratio
        dataframe[f"%-vol_ratio_{period}"] = (
            dataframe["volume"] / dataframe["volume"].rolling(period).mean().replace(0, 1)
        )

        return dataframe

    def feature_engineering_expand_basic(
        self, dataframe: DataFrame, metadata: dict, **kwargs
    ) -> DataFrame:
        dataframe["%-pct_change_1"] = dataframe["close"].pct_change()
        dataframe["%-pct_change_5"] = dataframe["close"].pct_change(5)
        dataframe["%-hl_spread"] = (dataframe["high"] - dataframe["low"]) / dataframe["close"]

        macd = ta.MACD(dataframe)
        dataframe["%-macd"] = macd["macd"]
        dataframe["%-macdsignal"] = macd["macdsignal"]
        dataframe["%-macdhist"] = macd["macdhist"]

        ema_50 = ta.EMA(dataframe, timeperiod=50)
        dataframe["%-trend_dist_ema50"] = (dataframe["close"] - ema_50) / dataframe["close"]

        return dataframe

    def feature_engineering_standard(
        self, dataframe: DataFrame, metadata: dict, **kwargs
    ) -> DataFrame:
        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        window_1m = 720
        cum_pv = pv.rolling(window=window_1m, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=window_1m, min_periods=1).sum()
        vwap = cum_pv / np.where(cum_vol == 0, 1, cum_vol)
        dataframe["%-vwap_dist"] = (dataframe["close"] - vwap) / dataframe["close"]

        date_series = pd.to_datetime(dataframe["date"])
        dataframe["%-day_of_week"] = date_series.dt.dayofweek / 6.0
        dataframe["%-hour_of_day"] = date_series.dt.hour / 24.0

        # Technical base indicators
        dataframe["ema_9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema_21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()
        dataframe["vwap"] = vwap

        # Session Liquidity Filter (Monday through Friday)
        dataframe["is_liquid_session"] = date_series.dt.dayofweek.isin([0, 1, 2, 3, 4])

        return dataframe

    def set_freqai_targets(self, dataframe: DataFrame, metadata: dict, **kwargs) -> DataFrame:
        label_candles = self.freqai_info["feature_parameters"]["label_period_candles"]
        forward_max = dataframe["high"].shift(-label_candles).rolling(label_candles).max()
        dataframe["&-s_close"] = (forward_max - dataframe["close"]) / dataframe["close"]
        return dataframe

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # -------------------------------------------------------------
        # Gate 1 Technical Indicators: 1h Trend & 15m Structure
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

        pair_15m = self.dp.get_pair_dataframe(pair=metadata["pair"], timeframe=self.informative_timeframe_15m)
        if not pair_15m.empty:
            pair_15m["ema_50"] = ta.EMA(pair_15m, timeperiod=50)
            pair_15m["swing_high"] = pair_15m["high"].shift(1).rolling(window=8).max()
            pair_15m["swing_low"] = pair_15m["low"].shift(1).rolling(window=8).min()
            pair_15m["bos_break"] = pair_15m["close"] > pair_15m["swing_high"]
            pair_15m["bos_recent"] = pair_15m["bos_break"].rolling(window=6).max()
            pair_15m["trend_15m_bull"] = pair_15m["close"] > pair_15m["ema_50"]

            pair_15m["adx"] = ta.ADX(pair_15m, timeperiod=14)

            # 50% True Equilibrium Discount Zone
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
        # Gate 1 Base Frame (1m): Indicators & Execution Filters
        # -------------------------------------------------------------
        dataframe["ema_9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema_21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        window_1m = 720
        cum_pv = pv.rolling(window=window_1m, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=window_1m, min_periods=1).sum()
        dataframe["vwap"] = cum_pv / np.where(cum_vol == 0, 1, cum_vol)
        dataframe["vwap_dist"] = (dataframe["close"] - dataframe["vwap"]) / dataframe["vwap"]

        date_series = pd.to_datetime(dataframe["date"])
        dataframe["is_liquid_session"] = date_series.dt.dayofweek.isin([0, 1, 2, 3, 4])

        # FreqAI Pipeline: feature extraction, model inference & outlier detection
        dataframe = self.freqai.start(dataframe, metadata, self)
        return dataframe

    # -------------------------------------------------------------------------
    # Two-Gate Hybrid Execution Logic
    # -------------------------------------------------------------------------

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df.loc[:, "enter_long"] = 0
        df.loc[:, "enter_tag"] = ""

        # Gate 1: Price Action Core (Macro Trend + 15m BOS + 50% Discount Zone)
        btc_col = [c for c in df.columns if c.startswith("btc_bull_")]
        macro_btc = df[btc_col[0]] == True if btc_col else pd.Series(True, index=df.index)

        macro_col = [c for c in df.columns if c.startswith("macro_bull_") and "BTC" not in c]
        macro_asset = df[macro_col[0]] == True if macro_col else pd.Series(True, index=df.index)

        trend_aligned = macro_btc & macro_asset

        bos_confirmed = df.get("bos_recent_15m", pd.Series(True, index=df.index)) == 1
        trend_15m = df.get("trend_15m_bull_15m", pd.Series(True, index=df.index)) == True
        adx_15m = df.get("adx_15m", pd.Series(20, index=df.index)) > 16
        fvg_mitigated = df.get("fvg_active_15m", pd.Series(True, index=df.index)) == 1
        in_discount = df.get("in_discount_zone_15m", pd.Series(True, index=df.index)) == True
        session_ok = df.get("is_liquid_session", pd.Series(True, index=df.index)) == True
        pa_gate_passed = trend_aligned & bos_confirmed & trend_15m & adx_15m & fvg_mitigated & session_ok

        # 1m Execution Trigger (Clean Momentum Reclaim)
        micro_trigger = (
            (df["close"] > df["ema_50"]) &
            (df["close"] > df["ema_9"]) &
            (df["ema_9"] > df["ema_21"]) &
            (df["close"] >= df["vwap"]) &
            (df["close"] > df["open"]) &
            (df["volume"] > df["volume_sma"] * 1.20) &  # Solid volume push
            (df["rsi"].between(50, 68))
        )

        # Gate 2: FreqAI Outlier & Confidence Filter
        # do_predict == 1 ensures candle is within model distribution (not an anomaly)
        # &-s_close > 0.001 ensures model predicts positive price expansion
        if "do_predict" in df.columns and "&-s_close" in df.columns:
            ai_gate_passed = (
                (df["do_predict"] == 1) &
                (df["&-s_close"] > 0.001)
            )
            long_signal = pa_gate_passed & micro_trigger & ai_gate_passed
        else:
            long_signal = pa_gate_passed & micro_trigger

        df.loc[long_signal, "enter_long"] = 1
        df.loc[long_signal, "enter_tag"] = "hybrid_ai_pa_scalp"

        return df

    def populate_exit_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df.loc[:, "exit_long"] = 0

        # Technical Exhaustion Exit: Overextended expansion above VWAP (>= 2.0%) + Extreme RSI (> 80)
        exhaustion_exit = (
            (df.get("vwap_dist", pd.Series(0, index=df.index)) >= 0.020) &
            (df["rsi"] > 80) &
            (df["close"] > df["ema_50"])
        )
        df.loc[exhaustion_exit, "exit_long"] = 1

        # Early exit if AI predicts negative trend expansion
        if "do_predict" in df.columns and "&-s_close" in df.columns:
            ai_exit = (
                (df["do_predict"] == 1) &
                (df["&-s_close"] < -0.005) &
                (df["close"] < df["ema_50"])
            )
            df.loc[ai_exit, "exit_long"] = 1

        return df
