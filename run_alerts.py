#!/usr/bin/env python3
"""
Standalone WhatsApp Notifier for:
- Price Alerts / Targets
- Dynamic Support Broken (Bearish Breakdown)
- Dynamic Resistance Broken (Bullish Breakout)
- Fixed Support & Resistance Breaches

Directly fetches market data from Binance (or any CCXT-supported exchange)
without needing Freqtrade CLI or trade execution engines.
"""

import json
import logging
import os
import sys
import time
import urllib.parse
from datetime import datetime, timezone

import ccxt
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("WhatsAppAlertBot")

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "alerts_config.json")


def load_config() -> dict:
    if not os.path.exists(CONFIG_FILE):
        logger.error(f"Configuration file not found: {CONFIG_FILE}")
        sys.exit(1)
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


class WhatsAppNotifier:
    """
    Sends WhatsApp alerts using TextMeBot API:
    https://api.textmebot.com/send.php?recipient=[phone]&apikey=[apikey]&text=[text]
    """
    def __init__(self, recipient: str, apikey: str, enabled: bool = True):
        # Support both with or without leading '+'
        self.recipient = recipient.strip()
        self.apikey = apikey.strip()
        self.enabled = enabled

    def send_alert(self, text: str) -> bool:
        if not self.enabled:
            logger.info(f"[WHATSAPP DISABLED] Alert text:\n{text}")
            return True

        if not self.apikey or self.apikey in ("YOUR_TEXTMEBOT_API_KEY", "YOUR_CALLMEBOT_API_KEY"):
            logger.warning(
                "WhatsApp alert skipped: Please provide your TextMeBot 'apikey' in alerts_config.json"
            )
            return False

        try:
            url = "https://api.textmebot.com/send.php"
            params = {
                "recipient": self.recipient,
                "apikey": self.apikey,
                "text": text,
            }
            response = requests.get(url, params=params, timeout=12)

            if response.status_code == 200:
                logger.info(f"WhatsApp alert successfully delivered: {text.splitlines()[0]}")
                return True
            else:
                logger.error(
                    f"TextMeBot returned error {response.status_code}: {response.text}"
                )
                return False
        except Exception as err:
            logger.error(f"Failed to connect to TextMeBot: {err}")
            return False


