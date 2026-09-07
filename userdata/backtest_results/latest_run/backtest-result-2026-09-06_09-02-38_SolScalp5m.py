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


class SolScalp5m(IStrategy):
    """
    SolScalp5m: High-Winrate 5-Minute Micro Scalping Strategy.
    
    Designed for SOL & Volatile Crypto Assets.
    Target Duration: 15 minutes to 2.5 hours.
    
    Timeframes:
    - Primary Execution: 5m
    - Informative Macro Filter: 15m
    
    Setups:
    - Setup 1: Micro Momentum Breakout (EMA 9/21 Crossover + Volume Spike)
    - Setup 2: Dip Buy at VWAP / EMA 50 with StochRSI Oversold Reclaim
    
    Risk Management:
    - Quick Staged ROI targets (1.2% - 2.8%)
    - Dynamic ATR-anchored stoploss and trailing profit locking
    """

    INTERFACE_VERSION = 3

    timeframe = "5m"
    informative_timeframe = "15m"
    can_short: bool = False

    # Scalper ROI Ladder: Fast take-profits for 5m chart
    minimal_roi = {
        "0": 0.028,    # 2.8% immediate spike target
        "15": 0.018,   # 1.8% target after 15 mins (3 candles)
        "45": 0.014,   # 1.4% target after 45 mins
        "90": 0.010    # 1.0% floor target after 1.5 hours
    }

    # Baseline Hard Stop loss (-1.5% for tight scalping)
    stoploss = -0.015

    trailing_stop = False
    use_custom_stoploss = True

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False
    }

    startup_candle_count: int = 100

    @property
    def protections(self):
        return [
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 3  # Wait 15 mins (3 x 5m) after exiting a trade
            },
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 24, # Look back over 2 hours
                "trade_limit": 2,              # If 2 stoplosses hit within 2h
                "stop_duration_candles": 24,   # Pause trading for 2 hours
                "only_per_pair": False
            }
        ]

    def informative_pairs(self):
        pairs = self.dp.current_whitelist()
        informative = [(pair, self.informative_timeframe) for pair in pairs]
        informative.append(("BTC/USDT", self.informative_timeframe))
        return informative

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Dynamic Profit Locking Stoploss for 5m Scalper.
        """
        # Tier 3: Up +2.0% -> Lock in +1.2%
        if current_profit >= 0.020:
            return stoploss_from_open(0.012, current_profit)

        # Tier 2: Up +1.2% -> Lock in +0.6%
        if current_profit >= 0.012:
            return stoploss_from_open(0.006, current_profit)

        # Tier 1: Up +0.8% -> Move to Breakeven (+0.2% to cover trading fees)
        if current_profit >= 0.008:
            return stoploss_from_open(0.002, current_profit)

        # Retain original hard stop
        return 1

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # -------------------------------------------------------------
        # 1. Informative Macro Filter (15m)
        # -------------------------------------------------------------
        informative_pair = self.dp.get_pair_dataframe(
            pair=metadata["pair"], timeframe=self.informative_timeframe
        )
        if not informative_pair.empty:
            informative_pair["ema_50"] = ta.EMA(informative_pair, timeperiod=50)
            informative_pair["trend_15m"] = informative_pair["close"] > informative_pair["ema_50"]
            dataframe = merge_informative_pair(
                dataframe, informative_pair, self.timeframe, self.informative_timeframe, ffill=True
            )

        btc_15m = self.dp.get_pair_dataframe(pair="BTC/USDT", timeframe=self.informative_timeframe)
        if not btc_15m.empty:
            btc_15m["btc_ema_50"] = ta.EMA(btc_15m, timeperiod=50)
            btc_15m["btc_uptrend_15m"] = btc_15m["close"] > btc_15m["btc_ema_50"]
            dataframe = merge_informative_pair(
                dataframe, btc_15m, self.timeframe, self.informative_timeframe, ffill=True
            )

        # -------------------------------------------------------------
        # 2. Base 5m Indicators
        # -------------------------------------------------------------
        dataframe["ema_9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema_21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # Fast Stochastic RSI (14, 3, 3) for quick dip identification
        fastk, fastd = ta.STOCHRSI(dataframe["close"], timeperiod=14, fastk_period=3, fastd_period=3)
        dataframe["stoch_k"] = fastk
        dataframe["stoch_d"] = fastd

        # -------------------------------------------------------------
        # 3. Rolling Intraday VWAP (Smooth 24h Window)
        # -------------------------------------------------------------
        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        window_5m = 288  # 24 hours of 5m candles (12 * 24)
        
        cum_pv = pv.rolling(window=window_5m, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=window_5m, min_periods=1).sum()
        dataframe["vwap"] = cum_pv / np.where(cum_vol == 0, 1, cum_vol)

        # Volatility Bands
        dataframe["vwap_upper"] = dataframe["vwap"] + (1.2 * dataframe["atr"])
        dataframe["vwap_lower"] = dataframe["vwap"] - (1.2 * dataframe["atr"])

        # Candle Analysis
        dataframe["is_green"] = dataframe["close"] > dataframe["open"]
        dataframe["body_size"] = (dataframe["close"] - dataframe["open"]).abs()
        dataframe["is_bullish_engulfing"] = (
            dataframe["is_green"] &
            (dataframe["close"] > dataframe["open"].shift(1)) &
            (dataframe["open"] < dataframe["close"].shift(1))
        )

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Global Macro Alignment (15m BTC & 15m Asset uptrends)
        macro_btc = dataframe.get("btc_uptrend_15m_15m", pd.Series(True, index=dataframe.index)) == True
        macro_asset = dataframe.get("trend_15m_15m", pd.Series(True, index=dataframe.index)) == True
        
        volume_spike = dataframe["volume"] > (dataframe["volume_sma"] * 1.25)
        base_filters = macro_btc & macro_asset & volume_spike

        # -------------------------------------------------------------
        # Setup 1: Micro Momentum Breakout (EMA 9 > 21 + VWAP Cross)
        # -------------------------------------------------------------
        ema_bullish = dataframe["ema_9"] > dataframe["ema_21"]
        ema_cross_fresh = (dataframe["ema_9"] > dataframe["ema_21"]) & (dataframe["ema_9"].shift(1) <= dataframe["ema_21"].shift(1))
        vwap_support = dataframe["close"] > dataframe["vwap"]
        rsi_bullish = dataframe["rsi"].between(50, 68)

        setup_breakout = (
            base_filters &
            ema_cross_fresh &
            vwap_support &
            rsi_bullish &
            dataframe["is_green"]
        )
        dataframe.loc[setup_breakout, "enter_long"] = 1
        dataframe.loc[setup_breakout, "enter_tag"] = "5m_breakout"

        # -------------------------------------------------------------
        # Setup 2: Dip Buy / VWAP Bounce (StochRSI Oversold Reclaim)
        # -------------------------------------------------------------
        stoch_oversold = (dataframe["stoch_k"].shift(1) < 25) | (dataframe["stoch_d"].shift(1) < 25)
        stoch_cross = (dataframe["stoch_k"] > dataframe["stoch_d"]) & (dataframe["stoch_k"].shift(1) <= dataframe["stoch_d"].shift(1))
        near_vwap_or_ema = (
            (dataframe["low"] <= dataframe["vwap_upper"]) &
            (dataframe["close"] >= dataframe["vwap_lower"])
        )
        rsi_oversold_recovery = dataframe["rsi"].between(38, 55)

        setup_dip_buy = (
            base_filters &
            stoch_oversold &
            stoch_cross &
            near_vwap_or_ema &
            rsi_oversold_recovery &
            dataframe["is_green"]
        )
        dataframe.loc[setup_dip_buy, "enter_long"] = 1
        dataframe.loc[setup_dip_buy, "enter_tag"] = "5m_dip_bounce"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        conditions = []

        # Exit 1: StochRSI Overbought Cross Down
        stoch_overbought = (dataframe["stoch_k"] > 80) & (dataframe["stoch_k"] < dataframe["stoch_d"])
        
        # Exit 2: Price overextended past upper VWAP band
        vwap_overextended = dataframe["close"] > dataframe["vwap_upper"]

        conditions.append(stoch_overbought | vwap_overextended)
        conditions.append(dataframe["rsi"] > 70)

        if conditions:
            dataframe.loc[
                reduce(lambda x, y: x & y, conditions),
                "exit_long"
            ] = 1

        return dataframe
