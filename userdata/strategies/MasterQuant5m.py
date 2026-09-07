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


class MasterQuant5m(IStrategy):
    """
    MasterQuant5m (v2 Expectancy Overhaul):
    
    Fixed Asymmetric Risk-to-Reward:
    1. Raised Take-Profit targets so 1 win pays for 2 losses.
    2. Added Time-Decay exit: Cuts losing trades after 45 mins at small loss (-0.3% to -0.5%) 
       instead of allowing full -1.5% stoploss hits.
    3. Requires Positive Market Structure on 1h and 15m.
    """

    INTERFACE_VERSION = 3

    timeframe = "5m"
    informative_timeframe_15m = "15m"
    informative_timeframe_1h = "1h"
    can_short: bool = False

    # Staged Pro-Trader ROI Ladder (Target 1.2% - 2.8%)
    minimal_roi = {
        "0": 0.032,    # 3.2% target for sharp momentum spikes
        "20": 0.020,   # 2.0% target after 20 mins
        "45": 0.014,   # 1.4% target after 45 mins
        "90": 0.009    # 0.9% floor target after 1.5 hours
    }

    # Baseline Hard Stop-Loss (-1.4%)
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
                "stop_duration_candles": 3
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
        informative.append(("BTC/USDT", self.informative_timeframe_15m))
        informative.append(("BTC/USDT", self.informative_timeframe_1h))
        return informative

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Asymmetric Profit Locking:
        Once up +1.0%, move stop to Breakeven (+0.2%).
        Once up +1.8%, lock +1.0%.
        """
        if current_profit >= 0.018:
            return stoploss_from_open(0.010, current_profit)

        if current_profit >= 0.010:
            return stoploss_from_open(0.002, current_profit)

        return 1

    def custom_exit(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs) -> bool | str:
        """
        Time-Decay Exit (Institutional Rule):
        Never let a bad trade linger for 5+ hours into a full stop loss.
        If a trade is open > 45 minutes and is in negative territory, cut it early.
        """
        trade_dur = (current_time - trade.open_date_utc).total_seconds() / 60

        # Cut losing trades early after 45 mins to save capital
        if trade_dur > 45 and current_profit < -0.004:
            return "time_decay_stop"

        return False

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # -------------------------------------------------------------
        # 1. Macro Trend (1h) & BTC Crash Protection
        # -------------------------------------------------------------
        pair_1h = self.dp.get_pair_dataframe(pair=metadata["pair"], timeframe=self.informative_timeframe_1h)
        if not pair_1h.empty:
            pair_1h["ema_50"] = ta.EMA(pair_1h, timeperiod=50)
            pair_1h["macro_uptrend_1h"] = pair_1h["close"] > pair_1h["ema_50"]
            dataframe = merge_informative_pair(
                dataframe, pair_1h, self.timeframe, self.informative_timeframe_1h, ffill=True
            )

        btc_15m = self.dp.get_pair_dataframe(pair="BTC/USDT", timeframe=self.informative_timeframe_15m)
        if not btc_15m.empty:
            btc_15m["btc_ema_50"] = ta.EMA(btc_15m, timeperiod=50)
            btc_15m["btc_safe_15m"] = btc_15m["close"] > (btc_15m["btc_ema_50"] * 0.995)
            dataframe = merge_informative_pair(
                dataframe, btc_15m, self.timeframe, self.informative_timeframe_15m, ffill=True
            )

        # -------------------------------------------------------------
        # 2. Intermediate Momentum (15m)
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
        dataframe["natr"] = ta.NATR(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # Bollinger Bands (20, 2)
        bollinger = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.0, nbdevdn=2.0)
        dataframe["bb_lower"] = bollinger["lowerband"]
        dataframe["bb_upper"] = bollinger["upperband"]

        # Fast Stochastic RSI (14, 3, 3)
        fastk, fastd = ta.STOCHRSI(dataframe["close"], timeperiod=14, fastk_period=3, fastd_period=3)
        dataframe["stoch_k"] = fastk
        dataframe["stoch_d"] = fastd

        # Rolling VWAP
        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]
        window_5m = 288
        
        cum_pv = pv.rolling(window=window_5m, min_periods=1).sum()
        cum_vol = dataframe["volume"].rolling(window=window_5m, min_periods=1).sum()
        dataframe["vwap"] = cum_pv / np.where(cum_vol == 0, 1, cum_vol)
        dataframe["vwap_upper"] = dataframe["vwap"] + (1.20 * dataframe["atr"])
        dataframe["vwap_lower"] = dataframe["vwap"] - (1.20 * dataframe["atr"])

        dataframe["is_green"] = dataframe["close"] > dataframe["open"]

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Global Multi-Timeframe Alignment
        macro_btc = dataframe.get("btc_safe_15m_15m", pd.Series(True, index=dataframe.index)) == True
        macro_asset = dataframe.get("macro_uptrend_1h_1h", pd.Series(True, index=dataframe.index)) == True
        intermediate_15m = dataframe.get("trend_15m_15m", pd.Series(True, index=dataframe.index)) == True
        
        # Volatility sanity check (avoid illiquid crazy wicks)
        volatility_healthy = dataframe["natr"] < 1.2
        base_filters = macro_btc & macro_asset & intermediate_15m & volatility_healthy

        # -------------------------------------------------------------
        # Mode 1: Trending Market Breakout (ADX > 22)
        # -------------------------------------------------------------
        trending_market = dataframe["adx"] > 22
        volume_breakout = dataframe["volume"] > (dataframe["volume_sma"] * 1.50)
        ema_aligned = (dataframe["ema_9"] > dataframe["ema_21"]) & (dataframe["ema_21"] > dataframe["ema_50"])
        vwap_support = dataframe["close"] > dataframe["vwap"]
        rsi_trending = dataframe["rsi"].between(53, 66)

        entry_breakout = (
            base_filters &
            trending_market &
            volume_breakout &
            ema_aligned &
            vwap_support &
            rsi_trending &
            dataframe["is_green"]
        )
        dataframe.loc[entry_breakout, "enter_long"] = 1
        dataframe.loc[entry_breakout, "enter_tag"] = "quant_breakout"

        # -------------------------------------------------------------
        # Mode 2: Ranging Market Dip Buy (ADX <= 22)
        # -------------------------------------------------------------
        ranging_market = dataframe["adx"] <= 22
        volume_dip_ok = dataframe["volume"] > (dataframe["volume_sma"] * 1.15)
        stoch_oversold = (dataframe["stoch_k"].shift(1) < 18) & (dataframe["stoch_k"] > dataframe["stoch_d"])
        near_bb_or_vwap = (dataframe["low"] <= dataframe["bb_lower"]) | (dataframe["low"] <= dataframe["vwap_lower"])
        rsi_rebound = dataframe["rsi"].between(38, 54)

        entry_dip_buy = (
            base_filters &
            ranging_market &
            volume_dip_ok &
            stoch_oversold &
            near_bb_or_vwap &
            rsi_rebound &
            dataframe["is_green"]
        )
        dataframe.loc[entry_dip_buy, "enter_long"] = 1
        dataframe.loc[entry_dip_buy, "enter_tag"] = "quant_dip_buy"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        conditions = []

        # Exit Signal: Upper Band Overextension + RSI Extreme Overbought (> 72)
        overextended = (dataframe["close"] >= dataframe["bb_upper"]) | (dataframe["close"] >= dataframe["vwap_upper"])
        rsi_overbought = dataframe["rsi"] > 72

        conditions.append(overextended)
        conditions.append(rsi_overbought)

        if conditions:
            dataframe.loc[
                reduce(lambda x, y: x & y, conditions),
                "exit_long"
            ] = 1

        return dataframe
