import json
import os
import time
import logging

logger = logging.getLogger(__name__)

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
USERDATA_DIR = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
STATE_FILE = os.path.join(USERDATA_DIR, "portfolio_state.json")

PRIORITY = {
    "HighFrequencyCompoundElite": 3,
    "TrendIgnitionElite": 2,
    "TTMSqueezeBreakoutElite": 1
}

def get_state() -> dict:
    if not os.path.exists(STATE_FILE):
        default_state = {
            "active_strategy": None,
            "active_pair": None,
            "pending_intent": None,
            "status": "IDLE",
            "last_update": time.time()
        }
        set_state(default_state)
        return default_state
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Error reading portfolio state: {e}")
        return {
            "active_strategy": None,
            "active_pair": None,
            "pending_intent": None,
            "status": "IDLE",
            "last_update": time.time()
        }

def set_state(data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        data["last_update"] = time.time()
        with open(STATE_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        logger.error(f"Error writing portfolio state: {e}")

# Auto-initialize state file upon module import
try:
    if not os.path.exists(STATE_FILE):
        set_state({
            "active_strategy": None,
            "active_pair": None,
            "pending_intent": None,
            "status": "IDLE"
        })
        logger.info(f"[PortfolioCoordinator] State file initialized at {STATE_FILE}")
    else:
        logger.info(f"[PortfolioCoordinator] Connected to existing state file at {STATE_FILE}")
except Exception as e:
    logger.error(f"[PortfolioCoordinator] Init error: {e}")

def notify_whatsapp(event_type: str, data: dict) -> None:
    """Dispatches real-time preemption alerts directly to the WhatsApp bridge"""
    try:
        import urllib.request
        payload = json.dumps({
            "type": "preemption_alert",
            "event": event_type,
            **data
        }).encode("utf-8")
        req = urllib.request.Request(
            "http://127.0.0.1:5001/preemption-alert",
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=1.5)
    except Exception:
        # Bridge may be offline, do not block trading
        pass

def request_preemption(strategy_name: str, pair: str) -> None:
    state = get_state()
    strat_priority = PRIORITY.get(strategy_name, 1)
    
    current_strat = state.get("active_strategy")
    current_priority = PRIORITY.get(current_strat, 0) if current_strat else 0
    
    # Preemption ONLY makes sense if another lower-priority strategy is ACTUALLY active and holding capital!
    if not current_strat or strat_priority <= current_priority:
        return

    # Check if we already have an active pending intent for this strategy and pair (prevent 4-second loop spam)
    existing_intent = state.get("pending_intent")
    if existing_intent:
        if existing_intent.get("strategy") == strategy_name and existing_intent.get("pair") == pair:
            # Already requested, check cooldown (e.g. at least 15 minutes before re-notifying)
            if time.time() - existing_intent.get("requested_at", 0) < 900:
                return

    state["pending_intent"] = {
        "strategy": strategy_name,
        "pair": pair,
        "priority": strat_priority,
        "requested_at": time.time(),
        "status": "WAITING_FOR_BALANCE"
    }
    set_state(state)
    logger.info(f"[Coordinator] Preemption requested by {strategy_name} ({pair}) against {current_strat}")
    notify_whatsapp("PREEMPTION_REQUESTED", {
        "incoming_strategy": strategy_name,
        "incoming_pair": pair,
        "current_strategy": current_strat,
        "current_pair": state.get("active_pair")
    })

def release_balance() -> None:
    state = get_state()
    prev_active = state.get("active_strategy")
    prev_pair = state.get("active_pair")
    incoming_strat = state.get("pending_intent", {}).get("strategy") if state.get("pending_intent") else None
    incoming_pair = state.get("pending_intent", {}).get("pair") if state.get("pending_intent") else None

    if state.get("pending_intent"):
        state["pending_intent"]["status"] = "BALANCE_RELEASED"
        state["pending_intent"]["released_at"] = time.time()
    state["active_strategy"] = None
    state["active_pair"] = None
    state["status"] = "IDLE"
    set_state(state)
    logger.info("[Coordinator] Balance released. Ready for high-priority execution.")
    
    notify_whatsapp("BALANCE_RELEASED", {
        "released_from_strategy": prev_active,
        "released_from_pair": prev_pair,
        "incoming_strategy": incoming_strat,
        "incoming_pair": incoming_pair
    })

def confirm_entry(strategy_name: str, pair: str) -> None:
    state = get_state()
    state["active_strategy"] = strategy_name
    state["active_pair"] = pair
    state["status"] = "BUSY"
    state["pending_intent"] = None
    set_state(state)
    logger.info(f"[Coordinator] Entry confirmed for {strategy_name} ({pair}). State set to BUSY.")

def confirm_exit(strategy_name: str, pair: str) -> None:
    state = get_state()
    if state.get("active_strategy") == strategy_name:
        state["active_strategy"] = None
        state["active_pair"] = None
        state["status"] = "IDLE"
        set_state(state)
        logger.info(f"[Coordinator] Exit confirmed for {strategy_name} ({pair}). State set to IDLE.")

