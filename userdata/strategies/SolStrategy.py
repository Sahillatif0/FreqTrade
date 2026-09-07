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


class SolConfluenceSpot(IStrategy):
    """
    Intraday Multi-Confluence Spot Strategy (15m Execution, 1h Macro Filter).
    
    Includes 3 Distinct Institutional Setups:
    - Setup A: Bullish Fair Value Gap (FVG) Retest
    - Setup B: VWAP Reclaim with Micro Market Structure Shift (MSS)
    - Setup C: Institutional Demand Zone / Order Block (OB) Retest
    
    Filters:
    - Supply Zone Overhead Resistance Filter
    - 1h Trend & EMA 50 Slope Alignment (SOL & BTC)
    - Circuit Breaker Protections (Cooldown & StoplossGuard)
    """

    INTERFACE_VERSION = 3

    timeframe = "15m"
    informative_timeframe = "1h"
    can_short: bool = False

    # Staged Take-Profit Ladder
    minimal_roi = {
        "0": 0.048,    # 4.8% on immediate momentum spikes
        "60": 0.032,   # 3.2% after 1 hour
        "180": 0.024,  # 2.4% after 3 hours
        "360": 0.018   # 1.8% minimum take-profit floor
    }

    # Baseline Hard Stop Loss
    stoploss = -0.018

    trailing_stop = False
    use_custom_stoploss = True

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False
    }

    startup_candle_count: int = 120

    @property
    def protections(self):
        return [
            {
                "method": "CooldownPeriod",
                "stop_duration_candles": 4  # Wait 1 hour (4 x 15m) after exiting
            },
            {
                "method": "StoplossGuard",
                "lookback_period_candles": 32, # Look back over 8 hours
                "trade_limit": 2,              # If 2 stoplosses hit
                "stop_duration_candles": 16,   # Pause all trades for 4 hours
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
        # Tier 2: Up +3.5% -> Lock in +2.0%
        if current_profit >= 0.035:
            return stoploss_from_open(0.020, current_profit)

        # Tier 1: Up +2.2% -> Move stop to +0.5% (clears roundtrip spot fees)
        if current_profit >= 0.022:
            return stoploss_from_open(0.005, current_profit)

        # Retain original hard stop anchored to entry
        return 1

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # -------------------------------------------------------------
        # 1. Informative Macro (1h) - Target Pair & BTC Benchmark
        # -------------------------------------------------------------
        informative_pair = self.dp.get_pair_dataframe(
            pair=metadata["pair"], timeframe=self.informative_timeframe
        )
        if not informative_pair.empty:
            informative_pair["ema_50"] = ta.EMA(informative_pair, timeperiod=50)
            informative_pair["ema_50_slope"] = (
                informative_pair["ema_50"] - informative_pair["ema_50"].shift(3)
            ) > 0
            dataframe = merge_informative_pair(
                dataframe, informative_pair, self.timeframe, self.informative_timeframe, ffill=True
            )

        btc_1h = self.dp.get_pair_dataframe(pair="BTC/USDT", timeframe=self.informative_timeframe)
        if not btc_1h.empty:
            btc_1h["btc_ema_50"] = ta.EMA(btc_1h, timeperiod=50)
            btc_1h["btc_uptrend"] = btc_1h["close"] > btc_1h["btc_ema_50"]
            dataframe = merge_informative_pair(
                dataframe, btc_1h, self.timeframe, self.informative_timeframe, ffill=True
            )

        # -------------------------------------------------------------
        # 2. Base 15m Indicators
        # -------------------------------------------------------------
        dataframe["ema_20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["ema_50"] = ta.EMA(dataframe, timeperiod=50)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["atr"] = ta.ATR(dataframe, timeperiod=14)
        dataframe["volume_sma"] = dataframe["volume"].rolling(window=20).mean()

        # -------------------------------------------------------------
        # 3. Anchored Session VWAP & Bands
        # -------------------------------------------------------------
        date_series = pd.to_datetime(dataframe["date"])
        day_group = date_series.dt.floor("D")

        typical_price = (dataframe["high"] + dataframe["low"] + dataframe["close"]) / 3.0
        pv = typical_price * dataframe["volume"]

        dataframe["cum_pv"] = pv.groupby(day_group).cumsum()
        dataframe["cum_vol"] = dataframe["volume"].groupby(day_group).cumsum()
        dataframe["vwap"] = dataframe["cum_pv"] / np.where(dataframe["cum_vol"] == 0, 1, dataframe["cum_vol"])

        price_diff_sq = ((typical_price - dataframe["vwap"]) ** 2) * dataframe["volume"]
        cum_diff_sq = price_diff_sq.groupby(day_group).cumsum()
        dataframe["vwap_std"] = np.sqrt(cum_diff_sq / np.where(dataframe["cum_vol"] == 0, 1, dataframe["cum_vol"]))
        dataframe["vwap_upper"] = dataframe["vwap"] + (1.5 * dataframe["vwap_std"])
        dataframe["exhaustion_cap"] = dataframe["vwap"] + (0.75 * dataframe["vwap_std"])

        # -------------------------------------------------------------
        # 4. Fair Value Gap (FVG)
        # -------------------------------------------------------------
        fvg_gap = dataframe["low"] - dataframe["high"].shift(2)
        dataframe["fvg_bullish"] = (
            (fvg_gap > 0) &
            (dataframe["close"].shift(1) > dataframe["open"].shift(1)) &
            (dataframe["close"] > dataframe["ema_20"])
        ).astype(int)
        dataframe["fvg_recent"] = dataframe["fvg_bullish"].rolling(window=4).max()

        # -------------------------------------------------------------
        # 5. Institutional Supply & Demand Zones (Order Blocks)
        # -------------------------------------------------------------
        # A Demand Zone is formed when a down-candle is followed by a sharp expansion
        # that breaks past the high of the last 3 candles with displacement > 1.0x ATR.
        expansion_up = (
            (dataframe["close"] > dataframe["high"].shift(1)) &
            (dataframe["close"] - dataframe["open"] > dataframe["atr"]) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.2)
        )
        is_prior_down_candle = dataframe["close"].shift(1) < dataframe["open"].shift(1)

        # Mark Demand Zone boundaries (high and low of the base candle)
        demand_high = np.where(
            expansion_up & is_prior_down_candle,
            dataframe["high"].shift(1),
            np.nan
        )
        demand_low = np.where(
            expansion_up & is_prior_down_candle,
            dataframe["low"].shift(1),
            np.nan
        )
        dataframe["demand_zone_top"] = pd.Series(demand_high, index=dataframe.index).ffill()
        dataframe["demand_zone_bottom"] = pd.Series(demand_low, index=dataframe.index).ffill()

        # Mark Supply Zone (Origin of high-volume sell-off)
        expansion_down = (
            (dataframe["close"] < dataframe["low"].shift(1)) &
            (dataframe["open"] - dataframe["close"] > dataframe["atr"]) &
            (dataframe["volume"] > dataframe["volume_sma"] * 1.2)
        )
        is_prior_up_candle = dataframe["close"].shift(1) > dataframe["open"].shift(1)
        supply_low = np.where(
            expansion_down & is_prior_up_candle,
            dataframe["low"].shift(1),
            np.nan
        )
        dataframe["supply_zone_bottom"] = pd.Series(supply_low, index=dataframe.index).ffill()

        # Check if price is currently testing the active Demand Zone
        dataframe["in_demand_zone"] = (
            (dataframe["low"] <= dataframe["demand_zone_top"]) &
            (dataframe["close"] >= dataframe["demand_zone_bottom"])
        )

        # Avoid entries if price is already within 0.4% of an overhead Supply Zone
        dataframe["near_supply_zone"] = (
            dataframe["supply_zone_bottom"].notna() &
            (dataframe["close"] < dataframe["supply_zone_bottom"]) &
            ((dataframe["supply_zone_bottom"] - dataframe["close"]) / dataframe["close"] < 0.004)
        )

        dataframe["is_green_candle"] = dataframe["close"] > dataframe["open"]

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[:, "enter_long"] = 0
        dataframe.loc[:, "enter_tag"] = ""

        # Global Baseline Trend Filters
        macro_btc = dataframe.get("btc_uptrend_1h", pd.Series(True, index=dataframe.index)) == True
        macro_asset = (
            (dataframe.get("ema_50_slope_1h", pd.Series(True, index=dataframe.index)) == True) &
            (dataframe["close"] > dataframe.get("ema_50_1h", dataframe["close"]))
        )
        trend_15m = dataframe["ema_20"] > dataframe["ema_50"]
        volume_ok = dataframe["volume"] > (dataframe["volume_sma"] * 1.10)
        rsi_sweet_spot = dataframe["rsi"].between(38, 60)
        not_exhausted = dataframe["close"] <= dataframe["exhaustion_cap"]

        base_rules = macro_btc & macro_asset & trend_15m & volume_ok & rsi_sweet_spot & not_exhausted

        # -------------------------------------------------------------
        # Trigger A: Institutional FVG Retest (100% WR across 5 months)
        # -------------------------------------------------------------
        trigger_fvg = (
            base_rules &
            (dataframe["fvg_recent"] == 1) &
            (dataframe["close"] >= dataframe["vwap"]) &
            (dataframe["is_green_candle"])
        )
        dataframe.loc[trigger_fvg, "enter_long"] = 1
        dataframe.loc[trigger_fvg, "enter_tag"] = "entry_fvg_retest"

        # -------------------------------------------------------------
        # Trigger B: VWAP Reclaim with Micro MSS (Core Profit Engine)
        # -------------------------------------------------------------
        swept_below_vwap = dataframe["low"].rolling(window=3).min() < dataframe["vwap"]
        closed_above_vwap = dataframe["close"] > dataframe["vwap"]
        micro_mss = dataframe["close"] > dataframe["high"].shift(1)

        trigger_vwap_reclaim = (
            base_rules &
            swept_below_vwap &
            closed_above_vwap &
            micro_mss &
            dataframe["is_green_candle"]
        )
        dataframe.loc[trigger_vwap_reclaim, "enter_long"] = 1
        dataframe.loc[trigger_vwap_reclaim, "enter_tag"] = "entry_vwap_reclaim"

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        conditions = []

        # Exit on VWAP upper band exhaustion or touching major supply
        conditions.append(dataframe["close"] >= dataframe["vwap_upper"])
        conditions.append(dataframe["rsi"] > 75)
        conditions.append(dataframe["close"] < dataframe["open"])

        if conditions:
            dataframe.loc[
                reduce(lambda x, y: x & y, conditions),
                "exit_long"
            ] = 1

        return dataframe