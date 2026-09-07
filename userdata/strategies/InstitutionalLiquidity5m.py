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


class InstitutionalLiquidity5m(IStrategy):
    """
    InstitutionalLiquidity5m (v3 Pure Profit Architecture):
    
    1. Removed harmful trailing stoploss that caused 28 unnecessary losses.
    2. Uses strict hard stoploss (-1.4%) + profit locks (+0.8%, +1.4%).
    3. Relies on exit_signal (11.72 Profit Factor) and ROI ladder for clean profitable exits.
    """

    INTERFACE_VERSION = 3

    timeframe = "5m"
    informative_timeframe_15m = "15m"
    informative_timeframe_1h = "1h"
    can_short: bool = False

    # Staged Risk-to-Reward Profit Ladder
    minimal_roi = {
        "0": 0.024,    # 2.4% target
        "15": 0.015,   # 1.5% target after 15 mins
        "40": 0.010,   # 1.0% target after 40 mins
        "80": 0.006    # 0.6% floor target after 1.3 hours
    }

    # Hard Stop-Loss (-1.4%)
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
                "stop_duration_candles": 3  # Pause 15 mins after trade exit
            },
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 24,
                "trade_limit": 2,
                "stop_duration_candles": 24,
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
        Clean Asymmetric Profit Lock:
        - Once trade is +0.8% in profit, move stop to Breakeven (+0.2%).
        - Once trade is +1.4% in profit, lock +0.8%.
        """
        # Tier 2: Up +1.4% -> Lock in +0.8%
        if current_profit >= 0.014:
            return stoploss_from_open(0.008, current_profit)

        # Tier 1: Move to Breakeven (+0.2% to cover fees) once profit reaches +0.8%
        if current_profit >= 0.008:
            return stoploss_from_open(0.002, current_profit)

        return 1

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # -------------------------------------------------------------
        # 1. Macro Higher Timeframe (1h) - Trend & BTC Anchor
        # -------------------------------------------------------------
        pair_1h = self.dp.get_pair_dataframe(pair=metadata["pair"], timeframe=self.informative_timeframe_1h)
        if not pair_1h.empty:
            pair_1h["ema_50"] = ta.EMA(pair_1h, timeperiod=50)
            pair_1h["macro_uptrend_1h"] = pair_1h["close"] > pair_1h["ema_50"]
            dataframe = merge_informative_pair(
                dataframe, pair_1h, self.timeframe, self.informative_timeframe_1h, ffill=True
            )

        btc_1h = self.dp.get_pair_dataframe(pair="BTC/USDT", timeframe=self.informative_timeframe_1h)
        if not btc_1h.empty:
            btc_1h["btc_ema_50"] = ta.EMA(btc_1h, timeperiod=50)
            btc_1h["btc_uptrend_1h"] = btc_1h["close"] > btc_1h["btc_ema_50"]
            dataframe = merge_informative_pair(
                dataframe, btc_1h, self.timeframe, self.informative_timeframe_1h, ffill=True
            )

        # -------------------------------------------------------------
        # 2. Intermediate Timeframe (15m) - Momentum Confluence
        # -------------------------------------------------------------
        pair_15m = self.dp.get_pair_dataframe(pair=metadata["pair"], timeframe=self.informative_timeframe_15m)
        if not pair_15m.empty:
            pair_15m["rsi_15m"] = ta.RSI(pair_15m, timeperiod=14)
            pair_15m["trend_15m"] = pair_15m["rsi_15m"].between(46, 68)
            dataframe = merge_informative_pair(
                dataframe, pair_15m, self.timeframe, self.informative_timeframe_15m, ffill=True
            )

        # -------------------------------------------------------------
        # 3. Base 5m Indicators
        # -------------------------------------------------------------
        dataframe["ema_9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema_21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["adx"] = ta.ADX(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # -------------------------------------------------------------
        # 4. Institutional Anchored Session VWAP
        # -------------------------------------------------------------
        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        window_5m = 288  # 24 Hours of 5m candles
        
        cum_pv = pv.rolling(window=window_5m, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=window_5m, min_periods=1).sum()
        dataframe["vwap"] = cum_pv / np.where(cum_vol == 0, 1, cum_vol)
        dataframe["vwap_upper"] = dataframe["vwap"] + (1.20 * dataframe["atr"])
        dataframe["vwap_lower"] = dataframe["vwap"] - (1.20 * dataframe["atr"])

        # -------------------------------------------------------------
        # 5. Smart Money Concept (SMC) Calculations
        # -------------------------------------------------------------
        # A) Liquidity Sweep
        dataframe["recent_low_12"] = dataframe["low"].shift(1).rolling(window=12).min()
        dataframe["liquidity_swept"] = (dataframe["low"] < dataframe["recent_low_12"]) & (dataframe["close"] > dataframe["recent_low_12"])

        # B) Displacement
        dataframe["is_displacement"] = (
            (dataframe["close"] > dataframe["open"]) &
            (dataframe["close"] - dataframe["open"] > dataframe["atr"] * 0.75) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.35)
        )

        # C) Bullish Fair Value Gap (FVG) Detection
        fvg_gap = dataframe["low"] - dataframe["high"].shift(2)
        dataframe["bullish_fvg"] = (
            (fvg_gap > 0) &
            (dataframe["close"].shift(1) > dataframe["open"].shift(1))
        ).astype(int)
        dataframe["fvg_active"] = dataframe["bullish_fvg"].rolling(window=3).max()

        dataframe["is_green"] = dataframe["close"] > dataframe["open"]

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Global Multi-Timeframe Alignment
        macro_btc = dataframe.get("btc_uptrend_1h_1h", pd.Series(True, index=dataframe.index)) == True
        macro_asset = dataframe.get("macro_uptrend_1h_1h", pd.Series(True, index=dataframe.index)) == True
        intermediate_15m = dataframe.get("trend_15m_15m", pd.Series(True, index=dataframe.index)) == True
        
        base_filters = macro_btc & macro_asset & intermediate_15m

        # -------------------------------------------------------------
        # Setup 1: Liquidity Sweep + Fair Value Gap (FVG) Retest
        # -------------------------------------------------------------
        fvg_retest = (
            base_filters &
            (dataframe["fvg_active"] == 1) &
            (dataframe["liquidity_swept"].rolling(window=4).max() == 1) &
            (dataframe["close"] > dataframe["ema_21"]) &
            (dataframe["rsi"].between(50, 64)) &
            (dataframe["adx"] > 18) &
            dataframe["is_green"]
        )
        dataframe.loc[fvg_retest, "enter_long"] = 1
        dataframe.loc[fvg_retest, "enter_tag"] = "smc_fvg_retest"

        # -------------------------------------------------------------
        # Setup 2: VWAP Institutional Discount Reclaim
        # -------------------------------------------------------------
        vwap_reclaim = (
            base_filters &
            (dataframe["low"].shift(1) <= dataframe["vwap_lower"].shift(1)) &
            (dataframe["close"] > dataframe["vwap"]) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.20) &
            (dataframe["rsi"].between(40, 62)) &
            dataframe["is_green"]
        )
        dataframe.loc[vwap_reclaim, "enter_long"] = 1
        dataframe.loc[vwap_reclaim, "enter_tag"] = "vwap_discount_reclaim"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        conditions = []

        # Institutional Profit Target: Price overextended past upper VWAP band with high RSI
        conditions.append(dataframe["close"] >= dataframe["vwap_upper"])
        conditions.append(dataframe["rsi"] > 68)

        if conditions:
            dataframe.loc[
                reduce(lambda x, y: x & y, conditions),
                "exit_long"
            ] = 1

        return dataframe
