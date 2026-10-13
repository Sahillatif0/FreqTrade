import json
import os
import time
import logging

logger = logging.getLogger(__name__)

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
USERDATA_DIR = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
STATE_FILE = os.path.join(USERDATA_DIR, "portfolio_state.json")

PRIORITY = {
    # 6-Bot Optimal Compounding Hierarchy (13 October 2026 Optimization)
    "FVGReclaimFiller15m": 6,
    "VolatilitySqueezeBreakoutElite15m": 5,
    "LiquiditySweepPro15m": 4,
    "TournamentSpeedSniper5m": 3,
    "TTMSqueezeBreakoutElite": 2,
    "FastScalpElite2h5m": 1,
    # Common Aliases & Fallbacks
    "FVGReclaimFiller": 6,
    "FVGReclaim": 6,
    "FVG": 6,
    "VolatilitySqueezeBreakout": 5,
    "SqueezeElite": 5,
    "Squeeze": 5,
    "HighFrequencySweepPro": 4,
    "LiquiditySweepPro": 4,
    "SweepPro": 4,
    "TournamentSpeedSniper": 3,
    "Tournament": 3,
    "TourneySniper": 3,
    "TournamentApexComp5m": 3,
    "TTM": 2,
    "TTMSqueeze": 2,
    "FastScalpElite": 1,
    "FastScalp": 1,
    "FastScalp2h": 1,
    # Legacy fallbacks
    "HighFrequencySweepApex5m": 1,
    "Apex": 1,
    "HighFrequencySweepApex": 1,
    "CapitalVelocityFiller5m": 0,
    "CapitalVelocityFiller": 0,
    "Filler": 0,
    "TrendIgnitionSimplePullback": 1,
    "TrendIgnitionElite": 1
}

class EntryPermission:
    """Provides dual compatibility: acts as boolean and unpacks as (allowed, reason)"""
    def __init__(self, allowed: bool, reason: str):
        self.allowed = bool(allowed)
        self.reason = str(reason)
        
    def __bool__(self):
        return self.allowed
        
    def __iter__(self):
        return iter((self.allowed, self.reason))
        
    def __repr__(self):
        return f"EntryPermission(allowed={self.allowed}, reason='{self.reason}')"

def get_state() -> dict:
    if not os.path.exists(STATE_FILE):
        default_state = {
            "active_strategy": None,
            "active_pair": None,
            "pending_intent": None,
            "status": "IDLE",
            "circuit_breaker": {
                "is_locked": False,
                "tier": "NORMAL",
                "lock_reason": None,
                "locked_until": 0,
                "lock_started_at": 0
            },
            "recent_losses": [],
            "last_update": time.time()
        }
        set_state(default_state)
        return default_state
    try:
        with open(STATE_FILE, "r") as f:
            data = json.load(f)
            if "circuit_breaker" not in data:
                data["circuit_breaker"] = {
                    "is_locked": False,
                    "tier": "NORMAL",
                    "lock_reason": None,
                    "locked_until": 0,
                    "lock_started_at": 0
                }
            if "recent_losses" not in data:
                data["recent_losses"] = []
            return data
    except Exception as e:
        logger.warning(f"Error reading portfolio state: {e}")
        return {
            "active_strategy": None,
            "active_pair": None,
            "pending_intent": None,
            "status": "IDLE",
            "circuit_breaker": {
                "is_locked": False,
                "tier": "NORMAL",
                "lock_reason": None,
                "locked_until": 0,
                "lock_started_at": 0
            },
            "recent_losses": [],
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
            "status": "IDLE",
            "circuit_breaker": {
                "is_locked": False,
                "tier": "NORMAL",
                "lock_reason": None,
                "locked_until": 0,
                "lock_started_at": 0
            },
            "recent_losses": []
        })
        logger.info(f"[PortfolioCoordinator] State file initialized at {STATE_FILE}")
    else:
        logger.info(f"[PortfolioCoordinator] Connected to existing state file at {STATE_FILE}")
except Exception as e:
    logger.error(f"[PortfolioCoordinator] Init error: {e}")

def notify_whatsapp(event_type: str, data: dict) -> None:
    """Dispatches real-time alerts directly to the WhatsApp bridge server"""
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
        # Bridge may be offline or unreachable, do not block trading
        pass

# ---------------------------------------------------------------------------
# BTC MACRO WATERFALL CRASH GUARD
# ---------------------------------------------------------------------------
_last_btc_check = 0
_cached_btc_status = (True, "BTC Healthy")