class MarketMonitor:
    def __init__(self, config: dict):
        self.config = config
        exchange_id = config.get("monitoring", {}).get("exchange", "binance")
        exchange_class = getattr(ccxt, exchange_id, None)

        if not exchange_class:
            raise ValueError(f"Exchange '{exchange_id}' is not supported by ccxt.")

        self.exchange = exchange_class({"enableRateLimit": True})
        self.timeframe = config.get("monitoring", {}).get("timeframe", "1h")
        self.lookback = config.get("monitoring", {}).get("dynamic_sr_lookback_candles", 24)
        self.check_interval = config.get("monitoring", {}).get("check_interval_seconds", 30)

        wa_cfg = config.get("whatsapp", {})
        recipient = wa_cfg.get("recipient") or wa_cfg.get("phone", "")
        self.notifier = WhatsAppNotifier(
            recipient=recipient,
            apikey=wa_cfg.get("apikey", ""),
            enabled=wa_cfg.get("enabled", True),
        )

        # Track alerted candle timestamps and triggered levels to avoid duplicate spam
        # format: pair -> { "last_res_break_ts": int, "last_sup_break_ts": int, "fixed_triggered": set(), "prev_price": float }
        self.state: dict[str, dict] = {}

    def _init_pair_state(self, pair: str):
        if pair not in self.state:
            self.state[pair] = {
                "last_res_break_ts": None,
                "last_sup_break_ts": None,
                "fixed_triggered": set(),
                "prev_price": None,
            }

    def check_pair(self, pair: str, pair_config: dict):
        self._init_pair_state(pair)
        state = self.state[pair]

        try:
            # 1. Fetch OHLCV for dynamic S/R calculation
            limit = self.lookback + 5
            ohlcv = self.exchange.fetch_ohlcv(pair, timeframe=self.timeframe, limit=limit)
            if not ohlcv or len(ohlcv) < self.lookback + 2:
                logger.warning(f"Not enough candle data returned for {pair}")
                return

            # OHLCV format: [timestamp, open, high, low, close, volume]
            # Exclude current in-progress candle for establishing prior support & resistance
            completed_candles = ohlcv[:-1]
            eval_candles = completed_candles[-self.lookback :]

            dynamic_resistance = max(c[2] for c in eval_candles)  # Highest high
            dynamic_support = min(c[3] for c in eval_candles)     # Lowest low

            current_candle = ohlcv[-1]
            candle_ts = current_candle[0]
            current_close = float(current_candle[4])
            current_high = float(current_candle[2])
            current_low = float(current_candle[3])
            prev_price = state["prev_price"] if state["prev_price"] is not None else current_close

            readable_time = datetime.fromtimestamp(candle_ts / 1000, tz=timezone.utc).strftime(
                "%Y-%m-%d %H:%M UTC"
            )

            # --- Dynamic Resistance Broken (Breakout) ---
            if current_close > dynamic_resistance and prev_price <= dynamic_resistance:
                if state["last_res_break_ts"] != candle_ts:
                    msg = (
                        f"🚀 *RESISTANCE BROKEN (BREAKOUT)*\n"
                        f"Pair: {pair}\n"
                        f"Current Price: {current_close}\n"
                        f"Broken Resistance: {dynamic_resistance}\n"
                        f"Timeframe: {self.timeframe} (Last {self.lookback} candles)\n"
                        f"Time: {readable_time}"
                    )
                    self.notifier.send_alert(msg)
                    state["last_res_break_ts"] = candle_ts

            # --- Dynamic Support Broken (Breakdown) ---
            if current_close < dynamic_support and prev_price >= dynamic_support:
                if state["last_sup_break_ts"] != candle_ts:
                    msg = (
                        f"⚠️ *SUPPORT BROKEN (BREAKDOWN)*\n"
                        f"Pair: {pair}\n"
                        f"Current Price: {current_close}\n"
                        f"Broken Support: {dynamic_support}\n"
                        f"Timeframe: {self.timeframe} (Last {self.lookback} candles)\n"
                        f"Time: {readable_time}"
                    )
                    self.notifier.send_alert(msg)
                    state["last_sup_break_ts"] = candle_ts

            # --- Static / Fixed Support Levels ---
            for sup_level in pair_config.get("fixed_support", []):
                key = f"sup_{sup_level}"
                if current_low <= sup_level and prev_price > sup_level:
                    if key not in state["fixed_triggered"]:
                        msg = (
                            f"📉 *SUPPORT LEVEL BROKEN/TOUCHED*\n"
                            f"Pair: {pair}\n"
                            f"Current Price: {current_close}\n"
                            f"Support Level: {sup_level}\n"
                            f"Time: {readable_time}"
                        )
                        self.notifier.send_alert(msg)
                        state["fixed_triggered"].add(key)

            # --- Static / Fixed Resistance Levels ---
            for res_level in pair_config.get("fixed_resistance", []):
                key = f"res_{res_level}"
                if current_high >= res_level and prev_price < res_level:
                    if key not in state["fixed_triggered"]:
                        msg = (
                            f"📈 *RESISTANCE LEVEL REACHED/BROKEN*\n"
                            f"Pair: {pair}\n"
                            f"Current Price: {current_close}\n"
                            f"Resistance Level: {res_level}\n"
                            f"Time: {readable_time}"
                        )
                        self.notifier.send_alert(msg)
                        state["fixed_triggered"].add(key)

            # --- Price Target / Alerts ---
            for target in pair_config.get("price_targets", []):
                key = f"target_{target}"
                if (prev_price < target <= current_close) or (prev_price > target >= current_close):
                    if key not in state["fixed_triggered"]:
                        msg = (
                            f"🎯 *PRICE TARGET HIT*\n"
                            f"Pair: {pair}\n"
                            f"Current Price: {current_close}\n"
                            f"Target: {target}\n"
                            f"Time: {readable_time}"
                        )
                        self.notifier.send_alert(msg)
                        state["fixed_triggered"].add(key)

            state["prev_price"] = current_close
            logger.info(
                f"[{pair}] Price: {current_close:.2f} | Dyn Res: {dynamic_resistance:.2f} | Dyn Sup: {dynamic_support:.2f}"
            )

        except Exception as e:
            logger.error(f"Error checking {pair}: {e}")

    def run(self):
        logger.info("WhatsApp Price & S/R Monitor started.")
        pairs = self.config.get("pairs", {})
        logger.info(f"Monitoring {len(pairs)} pairs: {', '.join(pairs.keys())}")

        while True:
            try:
                for pair, pair_cfg in pairs.items():
                    self.check_pair(pair, pair_cfg)
                    time.sleep(1)  # small pause to respect API rate limits
            except KeyboardInterrupt:
                logger.info("Bot stopped by user.")
                break
            except Exception as loop_err:
                logger.error(f"Unexpected error in monitor loop: {loop_err}")

            time.sleep(self.check_interval)


if __name__ == "__main__":
    cfg = load_config()
    bot = MarketMonitor(cfg)
    bot.run()