def check_btc_health() -> tuple:
    """Inspects recent BTC price action to prevent buying into systemic dumps"""
    global _last_btc_check, _cached_btc_status
    now = time.time()
    # Cache result for 60 seconds to avoid constant disk I/O
    if now - _last_btc_check < 60:
        return _cached_btc_status
        
    _last_btc_check = now
    
    # Check possible feather locations
    candidate_paths = [
        os.path.join(USERDATA_DIR, "data", "binance", "BTC_USDT-15m.feather"),
        os.path.join(USERDATA_DIR, "data", "binance", "BTC_USDT-5m.feather"),
        os.path.join(CURRENT_DIR, "..", "..", "user_data", "data", "binance", "BTC_USDT-15m.feather"),
        os.path.join(CURRENT_DIR, "..", "..", "user_data", "data", "binance", "BTC_USDT-5m.feather")
    ]
    
    btc_path = None
    for p in candidate_paths:
        if os.path.exists(p):
            btc_path = p
            break
            
    if not btc_path:
        _cached_btc_status = (True, "BTC data file not found, defaulting open")
        return _cached_btc_status
        
    try:
        import pandas as pd
        df = pd.read_feather(btc_path)
        if len(df) < 20:
            _cached_btc_status = (True, "Insufficient BTC bars")
            return _cached_btc_status
            
        recent = df.tail(16) # Last 4 hours (16 bars of 15m)
        cur_close = float(recent.iloc[-1]['close'])
        high_4h = float(recent['high'].max())
        
        # 1. Waterfall dump check: Drop >= 1.8% from 4h high
        dump_pct = (cur_close - high_4h) / high_4h
        if dump_pct <= -0.018:
            _cached_btc_status = (False, f"BTC 4h waterfall dump active ({dump_pct:.2%} from 4h high of ${high_4h:.0f})")
            return _cached_btc_status
            
        # 2. Severe breakdown below 50 SMA
        if len(df) >= 50:
            sma50 = float(df['close'].tail(50).mean())
            if cur_close < sma50 * 0.990:
                _cached_btc_status = (False, f"BTC severely below 50 SMA (${cur_close:.0f} vs ${sma50:.0f})")
                return _cached_btc_status
                
        _cached_btc_status = (True, "BTC Healthy")
        return _cached_btc_status
    except Exception as e:
        logger.warning(f"[Coordinator] Error checking BTC health: {e}")
        _cached_btc_status = (True, f"BTC check exception: {e}")
        return _cached_btc_status

# ---------------------------------------------------------------------------
# GLOBAL PORTFOLIO CIRCUIT BREAKER
# ---------------------------------------------------------------------------
def is_circuit_breaker_active() -> tuple:
    """Returns (is_locked: bool, tier: str, reason: str, remaining_seconds: float)"""
    state = get_state()
    cb = state.get("circuit_breaker", {})
    if not cb.get("is_locked", False):
        return False, "NORMAL", None, 0.0
        
    locked_until = cb.get("locked_until", 0)
    now = time.time()
    if now < locked_until:
        remaining = locked_until - now
        return True, cb.get("tier", "LOCKED"), cb.get("lock_reason", "Circuit breaker active"), remaining
    else:
        # Auto-unlock when lock duration expires!
        cb["is_locked"] = False
        cb["tier"] = "NORMAL"
        cb["lock_reason"] = None
        cb["unlocked_at"] = now
        state["circuit_breaker"] = cb
        set_state(state)
        logger.info("[Coordinator] Circuit breaker cooldown expired. Portfolio UNLOCKED.")
        notify_whatsapp("CIRCUIT_BREAKER_UNLOCKED", {
            "unlocked_at": now,
            "message": "Portfolio circuit breaker cooldown complete. Trading resumed."
        })
        return False, "NORMAL", None, 0.0

def register_loss(strategy_name: str, pair: str, profit_ratio: float, exit_reason: str) -> None:
    """Registers a trade loss and evaluates global portfolio circuit breaker thresholds."""
    state = get_state()
    now = time.time()
    
    losses = state.get("recent_losses", [])
    # Prune losses older than 24 hours (86,400 seconds)
    losses = [l for l in losses if (now - l.get("timestamp", 0)) < 86400]
    
    # Record the new loss event
    losses.append({
        "strategy": strategy_name,
        "pair": pair,
        "profit_ratio": profit_ratio,
        "exit_reason": exit_reason,
        "timestamp": now
    })
    state["recent_losses"] = losses
    
    # Count losses in the last 12 hours (43,200s) and last 24 hours (86,400s)
    losses_12h = [l for l in losses if (now - l.get("timestamp", 0)) < 43200]
    losses_24h = losses # already pruned to 24h
    
    count_12h = len(losses_12h)
    count_24h = len(losses_24h)
    
    logger.warning(f"[Coordinator] Loss registered: {strategy_name} ({pair}) {profit_ratio:.2%}. Recent losses: {count_12h} in 12h, {count_24h} in 24h")
    
    cb = state.get("circuit_breaker", {})
    
    # Rule 2: Hard Circuit Breaker (3 or more losses in 24h -> 12-Hour Emergency Freeze)
    if count_24h >= 3:
        lock_duration = 43200 # 12 hours
        cb["is_locked"] = True
        cb["tier"] = "HARD_LOCKDOWN"
        cb["lock_reason"] = f"EMERGENCY HARD LOCKDOWN: {count_24h} losses in 24h (Last: {strategy_name} {pair} {profit_ratio:.2%})"
        cb["lock_started_at"] = now
        cb["locked_until"] = now + lock_duration
        state["circuit_breaker"] = cb
        set_state(state)
        logger.error(f"[Coordinator] 🚨 EMERGENCY HARD CIRCUIT BREAKER TRIGGERED! 12-Hour lockdown until {time.ctime(cb['locked_until'])}")
        notify_whatsapp("CIRCUIT_BREAKER_TRIGGERED", {
            "tier": "HARD_LOCKDOWN (12-Hour Freeze)",
            "reason": cb["lock_reason"],
            "loss_count_24h": count_24h,
            "loss_count_12h": count_12h,
            "locked_until": cb["locked_until"],
            "strategy": strategy_name,
            "pair": pair,
            "profit_ratio": profit_ratio
        })
        return

    # Rule 1: Soft Brake (2 losses in 12h -> 4-Hour Cooldown)
    elif count_12h >= 2:
        lock_duration = 14400 # 4 hours
        cb["is_locked"] = True
        cb["tier"] = "SOFT_BRAKE"
        cb["lock_reason"] = f"SOFT BRAKE: {count_12h} losses in 12h (Last: {strategy_name} {pair} {profit_ratio:.2%})"
        cb["lock_started_at"] = now
        cb["locked_until"] = now + lock_duration
        state["circuit_breaker"] = cb
        set_state(state)
        logger.warning(f"[Coordinator] ⚠️ SOFT BRAKE TRIGGERED! 4-Hour cooldown until {time.ctime(cb['locked_until'])}")
        notify_whatsapp("CIRCUIT_BREAKER_TRIGGERED", {
            "tier": "SOFT_BRAKE (4-Hour Cooldown)",
            "reason": cb["lock_reason"],
            "loss_count_24h": count_24h,
            "loss_count_12h": count_12h,
            "locked_until": cb["locked_until"],
            "strategy": strategy_name,
            "pair": pair,
            "profit_ratio": profit_ratio
        })
        return
        
    set_state(state)

def manual_reset_circuit_breaker() -> None:
    """Manual override to reset circuit breaker and clear recent losses"""
    state = get_state()
    state["circuit_breaker"] = {
        "is_locked": False,
        "tier": "NORMAL",
        "lock_reason": None,
        "locked_until": 0,
        "lock_started_at": 0
    }
    state["recent_losses"] = []
    set_state(state)
    logger.info("[Coordinator] Manual reset: Circuit breaker and recent losses cleared.")

# ---------------------------------------------------------------------------
# PREEMPTION & CAPITAL HANDSHAKE
# ---------------------------------------------------------------------------
def request_preemption(strategy_name: str, pair: str) -> None:
    state = get_state()
    strat_priority = PRIORITY.get(strategy_name, 1)
    
    current_strat = state.get("active_strategy")
    current_priority = PRIORITY.get(current_strat, 0) if current_strat else 0
    
    if not current_strat or strat_priority <= current_priority:
        return

    existing_intent = state.get("pending_intent")
    if existing_intent:
        if existing_intent.get("strategy") == strategy_name and existing_intent.get("pair") == pair:
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

SOFT_FLOOR_THRESHOLD = -0.005  # -0.50% max negative drawdown allowed for preemption

def reject_preemption(active_strategy: str, pair: str, current_profit: float) -> None:
    """Invoked when an active lower-priority trade cannot yield balance due to Soft Floor (-0.50%) protection"""
    state = get_state()
    pending = state.get("pending_intent")
    if not pending or pending.get("status") != "WAITING_FOR_BALANCE":
        return

    incoming_strat = pending.get("strategy")
    incoming_pair = pending.get("pair")
    
    pending["status"] = "REJECTED_SOFT_FLOOR"
    pending["rejected_at"] = time.time()
    pending["current_profit"] = current_profit
    set_state(state)
    logger.info(f"[Coordinator] Preemption by {incoming_strat} rejected by soft floor on {active_strategy} ({pair} at {current_profit:.2%})")

    notify_whatsapp("PREEMPTION_REJECTED", {
        "active_strategy": active_strategy,
        "pair": pair,
        "current_profit": current_profit,
        "incoming_strategy": incoming_strat,
        "incoming_pair": incoming_pair
    })

# ---------------------------------------------------------------------------
# ENTRY & EXIT GATEWAYS
# ---------------------------------------------------------------------------
def can_enter(strategy_name: str, pair: str = None) -> EntryPermission:
    """
    Evaluates whether strategy is authorized to enter:
    1. Global Circuit Breaker Check (2 losses in 12h = 4h lock, 3 losses in 24h = 12h lock)
    2. BTC Macro Waterfall Crash Check (Dumps >= 1.8% in 4h)
    3. Slot allocation check (Is slot IDLE or already claimed by this strategy)
    Returns EntryPermission object (evaluates as boolean and unpacks as (allowed, reason)).
    """
    # Check 1: Global Circuit Breaker
    is_locked, tier, lock_reason, remaining_secs = is_circuit_breaker_active()
    if is_locked:
        rem_hours = remaining_secs / 3600.0
        return EntryPermission(False, f"CIRCUIT_BREAKER_{tier}: {lock_reason} ({rem_hours:.1f}h remaining)")
        
    # Check 2: BTC Macro Health Filter
    btc_ok, btc_reason = check_btc_health()
    if not btc_ok:
        return EntryPermission(False, f"BTC_CRASH_GUARD: {btc_reason}")
        
    # Check 3: Slot Allocation
    state = get_state()
    active_strat = state.get("active_strategy")
    if not active_strat or active_strat == strategy_name:
        return EntryPermission(True, "SLOT_AVAILABLE")
        
    # Auto-recover if state has been untouched for > 30 hours
    if time.time() - state.get("last_update", 0) > 108000:
        logger.warning(f"[Coordinator] State expired. Allowing entry for {strategy_name}.")
        return EntryPermission(True, "STATE_EXPIRED_RECOVERED")
        
    # Slot is busy: check preemption intent
    strat_priority = PRIORITY.get(strategy_name, 1)
    active_priority = PRIORITY.get(active_strat, 0)
    
    if strat_priority > active_priority:
        request_preemption(strategy_name, pair)
        return EntryPermission(False, f"SLOT_BUSY_PREEMPTION_PENDING (Priority {strat_priority} > {active_priority} on {active_strat})")
        
    return EntryPermission(False, f"SLOT_BUSY (Held by {active_strat} Priority {active_priority} >= {strat_priority})")

def confirm_entry(strategy_name: str, pair: str) -> None:
    state = get_state()
    state["active_strategy"] = strategy_name
    state["active_pair"] = pair
    state["status"] = "BUSY"
    state["pending_intent"] = None
    set_state(state)
    logger.info(f"[Coordinator] Entry confirmed for {strategy_name} ({pair}). State set to BUSY.")

def confirm_exit(strategy_name: str, pair: str, profit_ratio: float = None, exit_reason: str = None) -> None:
    state = get_state()
    
    # If trade exited with a loss, register it to the global circuit breaker!
    if profit_ratio is not None and (profit_ratio < -0.005 or exit_reason in ['stop_loss', 'stoploss', 'trailing_stop_loss']):
        if profit_ratio < 0:
            register_loss(strategy_name, pair, profit_ratio, exit_reason or "loss")
            
    if state.get("active_strategy") == strategy_name:
        pending = state.get("pending_intent")
        if pending and pending.get("status") == "WAITING_FOR_BALANCE":
            release_balance()
        else:
            state["active_strategy"] = None
            state["active_pair"] = None
            state["status"] = "IDLE"
            set_state(state)
            logger.info(f"[Coordinator] Exit confirmed for {strategy_name} ({pair}). State set to IDLE.")
