const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    Browsers
} = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function fetchHttpsJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

const app = express();
app.use(express.json());

const BRIDGE_PORT = 5001;

// Helper to auto-load bot API credentials from userdata/config_bot*.json if present
function loadBotConfig(configFile, defaults) {
    const configPath = path.join(__dirname, '..', 'userdata', configFile);
    if (fs.existsSync(configPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (raw.api_server) {
                return {
                    ...defaults,
                    host: (raw.api_server.listen_ip_address === '0.0.0.0' || !raw.api_server.listen_ip_address) ? '127.0.0.1' : raw.api_server.listen_ip_address,
                    port: raw.api_server.listen_port || defaults.port,
                    username: raw.api_server.username || defaults.username,
                    password: raw.api_server.password || defaults.password
                };
            }
        } catch (e) {
            console.warn(`[ConfigLoader] Could not parse ${configFile}: ${e.message}`);
        }
    }
    return defaults;
}

// Tri-Bot Freqtrade API Server Config with auto-detection from config files
const FT_BOTS = {
    bot1: loadBotConfig('config_bot1_sweep.json', {
        id: 1,
        name: 'Sweep Elite 7',
        tag: '⚡ SWEEP ELITE 7',
        host: '127.0.0.1',
        port: 8080,
        username: 'freqtrader',
        password: process.env.FT_PASSWORD || '724455'
    }),
    bot2: loadBotConfig('config_bot2_ignition.json', {
        id: 2,
        name: 'Trend Ignition Elite',
        tag: '🚀 TREND IGNITION ELITE',
        host: '127.0.0.1',
        port: 8081,
        username: 'freqtrader',
        password: process.env.FT_PASSWORD || '724455'
    }),
    bot3: loadBotConfig('config_bot3_donchian.json', {
        id: 3,
        name: 'Range Breakout Donchian Pro',
        tag: '💎 DONCHIAN PRO',
        host: '127.0.0.1',
        port: 8082,
        username: 'freqtrader',
        password: process.env.FT_PASSWORD || '724455'
    })
};

console.log('[Bridge Config] Loaded bot ports:', {
    bot1: `${FT_BOTS.bot1.host}:${FT_BOTS.bot1.port} (${FT_BOTS.bot1.username})`,
    bot2: `${FT_BOTS.bot2.host}:${FT_BOTS.bot2.port} (${FT_BOTS.bot2.username})`,
    bot3: `${FT_BOTS.bot3.host}:${FT_BOTS.bot3.port} (${FT_BOTS.bot3.username})`
});

const FT_API_HOST = FT_BOTS.bot1.host;
const FT_API_PORT = FT_BOTS.bot1.port;
const FT_USERNAME = FT_BOTS.bot1.username;
const FT_PASSWORD = FT_BOTS.bot1.password;

const TARGET_FILE = path.join(__dirname, 'target_number.txt');
const ALERTS_FILE = path.join(__dirname, 'custom_alerts.json');
let TARGET_JID = '';

if (fs.existsSync(TARGET_FILE)) {
    TARGET_JID = fs.readFileSync(TARGET_FILE, 'utf8').trim();
}

// In-memory & disk-backed custom price alerts: [{ id, pair, targetPrice, direction, createdTime }]
let customAlerts = [];
if (fs.existsSync(ALERTS_FILE)) {
    try {
        customAlerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    } catch (e) {
        customAlerts = [];
    }
}

function saveCustomAlerts() {
    try {
        fs.writeFileSync(ALERTS_FILE, JSON.stringify(customAlerts, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving custom alerts:', e.message);
    }
}

const TP_FILE = path.join(__dirname, 'custom_takeprofits.json');
// In-memory & disk-backed custom take profit targets per trade: { [tradeId]: { targetRatio, targetPrice, pair } }
let customTakeProfits = {};
if (fs.existsSync(TP_FILE)) {
    try {
        customTakeProfits = JSON.parse(fs.readFileSync(TP_FILE, 'utf8'));
    } catch (e) {
        customTakeProfits = {};
    }
}

function saveCustomTakeProfits() {
    try {
        fs.writeFileSync(TP_FILE, JSON.stringify(customTakeProfits, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving custom take profits:', e.message);
    }
}

const SL_FILE = path.join(__dirname, 'custom_stoplosses.json');
// In-memory & disk-backed custom stop loss targets per trade: { [tradeId]: { targetRatio, targetPrice, pair, botKey } }
let customStopLosses = {};
if (fs.existsSync(SL_FILE)) {
    try {
        customStopLosses = JSON.parse(fs.readFileSync(SL_FILE, 'utf8'));
    } catch (e) {
        customStopLosses = {};
    }
}

function saveCustomStopLosses() {
    try {
        fs.writeFileSync(SL_FILE, JSON.stringify(customStopLosses, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving custom stop losses:', e.message);
    }
}

// Strategy minimal_roi configuration tables for time-decayed Take Profit
const STRATEGY_ROI_TABLES = {
    bot1: [ // SweepElite7 (5m): {"0": 0.025, "45": 0.019, "90": 0.013, "180": 0.007}
        { min: 180, roi: 0.007 },
        { min: 90,  roi: 0.013 },
        { min: 45,  roi: 0.019 },
        { min: 0,   roi: 0.025 }
    ],
    bot2: [ // TrendIgnitionElite (15m): {"0": 0.028, "30": 0.019, "75": 0.013, "150": 0.008}
        { min: 150, roi: 0.008 },
        { min: 75,  roi: 0.013 },
        { min: 30,  roi: 0.019 },
        { min: 0,   roi: 0.028 }
    ],
    bot3: [ // RangeBreakoutDonchianPro (1h): {"0": 0.048, "120": 0.035, "240": 0.025, "480": 0.015}
        { min: 480, roi: 0.015 },
        { min: 240, roi: 0.025 },
        { min: 120, roi: 0.035 },
        { min: 0,   roi: 0.048 }
    ]
};

function getActiveStrategyRoi(botKey, elapsedMinutes) {
    const table = STRATEGY_ROI_TABLES[botKey] || STRATEGY_ROI_TABLES.bot1;
    for (const step of table) {
        if (elapsedMinutes >= step.min) {
            return step.roi;
        }
    }
    return table[table.length - 1].roi;
}

// Track trade profit milestones to prevent duplicate milestone notifications
// tradeId -> { plus1: boolean, minus1: boolean, twoHours: boolean }
const tradeMilestones = {};

let sock = null;
let isConnected = false;
let authToken = '';

// Convert UTC or date string to Asia/Karachi (PKT, UTC+5)
function toKarachiTime(dateInput) {
    if (!dateInput) return 'N/A';
    try {
        let d;
        if (typeof dateInput === 'string' && !dateInput.includes('Z') && !dateInput.includes('+')) {
            // Assume UTC from Freqtrade DB
            d = new Date(dateInput.replace(' ', 'T') + 'Z');
        } else {
            d = new Date(dateInput);
        }

        if (isNaN(d.getTime())) return dateInput;

        return d.toLocaleString('en-US', {
            timeZone: 'Asia/Karachi',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }) + ' PKT';
    } catch (e) {
        return dateInput;
    }
}

// Centralized safe sender: prevents "Waiting for this message" decryption issues
// by performing onWhatsApp pre-flight handshake and session warmup for proactive outbound alerts.
async function sendWhatsAppSafe(rawDestination, content) {
    if (!sock || !isConnected) {
        console.warn('⚠️ WhatsApp not connected. Message deferred/dropped.');
        return false;
    }

    let dest = rawDestination || TARGET_JID;
    if (!dest) {
        console.warn('⚠️ No destination JID available for outbound message.');
        return false;
    }

    dest = dest.trim();

    // Format destination cleanly
    let targetJid = dest;
    if (!targetJid.includes('@')) {
        targetJid = `${targetJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    } else {
        targetJid = jidNormalizedUser(targetJid);
    }

    try {
        // Pre-flight handshake: warms up Signal keys and verifies session before sending
        // This eliminates the "Waiting for this message. This may take a while" issue on outbound alerts.
        if (targetJid.endsWith('@s.whatsapp.net') && typeof sock.onWhatsApp === 'function') {
            try {
                const phoneOnly = targetJid.split('@')[0];
                const [check] = await sock.onWhatsApp(phoneOnly);
                if (check?.exists && check?.jid) {
                    targetJid = check.jid;
                }
            } catch (err) {
                // If onWhatsApp check fails or times out, proceed with normalized targetJid
            }
        }

        await sock.sendMessage(targetJid, content);
        return true;
    } catch (sendErr) {
        console.error(`Failed to send WhatsApp message to ${targetJid}:`, sendErr.message);
        return false;
    }
}


// Helper function to call Freqtrade REST API on specific bot (default: bot1)
function callFreqtradeApi(endpoint, method = 'GET', body = null, botKey = 'bot1') {
    return new Promise((resolve, reject) => {
        const bot = (typeof botKey === 'object' ? botKey : FT_BOTS[botKey]) || FT_BOTS.bot1;
        const auth = 'Basic ' + Buffer.from(`${bot.username}:${bot.password}`).toString('base64');
        const options = {
            hostname: bot.host,
            port: bot.port,
            path: '/api/v1' + endpoint,
            method: method,
            headers: {
                'Authorization': auth,
                'Content-Type': 'application/json'
            },
            timeout: 6000
        };

        const req = http.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(responseData);
                } catch (e) {
                    parsed = responseData;
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const detail = (parsed && typeof parsed === 'object' && parsed.detail) ? parsed.detail : (typeof parsed === 'string' ? parsed : `HTTP ${res.statusCode}`);
                    const err = new Error(`[${bot.name} :${bot.port}] ${res.statusCode} ${detail}`);
                    err.statusCode = res.statusCode;
                    err.bot = bot;
                    console.error(`[API ERROR] ${bot.name} (port ${bot.port}) ${method} ${endpoint} returned HTTP ${res.statusCode}: ${detail}`);
                    return reject(err);
                }

                resolve(parsed);
            });
        });

        req.on('error', (err) => {
            const connectErr = new Error(`[${bot.name} :${bot.port}] Connection Failed: ${err.message}`);
            connectErr.bot = bot;
            console.error(`[API CONNECT ERROR] ${bot.name} (port ${bot.port}) ${endpoint}: ${err.message}`);
            reject(connectErr);
        });

        req.on('timeout', () => {
            req.destroy();
            const timeoutErr = new Error(`[${bot.name} :${bot.port}] Request timed out`);
            timeoutErr.bot = bot;
            reject(timeoutErr);
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Generate full daily morning digest across all 3 bots
async function generateDailyDigest() {
    try {
        const [p1, p2, p3, balance, s1, s2, s3, fng, btcTicker] = await Promise.all([
            callFreqtradeApi('/profit', 'GET', null, 'bot1').catch(() => ({})),
            callFreqtradeApi('/profit', 'GET', null, 'bot2').catch(() => ({})),
            callFreqtradeApi('/profit', 'GET', null, 'bot3').catch(() => ({})),
            callFreqtradeApi('/balance', 'GET', null, 'bot1').catch(async () => {
                return await callFreqtradeApi('/balance', 'GET', null, 'bot2').catch(() => ({}));
            }),
            callFreqtradeApi('/status', 'GET', null, 'bot1').catch(() => ([])),
            callFreqtradeApi('/status', 'GET', null, 'bot2').catch(() => ([])),
            callFreqtradeApi('/status', 'GET', null, 'bot3').catch(() => ([])),
            fetchHttpsJson('https://api.alternative.me/fng/?limit=1').catch(() => null),
            fetchHttpsJson('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT').catch(() => null)
        ]);

        const totalEquity = balance.total ? balance.total.toFixed(2) : 'N/A';
        const pkrVal = balance.value ? Number(balance.value).toLocaleString('en-US', {maximumFractionDigits: 0}) : 'N/A';

        const totalProfitUSDT = (
            (p1.profit_closed_coin || 0) +
            (p2.profit_closed_coin || 0) +
            (p3.profit_closed_coin || 0)
        ).toFixed(2);

        const totalWins = (p1.winning_trades || 0) + (p2.winning_trades || 0) + (p3.winning_trades || 0);
        const totalLosses = (p1.losing_trades || 0) + (p2.losing_trades || 0) + (p3.losing_trades || 0);
        const totalClosed = totalWins + totalLosses;
        const winRate = totalClosed > 0 ? ((totalWins / totalClosed) * 100).toFixed(1) : '100.0';

        const openCount = (Array.isArray(s1) ? s1.length : 0) +
                          (Array.isArray(s2) ? s2.length : 0) +
                          (Array.isArray(s3) ? s3.length : 0);

        const fngVal = fng?.data?.[0]?.value || 'N/A';
        const fngClass = fng?.data?.[0]?.value_classification || 'Neutral';
        const btcPrice = btcTicker?.lastPrice ? parseFloat(btcTicker.lastPrice).toLocaleString('en-US', {maximumFractionDigits: 0}) : 'N/A';
        const btcChange = btcTicker?.priceChangePercent ? parseFloat(btcTicker.priceChangePercent).toFixed(2) : '0.00';

        return `🌅 *DAILY TRADING DIGEST (3-BOT PORTFOLIO)*\n` +
               `────────────────────\n` +
               `💰 *Total Closed PnL:* ${totalProfitUSDT >= 0 ? '+' : ''}${totalProfitUSDT} USDT\n` +
               `   • Sweep 7: ${(p1.profit_closed_coin || 0).toFixed(2)} USDT\n` +
               `   • Ignition: ${(p2.profit_closed_coin || 0).toFixed(2)} USDT\n` +
               `   • Donchian: ${(p3.profit_closed_coin || 0).toFixed(2)} USDT\n` +
               `🏆 *Win Rate:* ${winRate}% (${totalWins}W / ${totalLosses}L)\n` +
               `⚖️ *Portfolio Equity:* ${totalEquity} USDT (${pkrVal} PKR)\n` +
               `📊 *Active Trades:* ${openCount} open\n` +
               `🪙 *Bitcoin:* $${btcPrice} (${btcChange >= 0 ? '+' : ''}${btcChange}%)\n` +
               `🎭 *Market Sentiment:* ${fngVal} (${fngClass})\n` +
               `⏰ *Report Time:* ${toKarachiTime(new Date())}\n` +
               `────────────────────\n` +
               `_Sweep (5m), Ignition (15m) & Donchian (1h) active!_ 🚀`;
    } catch (e) {
        return `⚠️ Could not compile daily digest: ${e.message}`;
    }
}

// Check every minute if it's 09:00 AM PKT (UTC+5) to send the morning digest
let lastDigestDate = '';
function checkMorningDigest() {
    try {
        const now = new Date();
        const karachiHour = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Karachi', hour: 'numeric', hour12: false }));
        const karachiMinute = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Karachi', minute: 'numeric' }));
        const todayStr = now.toLocaleDateString('en-US', { timeZone: 'Asia/Karachi' });

        if (karachiHour === 9 && karachiMinute === 0 && lastDigestDate !== todayStr && TARGET_JID && sock && isConnected) {
            lastDigestDate = todayStr;
            generateDailyDigest().then(msg => {
                sendWhatsAppSafe(TARGET_JID, { text: msg });
                console.log('Automated 9:00 AM PKT Daily Digest sent to', TARGET_JID);
            }).catch(console.error);
        }
    } catch (e) {
        console.error('Error in morning digest check:', e);
    }
}

// Background Monitor: Check Custom Price Alerts (Every 20 seconds)
async function checkCustomPriceAlerts() {
    if (!customAlerts.length || !TARGET_JID || !sock || !isConnected) return;

    try {
        const uniqueSymbols = [...new Set(customAlerts.map(a => a.symbol))];
        for (const sym of uniqueSymbols) {
            try {
                const ticker = await fetchHttpsJson(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
                const currentPrice = parseFloat(ticker.price);
                if (!currentPrice) continue;

                // Check alerts for this symbol
                for (let i = customAlerts.length - 1; i >= 0; i--) {
                    const alert = customAlerts[i];
                    if (alert.symbol !== sym) continue;

                    let triggered = false;
                    if (alert.direction === 'above' && currentPrice >= alert.targetPrice) {
                        triggered = true;
                    } else if (alert.direction === 'below' && currentPrice <= alert.targetPrice) {
                        triggered = true;
                    }

                    if (triggered) {
                        const dirEmoji = alert.direction === 'above' ? '🚀' : '📉';
                        const alertMsg = `${dirEmoji} *PRICE ALERT TRIGGERED*\n` +
                                         `────────────────────\n` +
                                         `🪙 *Pair:* ${alert.pair}\n` +
                                         `🎯 *Target Price:* $${alert.targetPrice}\n` +
                                         `💵 *Current Price:* *$${currentPrice}*\n` +
                                         `⏰ *Time:* ${toKarachiTime(new Date())}\n` +
                                         `────────────────────\n` +
                                         `_Alert has been fulfilled and removed._`;

                        await sendWhatsAppSafe(TARGET_JID, { text: alertMsg });
                        console.log(`Custom Price Alert fulfilled for ${alert.pair} at $${currentPrice}`);

                        // Remove triggered alert
                        customAlerts.splice(i, 1);
                        saveCustomAlerts();
                    }
                }
            } catch (err) {
                // Ignore transient network errors
            }
        }
    } catch (e) {
        console.error('Error in custom price alerts check:', e.message);
    }
}

// Background Monitor: Live Trade Milestones (+1.0% Profit & Duration Warnings)
async function checkTradeMilestones() {
    if (!TARGET_JID || !sock || !isConnected) return;

    try {
        const [open1, open2, open3] = await Promise.all([
            callFreqtradeApi('/status', 'GET', null, 'bot1').catch(() => []),
            callFreqtradeApi('/status', 'GET', null, 'bot2').catch(() => []),
            callFreqtradeApi('/status', 'GET', null, 'bot3').catch(() => [])
        ]);

        const tagged1 = (Array.isArray(open1) ? open1 : []).map(t => ({ ...t, botKey: 'bot1', botTag: FT_BOTS.bot1.tag }));
        const tagged2 = (Array.isArray(open2) ? open2 : []).map(t => ({ ...t, botKey: 'bot2', botTag: FT_BOTS.bot2.tag }));
        const tagged3 = (Array.isArray(open3) ? open3 : []).map(t => ({ ...t, botKey: 'bot3', botTag: FT_BOTS.bot3.tag }));
        const openTrades = [...tagged1, ...tagged2, ...tagged3];

        if (openTrades.length === 0) return;

        const now = Date.now();

        for (const trade of openTrades) {
            const tradeId = String(trade.trade_id);
            const milestoneKey = `${trade.botKey}_${tradeId}`;
            if (!tradeMilestones[milestoneKey]) {
                tradeMilestones[milestoneKey] = {
                    plus1: false,
                    minus1: false,
                    twoHours: false
                };
            }

            const state = tradeMilestones[milestoneKey];
            const pnlRatio = trade.profit_pct !== undefined ? (trade.profit_pct / 100) : (trade.profit_ratio || 0);
            const pnlPct = (pnlRatio * 100).toFixed(2);
            const openRate = parseFloat(trade.open_rate);
            const currentRate = parseFloat(trade.current_rate);
            const tpPrice = (openRate * 1.015).toFixed(4);

            // Milestone 1: Reaching +1.0% profit (Closing in on +1.5% TP)
            if (pnlRatio >= 0.010 && !state.plus1) {
                state.plus1 = true;
                const msg = `🔔 *TRADE MILESTONE: +1.0% PROFIT*\n` +
                            `────────────────────\n` +
                            `🪙 *Pair:* ${trade.pair}\n` +
                            `📈 *Current PnL:* *+${pnlPct}%*\n` +
                            `💵 *Current Price:* ${currentRate}\n` +
                            `🎯 *Take Profit Target:* ${tpPrice} (+1.5%)\n` +
                            `⏱️ *Status:* Approaching Take Profit! 🚀\n` +
                            `⏰ *Time:* ${toKarachiTime(new Date())}`;

                await sendWhatsAppSafe(TARGET_JID, { text: msg });
                console.log(`Milestone alert sent for trade #${tradeId} (${trade.pair}): +1.0%`);
            }

            // Milestone 2: Dipping to -1.0% (Risk Warning)
            if (pnlRatio <= -0.010 && !state.minus1) {
                state.minus1 = true;
                const slPrice = trade.stop_loss_abs ? parseFloat(trade.stop_loss_abs).toFixed(4) : (openRate * 0.985).toFixed(4);
                const msg = `⚠️ *TRADE WARNING: -1.0% DRAWDOWN*\n` +
                            `────────────────────\n` +
                            `🪙 *Pair:* ${trade.pair}\n` +
                            `📉 *Current PnL:* *${pnlPct}%*\n` +
                            `💵 *Current Price:* ${currentRate}\n` +
                            `🛡️ *Stop Loss Level:* ${slPrice} (-1.5%)\n` +
                            `⏱️ *Time:* ${toKarachiTime(new Date())}`;

                await sendWhatsAppSafe(TARGET_JID, { text: msg });
                console.log(`Milestone alert sent for trade #${tradeId} (${trade.pair}): -1.0%`);
            }

            // Milestone 3: Duration Warning (> 2 Hours in single trade)
            if (trade.open_timestamp && !state.twoHours) {
                const elapsedMin = Math.round((now - trade.open_timestamp) / 60000);
                if (elapsedMin >= 120) {
                    state.twoHours = true;
                    const msg = `⏳ *TRADE DURATION NOTICE (2h+)*\n` +
                                `────────────────────\n` +
                                `🪙 *Pair:* ${trade.pair}\n` +
                                `⏱️ *Open Duration:* ${Math.floor(elapsedMin / 60)}h ${elapsedMin % 60}m\n` +
                                `📊 *Current PnL:* ${pnlPct}%\n` +
                                `💡 _Reminder: If consolidation continues, you can exit manually via "/forcesell ${tradeId}"_\n` +
                                `⏰ *Time:* ${toKarachiTime(new Date())}`;

                    await sendWhatsAppSafe(TARGET_JID, { text: msg });
                }
            }

            // 1. Automated Custom Stop Loss Execution Check
            if (customStopLosses[tradeId]) {
                const sl = customStopLosses[tradeId];
                let shouldStopLoss = false;

                if (sl.targetPrice && currentRate <= sl.targetPrice) {
                    shouldStopLoss = true;
                } else if (sl.targetRatio && pnlRatio <= sl.targetRatio) {
                    shouldStopLoss = true;
                }

                if (shouldStopLoss) {
                    delete customStopLosses[tradeId];
                    saveCustomStopLosses();

                    try {
                        const exitPayload = { tradeid: String(tradeId), ordertype: 'market' };
                        await callFreqtradeApi('/forceexit', 'POST', exitPayload, trade.botKey)
                            .catch(async () => await callFreqtradeApi('/forcesell', 'POST', exitPayload, trade.botKey));

                        const slMsg = `🛡️ *CUSTOM STOP LOSS TRIGGERED!*\n` +
                                      `────────────────────\n` +
                                      `🤖 *Bot:* ${trade.botTag}\n` +
                                      `🪙 *Pair:* ${trade.pair}\n` +
                                      `🆔 *Trade ID:* #${tradeId}\n` +
                                      `📉 *Locked PnL:* *${pnlPct}%*\n` +
                                      `💵 *Exit Price:* $${currentRate}\n` +
                                      `🛡️ *SL Level:* $${sl.targetPrice ? sl.targetPrice : (openRate * (1 + sl.targetRatio)).toFixed(4)}\n` +
                                      `🚨 *Action:* Market stop loss executed instantly!\n` +
                                      `⏰ *Time:* ${toKarachiTime(new Date())}`;

                        await sendWhatsAppSafe(TARGET_JID, { text: slMsg });
                        console.log(`[SL Executed] Trade #${tradeId} (${trade.pair}) stop loss hit at $${currentRate}`);
                    } catch (exitErr) {
                        console.error(`Failed to execute stop loss for trade #${tradeId}:`, exitErr.message);
                    }
                }
            }

            // 2. Automated Custom Take Profit Execution Check
            if (customTakeProfits[tradeId]) {
                const target = customTakeProfits[tradeId];
                let shouldTakeProfit = false;

                if (target.targetPrice && currentRate >= target.targetPrice) {
                    shouldTakeProfit = true;
                } else if (target.targetRatio && pnlRatio >= target.targetRatio) {
                    shouldTakeProfit = true;
                }

                if (shouldTakeProfit) {
                    delete customTakeProfits[tradeId];
                    saveCustomTakeProfits();

                    try {
                        const exitPayload = { tradeid: String(tradeId), ordertype: 'market' };
                        await callFreqtradeApi('/forceexit', 'POST', exitPayload, trade.botKey)
                            .catch(async () => await callFreqtradeApi('/forcesell', 'POST', exitPayload, trade.botKey));

                        const tpMsg = `🎯 *CUSTOM TAKE PROFIT TRIGGERED!*\n` +
                                      `────────────────────\n` +
                                      `🤖 *Bot:* ${trade.botTag}\n` +
                                      `🪙 *Pair:* ${trade.pair}\n` +
                                      `🆔 *Trade ID:* #${tradeId}\n` +
                                      `💰 *Locked Profit:* *+${pnlPct}%*\n` +
                                      `💵 *Exit Price:* $${currentRate}\n` +
                                      `🎯 *Target Price:* $${target.targetPrice ? target.targetPrice : (openRate * (1 + target.targetRatio)).toFixed(4)}\n` +
                                      `🚀 *Action:* Market take profit executed instantly!\n` +
                                      `⏰ *Time:* ${toKarachiTime(new Date())}`;

                        await sendWhatsAppSafe(TARGET_JID, { text: tpMsg });
                        console.log(`[TP Executed] Trade #${tradeId} (${trade.pair}) take profit hit at $${currentRate}`);
                    } catch (exitErr) {
                        console.error(`Failed to execute take profit exit for trade #${tradeId}:`, exitErr.message);
                    }
                }
            }
        }
    } catch (err) {
        // Ignore background polling errors
    }
}

// Format command responses for WhatsApp
async function handleWhatsAppCommand(commandText, senderJid) {
    const cmd = commandText.trim().toLowerCase();
    console.log(`Received command: "${cmd}" from ${senderJid}`);

    try {
        if (cmd === '/help' || cmd === 'help' || cmd === '/menu') {
            return `🤖 *TRI-BOT COMMAND CENTER (3-BOT PORTFOLIO)*\n` +
                   `────────────────────\n` +
                   `📊 */status* - Active open trades across all 3 bots\n` +
                   `   • */status 1* (Sweep 7) | */status 2* (Ignition) | */status 3* (Donchian)\n` +
                   `📜 */trades [limit]* - Past executed opportunities\n` +
                   `   • */trades 1*, */trades 2* or */trades 3* to filter by bot\n` +
                   `💰 */profit* - Cumulative profit summary across all 3 bots\n` +
                   `   • */profit 1* | */profit 2* | */profit 3* for single bot breakdown\n` +
                   `⚖️ */balance* - Shared Binance wallet balance & PKR equity\n` +
                   `🎯 */opportunities* - Live sweep radar across whitelist pairs\n` +
                   `🔔 */alert [pair] [price]* - Set custom WhatsApp price alert\n` +
                   `📋 */alerts* - View all active custom price alerts\n` +
                   `🗑️ */clearalerts* - Clear active custom price alerts\n` +
                   `ℹ️ */info* - Live prices, support/resistance & 24h vol\n` +
                   `🌐 */market* - BTC trend, 24h change & Fear & Greed index\n` +
                   `🛡️ */stoploss [1/2/3] [id] [pct/price]* - Update stop loss for a trade\n` +
                   `🎯 */takeprofit [1/2/3] [id] [pct/price]* - Set custom take profit target\n` +
                   `🚨 */forcesell [1/2/3/all] [id]* - Instantly market exit trades\n` +
                   `📈 */performance* - Performance per trading pair\n` +
                   `⏱️ */daily* - Daily profit breakdown\n` +
                   `🌅 */digest* - Generate full morning digest\n` +
                   `🔄 */reload [1/2/3/all]* - Reload bot configs\n` +
                   `⏸️ */stop [1/2/3/all]* - Pause trading (stop buying)\n` +
                   `▶️ */start [1/2/3/all]* - Resume trading\n` +
                   `ℹ️ */version* - Strategy, bot & preemption status\n` +
                   `────────────────────\n` +
                   `_Tip: Automated Preemption ensures Donchian & Trend get top priority!_`;
        }


        if (cmd.startsWith('/status') || cmd.startsWith('status')) {
            const parts = commandText.trim().split(/\s+/);
            const targetArg = parts[1]?.toLowerCase();

            let botsToQuery = [FT_BOTS.bot1, FT_BOTS.bot2, FT_BOTS.bot3];
            if (targetArg === '1' || targetArg === 'sweep') botsToQuery = [FT_BOTS.bot1];
            if (targetArg === '2' || targetArg === 'ignition') botsToQuery = [FT_BOTS.bot2];
            if (targetArg === '3' || targetArg === 'donchian') botsToQuery = [FT_BOTS.bot3];

            const results = await Promise.all(
                botsToQuery.map(async (b) => {
                    try {
                        const data = await callFreqtradeApi('/status', 'GET', null, b);
                        return { bot: b, trades: Array.isArray(data) ? data : [], error: null };
                    } catch (err) {
                        return { bot: b, trades: [], error: err.message };
                    }
                })
            );

            const allTradesCount = results.reduce((acc, r) => acc + r.trades.length, 0);
            const hasErrors = results.some(r => r.error !== null);

            if (allTradesCount === 0) {
                let msg = `📊 *PORTFOLIO STATUS (3 BOTS)*\n────────────────────\n`;
                if (hasErrors) {
                    msg += `⚠️ *Some bots could not be reached:*\n`;
                    results.forEach(({ bot, error }) => {
                        if (error) {
                            msg += `🤖 *${bot.tag}*: ❌ Error: ${error}\n`;
                        } else {
                            msg += `🤖 *${bot.tag}*: 🟢 Connected (0 active trades)\n`;
                        }
                    });
                    msg += `\n_Check if bots are running or verify passwords in configs._`;
                } else {
                    msg += `🟢 No active open trades right now.\n` +
                           `All 3 bots are scanning for high-probability setups! 🔍\n\n` +
                           `• ⚡ Sweep Elite 7 (Port ${FT_BOTS.bot1.port}): Scanning 5m\n` +
                           `• 🚀 Trend Ignition (Port ${FT_BOTS.bot2.port}): Scanning 15m\n` +
                           `• 💎 Donchian Pro (Port ${FT_BOTS.bot3.port}): Scanning 1h`;
                }
                return msg.trim();
            }

            let msg = `📊 *ACTIVE OPEN TRADES (${allTradesCount})*\n────────────────────\n`;

            results.forEach(({ bot, trades, error }) => {
                if (error) {
                    msg += `🤖 *${bot.tag}*: ⚠️ ${error}\n\n`;
                    return;
                }
                if (!trades.length) return;

                msg += `🤖 *${bot.tag}* (${trades.length} active):\n`;
                trades.forEach((trade, i) => {
                    const ratio = trade.profit_pct !== undefined ? trade.profit_pct : ((trade.profit_ratio || 0) * 100);
                    const profitPct = Number(ratio).toFixed(2);
                    const emoji = Number(ratio) >= 0 ? '🟢' : '🔴';
                    const sign = Number(ratio) >= 0 ? '+' : '';

                    // Profit absolute in USDT
                    const pnlUsdt = trade.total_profit_abs !== undefined ? Number(trade.total_profit_abs).toFixed(2) : (trade.profit_abs !== undefined ? Number(trade.profit_abs).toFixed(2) : null);
                    const pnlUsdtStr = pnlUsdt !== null ? ` (${sign}${pnlUsdt} USDT)` : '';

                    const rawDate = trade.open_date || trade.open_date_hum;
                    const openTime = toKarachiTime(rawDate);

                    // Compute elapsed duration
                    let durStr = '';
                    if (trade.open_timestamp) {
                        const elapsedMin = Math.round((Date.now() - trade.open_timestamp) / 60000);
                        durStr = elapsedMin < 60 ? `${elapsedMin}m` : `${Math.floor(elapsedMin / 60)}h ${elapsedMin % 60}m`;
                    }

                    const openRate = parseFloat(trade.open_rate);
                    const currentRate = parseFloat(trade.current_rate || trade.open_rate);
                    const stakeVal = trade.stake_amount ? parseFloat(trade.stake_amount).toFixed(2) : (trade.amount ? (trade.amount * openRate).toFixed(2) : 'N/A');

                    // Strategy-specific Stop Loss and Take Profit
                    let defaultSlRatio = 0.985;
                    let defaultSlPct = '-1.5%';
                    let defaultTpRatio = 1.022;
                    let defaultTpPct = '+2.2%';

                    if (bot.id === 2) {
                        defaultSlRatio = 0.972;
                        defaultSlPct = '-2.8%';
                        defaultTpRatio = 1.035;
                        defaultTpPct = '+3.5%';
                    } else if (bot.id === 3) {
                        defaultSlRatio = 0.965;
                        defaultSlPct = '-3.5%';
                        defaultTpRatio = 1.048;
                        defaultTpPct = '+4.8%';
                    }

                    const tradeId = String(trade.trade_id);
                    let stopLossPrice = trade.stop_loss_abs ? parseFloat(trade.stop_loss_abs).toFixed(4) : (openRate * defaultSlRatio).toFixed(4);
                    let slDisplayPct = trade.stop_loss_pct !== undefined ? `${trade.stop_loss_pct.toFixed(1)}%` : defaultSlPct;

                    if (customStopLosses[tradeId]) {
                        const csl = customStopLosses[tradeId];
                        stopLossPrice = csl.targetPrice.toFixed(4);
                        slDisplayPct = `${(csl.targetRatio * 100).toFixed(2)}% 🎯 Custom`;
                    }

                    const openTimestamp = trade.open_timestamp || (trade.open_date ? new Date(trade.open_date).getTime() : Date.now());
                    const elapsedMin = Math.max(0, Math.round((Date.now() - openTimestamp) / 60000));
                    const botKey = trade.botKey || `bot${bot.id}`;
                    const activeRoi = getActiveStrategyRoi(botKey, elapsedMin);

                    let takeProfitPrice = (openRate * (1 + activeRoi)).toFixed(4);
                    let tpDisplayPct = `+${(activeRoi * 100).toFixed(1)}% ROI Table`;

                    if (customTakeProfits[tradeId]) {
                        const ctp = customTakeProfits[tradeId];
                        if (ctp.targetPrice) {
                            takeProfitPrice = ctp.targetPrice.toFixed(4);
                            const diffPct = (((ctp.targetPrice - openRate) / openRate) * 100).toFixed(2);
                            tpDisplayPct = `+${diffPct}% 🎯 Custom`;
                        } else if (ctp.targetRatio) {
                            takeProfitPrice = (openRate * (1 + ctp.targetRatio)).toFixed(4);
                            tpDisplayPct = `+${(ctp.targetRatio * 100).toFixed(2)}% 🎯 Custom`;
                        }
                    }

                    msg += `  ${i + 1}. *${trade.pair}* (ID: #${trade.trade_id})\n` +
                           `     📈 PnL: ${emoji} *${sign}${profitPct}%*${pnlUsdtStr}\n` +
                           `     💵 Open: *${openRate}* | Current: *${currentRate}*\n` +
                           `     📦 Position: *${stakeVal} USDT*\n` +
                           `     🛡️ Stop Loss: *${stopLossPrice}* (${slDisplayPct})\n` +
                           `     🎯 Take Profit: *${takeProfitPrice}* (${tpDisplayPct})\n` +
                           `     ⏱️ Opened: ${openTime}${durStr ? ` (${durStr} ago)` : ''}\n` +
                           `     🏷️ Tag: ${trade.enter_tag || 'entry'}\n\n`;
                });
            });

            // If some bots had errors while others had trades, append error summary
            if (hasErrors) {
                results.filter(r => r.error).forEach(({ bot, error }) => {
                    msg += `⚠️ *${bot.tag} Warning:* ${error}\n`;
                });
            }

            return msg.trim();
        }

        if (cmd.startsWith('/trades') || cmd.startsWith('trades') || cmd === '/history' || cmd === 'history') {
            const parts = commandText.trim().split(/\s+/);
            let limit = 5;
            let targetBot = 'all';

            for (let p of parts.slice(1)) {
                if (p === '1' || p === 'sweep') targetBot = 'bot1';
                else if (p === '2' || p === 'ignition') targetBot = 'bot2';
                else if (p === '3' || p === 'donchian') targetBot = 'bot3';
                else if (!isNaN(parseInt(p))) limit = parseInt(p);
            }

            try {
                let trades = [];
                if (targetBot === 'all') {
                    const [t1, t2, t3] = await Promise.all([
                        callFreqtradeApi(`/trades?limit=${limit}`, 'GET', null, 'bot1').catch(() => ({ trades: [] })),
                        callFreqtradeApi(`/trades?limit=${limit}`, 'GET', null, 'bot2').catch(() => ({ trades: [] })),
                        callFreqtradeApi(`/trades?limit=${limit}`, 'GET', null, 'bot3').catch(() => ({ trades: [] }))
                    ]);
                    const list1 = (t1.trades || []).map(t => ({ ...t, botTag: FT_BOTS.bot1.tag }));
                    const list2 = (t2.trades || []).map(t => ({ ...t, botTag: FT_BOTS.bot2.tag }));
                    const list3 = (t3.trades || []).map(t => ({ ...t, botTag: FT_BOTS.bot3.tag }));
                    trades = [...list1, ...list2, ...list3].sort((a, b) => (b.close_timestamp || 0) - (a.close_timestamp || 0)).slice(0, limit);
                } else {
                    const tData = await callFreqtradeApi(`/trades?limit=${limit}`, 'GET', null, targetBot).catch(() => ({ trades: [] }));
                    const bObj = FT_BOTS[targetBot];
                    trades = (tData.trades || []).map(t => ({ ...t, botTag: bObj.tag }));
                }


                if (!trades || trades.length === 0) {
                    return `📜 *EXECUTED OPPORTUNITIES*\n────────────────────\nNo closed trades recorded in history yet.`;
                }

                let msg = `📜 *PAST EXECUTED OPPORTUNITIES (Last ${trades.length})*\n────────────────────\n`;

                trades.forEach((t, i) => {
                    const isProfit = (t.close_profit || 0) >= 0;
                    const emoji = isProfit ? '🟢' : '🔴';
                    const pnlPct = ((t.close_profit || 0) * 100).toFixed(2);
                    const pnlUsdt = (t.close_profit_abs || t.profit_amount || 0).toFixed(2);

                    const buyRate = parseFloat(t.open_rate || 0).toFixed(4);
                    const sellRate = parseFloat(t.close_rate || 0).toFixed(4);
                    const buyTime = toKarachiTime(t.open_date);
                    const sellTime = toKarachiTime(t.close_date);

                    let durStr = 'N/A';
                    if (t.open_timestamp && t.close_timestamp) {
                        const durMin = Math.round((t.close_timestamp - t.open_timestamp) / 60000);
                        durStr = durMin < 60 ? `${durMin}m` : `${Math.floor(durMin / 60)}h ${durMin % 60}m`;
                    }

                    msg += `${i + 1}. *${t.pair}* [${t.botTag || 'BOT'}] ${emoji} *${pnlPct}%* (${pnlUsdt} USDT)\n` +
                           `   📥 *Buy Price:* ${buyRate} (${buyTime})\n` +
                           `   📤 *Sell Price:* ${sellRate} (${sellTime})\n` +
                           `   🏷️ *Strategy Tag:* ${t.enter_tag || 'entry'}\n` +
                           `   🚪 *Exit Reason:* ${t.exit_reason || 'roi'}\n` +
                           `   ⏱️ *Hold Duration:* ${durStr}\n\n`;
                });

                msg += `_Tip: Use "/trades 1" (Sweep) or "/trades 2" (Ignition)_`;
                return msg.trim();
            } catch (err) {
                return `⚠️ Could not fetch trade history: ${err.message}`;
            }
        }

        if (cmd === '/opportunities' || cmd === 'opportunities' || cmd === '/opps' || cmd === 'opps' || cmd === '/signals') {
            try {
                // Query active whitelist and whitelist data
                const [statusData, whitelistData] = await Promise.all([
                    callFreqtradeApi('/status').catch(() => []),
                    callFreqtradeApi('/whitelist').catch(() => null)
                ]);

                let whitelist = ['SOL/USDT', 'WIF/USDT', 'XRP/USDT', 'ETH/USDT', 'TIA/USDT', 'AAVE/USDT'];
                if (Array.isArray(whitelistData)) {
                    whitelist = whitelistData;
                } else if (Array.isArray(whitelistData?.whitelist)) {
                    whitelist = whitelistData.whitelist;
                } else if (Array.isArray(whitelistData?.data)) {
                    whitelist = whitelistData.data;
                }

                const openPairs = new Set(Array.isArray(statusData) ? statusData.map(t => t.pair) : []);

                let msg = `🎯 *STRATEGY OPPORTUNITY RADAR*\n` +
                          `────────────────────\n` +
                          `Strategy: *HighFrequencySweepElite*\n` +
                          `Scan Setup: *18-bar Liquidity Sweeps & Reclaims*\n\n`;

                for (const pair of whitelist) {
                    const symbol = pair.replace('/', '');
                    try {
                        const [klines, ticker] = await Promise.all([
                            fetchHttpsJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=25`),
                            fetchHttpsJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`)
                        ]);

                        if (Array.isArray(klines) && klines.length >= 20) {
                            const last18Lows = klines.slice(-19, -1).map(k => parseFloat(k[3]));
                            const swingLow18 = Math.min(...last18Lows);
                            const currentPrice = parseFloat(ticker.lastPrice);
                            const isTraded = openPairs.has(pair);

                            // Calculate distance from 18-bar sweep trigger
                            const distToSweep = (((currentPrice - swingLow18) / swingLow18) * 100).toFixed(2);
                            const sweepStatus = currentPrice <= swingLow18 
                                ? '🚨 *IN SWEEP ZONE (Trigger Active)*' 
                                : `Approaching (+${distToSweep}% to level)`;

                            const statusTag = isTraded ? '⚡ *TRADED (POSITION OPEN)*' : sweepStatus;

                            msg += `🪙 *${pair}* | Price: *$${currentPrice}*\n` +
                                   `   🛡️ 18-Bar Sweep Level: *$${swingLow18}*\n` +
                                   `   📡 Status: ${statusTag}\n\n`;
                        }
                    } catch (e) {
                        msg += `🪙 *${pair}*: Scanning...\n\n`;
                    }
                }

                msg += `⏰ *Radar Time:* ${toKarachiTime(new Date())}`;
                return msg.trim();
            } catch (err) {
                return `⚠️ Could not scan opportunities: ${err.message}`;
            }
        }

        if (cmd.startsWith('/profit') || cmd.startsWith('profit')) {
            const parts = commandText.trim().split(/\s+/);
            const targetArg = parts[1]?.toLowerCase();

            let botsToQuery = [FT_BOTS.bot1, FT_BOTS.bot2, FT_BOTS.bot3];
            if (targetArg === '1' || targetArg === 'sweep') botsToQuery = [FT_BOTS.bot1];
            if (targetArg === '2' || targetArg === 'ignition') botsToQuery = [FT_BOTS.bot2];
            if (targetArg === '3' || targetArg === 'donchian') botsToQuery = [FT_BOTS.bot3];

            const results = await Promise.all(
                botsToQuery.map(async (b) => {
                    const d = await callFreqtradeApi('/profit', 'GET', null, b).catch(() => null);
                    return { bot: b, data: d };
                })
            );

            if (botsToQuery.length === 1) {
                const { bot, data } = results[0];
                if (!data) return `⚠️ Could not fetch profit data from ${bot.name}.`;
                const totalClosed = data.closed_trade_count !== undefined ? data.closed_trade_count : (data.total_trades || 0);
                const winRate = data.winrate !== undefined ? (data.winrate * 100).toFixed(1) : (((data.winning_trades || 0) / (totalClosed || 1)) * 100).toFixed(1);
                return `💰 *PROFIT SUMMARY (${bot.tag})*\n` +
                       `────────────────────\n` +
                       `💵 *Closed Profit:* ${data.profit_closed_coin?.toFixed(2) || 0} USDT\n` +
                       `📊 *Closed Trades:* ${totalClosed}\n` +
                       `🎯 *Wins / Losses:* ${data.winning_trades || 0} W / ${data.losing_trades || 0} L\n` +
                       `🏆 *Win Rate:* ${winRate}%\n` +
                       `⏱️ *First Trade:* ${data.first_trade_humanized || toKarachiTime(data.first_trade_date)}\n` +
                       `⏱️ *Latest Trade:* ${data.latest_trade_humanized || toKarachiTime(data.latest_trade_date)}`;
            }

            let totClosedProfit = 0;
            let totTrades = 0;
            let totWins = 0;
            let totLosses = 0;
            let breakdownText = '';

            results.forEach(({ bot, data }) => {
                if (data) {
                    const closed = data.profit_closed_coin || 0;
                    const cCount = data.closed_trade_count !== undefined ? data.closed_trade_count : (data.total_trades || 0);
                    const wins = data.winning_trades || 0;
                    const losses = data.losing_trades || 0;
                    const wr = cCount > 0 ? ((wins / cCount) * 100).toFixed(1) : '0.0';

                    totClosedProfit += closed;
                    totTrades += cCount;
                    totWins += wins;
                    totLosses += losses;

                    breakdownText += `🤖 *${bot.tag}*\n` +
                                     `   Profit: *${closed.toFixed(2)} USDT* | Trades: ${cCount} (${wr}% WR: ${wins}W/${losses}L)\n`;
                } else {
                    breakdownText += `🤖 *${bot.tag}*: Offline / Unreachable\n`;
                }
            });

            const overallWR = totTrades > 0 ? ((totWins / totTrades) * 100).toFixed(1) : '0.0';

            return `💰 *CUMULATIVE TRI-BOT PORTFOLIO PROFIT*\n` +
                   `────────────────────\n` +
                   `💵 *Combined Net Profit:* *${totClosedProfit >= 0 ? '+' : ''}${totClosedProfit.toFixed(2)} USDT*\n` +
                   `📊 *Total Closed Trades:* ${totTrades}\n` +
                   `🎯 *Combined Wins / Losses:* ${totWins} W / ${totLosses} L\n` +
                   `🏆 *Combined Win Rate:* *${overallWR}%*\n\n` +
                   `*Individual Bot Breakdown:*\n` +
                   breakdownText +
                   `────────────────────\n` +
                   `_Tip: Query individually with "/profit 1", "/profit 2" or "/profit 3"_`;
        }


        if (cmd === '/balance' || cmd === 'balance') {
            let data = null;
            let activeBotName = '';
            for (const bKey of ['bot1', 'bot2', 'bot3']) {
                try {
                    data = await callFreqtradeApi('/balance', 'GET', null, bKey);
                    if (data && data.currencies) {
                        activeBotName = FT_BOTS[bKey].name;
                        break;
                    }
                } catch (e) {}
            }

            if (!data || !data.currencies) {
                return `⚠️ Could not fetch balance from any active bot. Please verify bot services are running.`;
            }

            let msg = `⚖️ *SHARED ACCOUNT BALANCE*\n────────────────────\n`;
            
            // Find USDT and open coin holdings
            const usdt = data.currencies?.find(c => c.currency === (data.stake || 'USDT'));
            const freeStake = usdt ? usdt.free.toFixed(2) : '0.00';
            const totalStake = data.total ? data.total.toFixed(2) : '0.00';
            const usedInTrades = (data.total - (usdt ? usdt.free : 0)).toFixed(2);
            
            msg += `💵 *Total Equity:* *${totalStake} ${data.stake || 'USDT'}*\n`;
            msg += `🪙 *Available (Free):* *${freeStake} ${data.stake || 'USDT'}*\n`;
            msg += `📦 *In Open Trades:* *${usedInTrades} ${data.stake || 'USDT'}*\n`;
            if (data.value && data.symbol) {
                msg += `🇵🇰 *Total (PKR):* *${Number(data.value).toLocaleString('en-US', {maximumFractionDigits: 0})} ${data.symbol}*\n`;
            }
            msg += `────────────────────\n` +
                   `_Verified via ${activeBotName} (Binance Shared Wallet)_`;
            return msg.trim();
        }

        if (cmd.startsWith('/performance') || cmd.startsWith('performance')) {
            const parts = commandText.trim().split(/\s+/);
            const targetArg = parts[1]?.toLowerCase();

            let botsToQuery = [FT_BOTS.bot1, FT_BOTS.bot2, FT_BOTS.bot3];
            if (targetArg === '1' || targetArg === 'sweep') botsToQuery = [FT_BOTS.bot1];
            if (targetArg === '2' || targetArg === 'ignition') botsToQuery = [FT_BOTS.bot2];
            if (targetArg === '3' || targetArg === 'donchian') botsToQuery = [FT_BOTS.bot3];

            try {
                const results = await Promise.all(
                    botsToQuery.map(async (b) => {
                        const data = await callFreqtradeApi('/performance', 'GET', null, b).catch(() => []);
                        return { bot: b, list: Array.isArray(data) ? data : [] };
                    })
                );

                // Aggregate performance by pair
                const pairMap = {};
                results.forEach(({ list }) => {
                    list.forEach(p => {
                        if (!pairMap[p.pair]) {
                            pairMap[p.pair] = { pair: p.pair, count: 0, profit_abs: 0 };
                        }
                        pairMap[p.pair].count += (p.count || 0);
                        pairMap[p.pair].profit_abs += (p.profit_abs || 0);
                    });
                });

                const pairs = Object.values(pairMap).sort((a, b) => b.profit_abs - a.profit_abs);

                if (pairs.length === 0) {
                    return `📈 *PERFORMANCE*\n────────────────────\nNo closed trades recorded yet on active bots.`;
                }

                let msg = `📈 *PAIR PERFORMANCE SUMMARY*\n────────────────────\n`;
                pairs.forEach((p) => {
                    const profitUSDT = p.profit_abs.toFixed(2);
                    const emoji = p.profit_abs >= 0 ? '🟢' : '🔴';
                    const sign = p.profit_abs >= 0 ? '+' : '';
                    msg += `${emoji} *${p.pair}*: ${p.count} trades | *${sign}${profitUSDT} USDT*\n`;
                });
                return msg.trim();
            } catch (err) {
                return `⚠️ Could not compile performance: ${err.message}`;
            }
        }

        if (cmd.startsWith('/daily') || cmd.startsWith('daily')) {
            const parts = commandText.trim().split(/\s+/);
            let daysLimit = 7;
            let targetBot = 'all';

            for (const p of parts.slice(1)) {
                if (p === '1' || p === 'sweep') targetBot = 'bot1';
                else if (p === '2' || p === 'ignition') targetBot = 'bot2';
                else if (p === '3' || p === 'donchian') targetBot = 'bot3';
                else if (!isNaN(parseInt(p))) daysLimit = Math.min(Math.max(parseInt(p), 1), 30);
            }

            try {
                // Fetch recent closed trades from all 3 bots to accurately compute exact daily PnL
                let tradesPromises = [];
                if (targetBot === 'all') {
                    tradesPromises = [
                        callFreqtradeApi(`/trades?limit=100`, 'GET', null, 'bot1').catch(() => ({ trades: [] })),
                        callFreqtradeApi(`/trades?limit=100`, 'GET', null, 'bot2').catch(() => ({ trades: [] })),
                        callFreqtradeApi(`/trades?limit=100`, 'GET', null, 'bot3').catch(() => ({ trades: [] }))
                    ];
                } else {
                    tradesPromises = [
                        callFreqtradeApi(`/trades?limit=100`, 'GET', null, targetBot).catch(() => ({ trades: [] }))
                    ];
                }

                const results = await Promise.all(tradesPromises);
                let allTrades = [];
                results.forEach(res => {
                    if (Array.isArray(res?.trades)) {
                        allTrades.push(...res.trades);
                    }
                });

                // Group trades by date (Asia/Karachi PKT YYYY-MM-DD)
                const dailyAgg = {};
                allTrades.forEach(t => {
                    const closeTime = t.close_timestamp ? new Date(t.close_timestamp) : (t.close_date ? new Date(t.close_date) : null);
                    if (!closeTime || isNaN(closeTime.getTime())) return;

                    const dateKey = closeTime.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }); // YYYY-MM-DD
                    if (!dailyAgg[dateKey]) {
                        dailyAgg[dateKey] = {
                            date: dateKey,
                            abs_profit: 0,
                            wins: 0,
                            losses: 0,
                            trades: 0
                        };
                    }
                    const profitUsdt = t.close_profit_abs !== undefined ? t.close_profit_abs : (t.profit_amount || 0);
                    dailyAgg[dateKey].abs_profit += profitUsdt;
                    dailyAgg[dateKey].trades += 1;
                    if ((t.close_profit || 0) >= 0) dailyAgg[dateKey].wins += 1;
                    else dailyAgg[dateKey].losses += 1;
                });

                const sortedDates = Object.keys(dailyAgg).sort().reverse().slice(0, daysLimit);

                if (sortedDates.length === 0) {
                    return `⏱️ *DAILY BREAKDOWN*\n────────────────────\nNo closed trades recorded in the selected period.`;
                }

                let totalPeriodProfit = 0;
                let totalPeriodTrades = 0;
                let botHeader = targetBot === 'all' ? 'TRI-BOT PORTFOLIO' : (FT_BOTS[targetBot]?.name || targetBot.toUpperCase());
                let msg = `⏱️ *DAILY PROFIT BREAKDOWN (${botHeader})*\n────────────────────\n`;

                sortedDates.forEach(date => {
                    const row = dailyAgg[date];
                    const emoji = row.abs_profit >= 0 ? '🟢' : '🔴';
                    const sign = row.abs_profit >= 0 ? '+' : '';
                    totalPeriodProfit += row.abs_profit;
                    totalPeriodTrades += row.trades;
                    msg += `${emoji} *${row.date}*: *${sign}${row.abs_profit.toFixed(2)} USDT* | ${row.trades} trades (${row.wins}W / ${row.losses}L)\n`;
                });

                msg += `────────────────────\n` +
                       `💰 *Total (${sortedDates.length} Days):* *${totalPeriodProfit >= 0 ? '+' : ''}${totalPeriodProfit.toFixed(2)} USDT* (${totalPeriodTrades} trades)\n` +
                       `_Tip: Query specific days or bot, e.g. "/daily 3", "/daily 1", "/daily 2", "/daily 3 14"_`;

                return msg.trim();
            } catch (err) {
                return `⚠️ Could not calculate daily breakdown: ${err.message}`;
            }
        }

        if (cmd.startsWith('/stop') || cmd.startsWith('stop')) {
            const parts = commandText.trim().split(/\s+/);
            const targetArg = parts[1]?.toLowerCase();
            if (targetArg === '1' || targetArg === 'sweep') {
                await callFreqtradeApi('/stop', 'POST', null, 'bot1');
                return `⏸️ *[${FT_BOTS.bot1.tag}] Paused*\nNew trade entries paused on Sweep Elite 7.`;
            } else if (targetArg === '2' || targetArg === 'ignition') {
                await callFreqtradeApi('/stop', 'POST', null, 'bot2');
                return `⏸️ *[${FT_BOTS.bot2.tag}] Paused*\nNew trade entries paused on Trend Ignition Elite.`;
            } else if (targetArg === '3' || targetArg === 'donchian') {
                await callFreqtradeApi('/stop', 'POST', null, 'bot3');
                return `⏸️ *[${FT_BOTS.bot3.tag}] Paused*\nNew trade entries paused on Range Breakout Donchian Pro.`;
            } else {
                await Promise.all([
                    callFreqtradeApi('/stop', 'POST', null, 'bot1').catch(() => null),
                    callFreqtradeApi('/stop', 'POST', null, 'bot2').catch(() => null),
                    callFreqtradeApi('/stop', 'POST', null, 'bot3').catch(() => null)
                ]);
                return `⏸️ *All 3 Bots Paused*\nNew trade entries stopped across all 3 bots. Open trades still monitored for exit.`;
            }
        }

        if (cmd.startsWith('/start') || cmd.startsWith('start')) {
            const parts = commandText.trim().split(/\s+/);
            const targetArg = parts[1]?.toLowerCase();
            if (targetArg === '1' || targetArg === 'sweep') {
                await callFreqtradeApi('/start', 'POST', null, 'bot1');
                return `▶️ *[${FT_BOTS.bot1.tag}] Resumed*\nScanning for liquidity sweeps!`;
            } else if (targetArg === '2' || targetArg === 'ignition') {
                await callFreqtradeApi('/start', 'POST', null, 'bot2');
                return `▶️ *[${FT_BOTS.bot2.tag}] Resumed*\nScanning for trend ignition setups!`;
            } else if (targetArg === '3' || targetArg === 'donchian') {
                await callFreqtradeApi('/start', 'POST', null, 'bot3');
                return `▶️ *[${FT_BOTS.bot3.tag}] Resumed*\nScanning for Donchian range breakouts!`;
            } else {
                await Promise.all([
                    callFreqtradeApi('/start', 'POST', null, 'bot1').catch(() => null),
                    callFreqtradeApi('/start', 'POST', null, 'bot2').catch(() => null),
                    callFreqtradeApi('/start', 'POST', null, 'bot3').catch(() => null)
                ]);
                return `▶️ *All 3 Bots Resumed*\nAll 3 strategies scanning pairs for entry signals!`;
            }
        }

        if (cmd === '/info' || cmd === 'info') {
            // Fetch live whitelist from Freqtrade, fallback to full basket
            const whitelistData = await callFreqtradeApi('/whitelist').catch(() => null);
            let pairs = ['SOL/USDT', 'WIF/USDT', 'XRP/USDT', 'ETH/USDT', 'TIA/USDT', 'AAVE/USDT'];
            if (Array.isArray(whitelistData)) {
                pairs = whitelistData;
            } else if (Array.isArray(whitelistData?.whitelist)) {
                pairs = whitelistData.whitelist;
            } else if (Array.isArray(whitelistData?.data)) {
                pairs = whitelistData.data;
            }

            let msg = `ℹ️ *PAIRLIST MARKET METRICS (15m)*\n────────────────────\n`;

            for (const pair of pairs) {
                const symbol = pair.replace('/', '');
                try {
                    // Fetch 15m klines (last 24 candles = 6 hours of structure) and 24hr ticker
                    const [klines, ticker] = await Promise.all([
                        fetchHttpsJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=24`),
                        fetchHttpsJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`)
                    ]);

                    const highs = klines.map(k => parseFloat(k[2]));
                    const lows = klines.map(k => parseFloat(k[3]));
                    const currentPrice = parseFloat(ticker.lastPrice);
                    const priceChange = parseFloat(ticker.priceChangePercent);
                    const quoteVolM = (parseFloat(ticker.quoteVolume) / 1e6).toFixed(1);

                    const support15m = Math.min(...lows);
                    const resistance15m = Math.max(...highs);

                    const changeEmoji = priceChange >= 0 ? '🟢' : '🔴';

                    msg += `🪙 *${pair}* ${changeEmoji} ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%\n` +
                           `   💵 Price: *${currentPrice}*\n` +
                           `   🛡️ 15m Support: *${support15m}*\n` +
                           `   🎯 15m Resist: *${resistance15m}*\n` +
                           `   📊 24h Vol: *${quoteVolM}M USDT*\n\n`;
                } catch (err) {
                    msg += `🪙 *${pair}*: Data temporarily unavailable\n\n`;
                }
            }

            msg += `⏰ *Updated:* ${toKarachiTime(new Date())}`;
            return msg.trim();
        }

        if (cmd === '/market' || cmd === 'market') {
            try {
                const [fng, btcTicker, btcKlines] = await Promise.all([
                    fetchHttpsJson('https://api.alternative.me/fng/?limit=1').catch(() => null),
                    fetchHttpsJson('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
                    fetchHttpsJson('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=24')
                ]);

                const fngVal = fng?.data?.[0]?.value || 'N/A';
                const fngClass = fng?.data?.[0]?.value_classification || 'Neutral';
                const btcPrice = parseFloat(btcTicker.lastPrice).toLocaleString('en-US', {maximumFractionDigits: 2});
                const btcChange = parseFloat(btcTicker.priceChangePercent);
                const btcVolM = (parseFloat(btcTicker.quoteVolume) / 1e6).toFixed(1);

                // Trend estimate
                const btcHigh = Math.max(...btcKlines.map(k => parseFloat(k[2])));
                const btcLow = Math.min(...btcKlines.map(k => parseFloat(k[3])));
                const trend = btcChange >= 1.5 ? '🟢 Bullish Surge' : btcChange <= -1.5 ? '🔴 Bearish Drop' : '🟡 Neutral / Consolidating';

                return `🌐 *MACRO MARKET SENTIMENT*\n` +
                       `────────────────────\n` +
                       `🪙 *Bitcoin (BTC):* $${btcPrice} (${btcChange >= 0 ? '+' : ''}${btcChange.toFixed(2)}%)\n` +
                       `📊 *Market Regime:* ${trend}\n` +
                       `🛡️ *24h BTC Range:* $${btcLow.toLocaleString('en-US', {maximumFractionDigits: 0})} - $${btcHigh.toLocaleString('en-US', {maximumFractionDigits: 0})}\n` +
                       `💸 *24h BTC Volume:* $${btcVolM}M USDT\n` +
                       `🎭 *Fear & Greed Index:* *${fngVal}* (${fngClass})\n` +
                       `⏰ *Updated:* ${toKarachiTime(new Date())}`;
            } catch (err) {
                return `⚠️ Could not fetch market sentiment: ${err.message}`;
            }
        }

        if (cmd.startsWith('/forcesell') || cmd.startsWith('forcesell')) {
            const parts = cmd.split(/\s+/);
            const targetArg = parts[1] || 'all';
            const specificTradeId = parts[2];

            try {
                if (targetArg === 'all') {
                    let results = [];
                    for (const b of [FT_BOTS.bot1, FT_BOTS.bot2, FT_BOTS.bot3]) {
                        const openTrades = await callFreqtradeApi('/status', 'GET', null, b).catch(() => []);
                        if (Array.isArray(openTrades)) {
                            for (const trade of openTrades) {
                                await callFreqtradeApi('/forcesell', 'POST', { tradeid: String(trade.trade_id) }, b);
                                results.push(`🚨 [${b.tag}] Force-sold trade #${trade.trade_id} (${trade.pair})`);
                            }
                        }
                    }
                    if (results.length === 0) return `⚠️ No active open trades to sell on any bot.`;
                    return results.join('\n');
                } else if (targetArg === '1' || targetArg === '2' || targetArg === '3' || targetArg === 'donchian') {
                    const b = targetArg === '1' ? FT_BOTS.bot1 : (targetArg === '2' ? FT_BOTS.bot2 : FT_BOTS.bot3);
                    if (specificTradeId) {
                        await callFreqtradeApi('/forcesell', 'POST', { tradeid: String(specificTradeId) }, b);
                        return `🚨 [${b.tag}] Force exit sent for trade #${specificTradeId} at market price!`;
                    } else {
                        const openTrades = await callFreqtradeApi('/status', 'GET', null, b).catch(() => []);
                        if (!Array.isArray(openTrades) || openTrades.length === 0) return `⚠️ No active open trades on ${b.name}.`;
                        let results = [];
                        for (const trade of openTrades) {
                            await callFreqtradeApi('/forcesell', 'POST', { tradeid: String(trade.trade_id) }, b);
                            results.push(`🚨 [${b.tag}] Force-sold trade #${trade.trade_id} (${trade.pair})`);
                        }
                        return results.join('\n');
                    }
                } else {
                    const tradeId = targetArg;
                    let found = false;
                    for (const b of [FT_BOTS.bot1, FT_BOTS.bot2, FT_BOTS.bot3]) {
                        const openTrades = await callFreqtradeApi('/status', 'GET', null, b).catch(() => []);
                        if (Array.isArray(openTrades) && openTrades.some(t => String(t.trade_id) === String(tradeId))) {

                            await callFreqtradeApi('/forcesell', 'POST', { tradeid: String(tradeId) }, b);
                            found = true;
                            return `🚨 [${b.tag}] Force exit sent for trade #${tradeId} at market price!`;
                        }
                    }
                    if (!found) {
                        // Fallback attempt on bot1
                        await callFreqtradeApi('/forcesell', 'POST', { tradeid: String(tradeId) }, 'bot1');
                        return `🚨 Force exit order sent for trade #${tradeId} at market price!`;
                    }
                }
            } catch (err) {
                return `⚠️ Failed to execute force sell: ${err.message}`;
            }
        }

        if (cmd.startsWith('/stoploss') || cmd.startsWith('stoploss') || cmd.startsWith('/sl ') || cmd.startsWith('sl ')) {
            const parts = commandText.trim().split(/\s+/);
            if (parts.length < 3) {
                return `🛡️ *SET CUSTOM STOP LOSS*\n────────────────────\n` +
                       `⚠️ *Usage:* /stoploss [trade_id] [stoploss_value]\n\n` +
                       `*Examples:*\n` +
                       `• \`/sl 1 -1.5%\` (Set -1.5% stop loss)\n` +
                       `• \`/sl 1 -0.015\` (Set -1.5% stop loss)\n` +
                       `• \`/sl 1 134.50\` (Set absolute stop loss price $134.50)\n` +
                       `• \`/sl 1 clear\` (Revert to strategy default stop loss)\n\n` +
                       `_Check active trade IDs with "/status"_`;
            }

            const tradeId = parts[1].replace('#', '').trim();
            const actionArg = parts[2].trim().toLowerCase();

            try {
                // Check if tradeId is valid in open trades across all 3 bots
                const [open1, open2, open3] = await Promise.all([
                    callFreqtradeApi('/status', 'GET', null, 'bot1').catch(() => []),
                    callFreqtradeApi('/status', 'GET', null, 'bot2').catch(() => []),
                    callFreqtradeApi('/status', 'GET', null, 'bot3').catch(() => [])
                ]);

                const tagged1 = (Array.isArray(open1) ? open1 : []).map(t => ({ ...t, botKey: 'bot1', botTag: FT_BOTS.bot1.tag }));
                const tagged2 = (Array.isArray(open2) ? open2 : []).map(t => ({ ...t, botKey: 'bot2', botTag: FT_BOTS.bot2.tag }));
                const tagged3 = (Array.isArray(open3) ? open3 : []).map(t => ({ ...t, botKey: 'bot3', botTag: FT_BOTS.bot3.tag }));
                const allOpenTrades = [...tagged1, ...tagged2, ...tagged3];

                let targetTrade = allOpenTrades.find(t => 
                    String(t.trade_id) === String(tradeId) || 
                    t.pair.toLowerCase().replace('/', '') === tradeId.toLowerCase().replace('/', '') ||
                    t.pair.toLowerCase().startsWith(tradeId.toLowerCase())
                );

                if (!targetTrade) {
                    const activeList = allOpenTrades.map(t => `#${t.trade_id} (${t.pair})`).join(', ');
                    return `⚠️ Active trade "${tradeId}" not found. Active open trades: ${activeList || 'None'}.\n_Tip: Check "/status" to see active Trade IDs._`;
                }
                const actualTradeId = String(targetTrade.trade_id);

                if (actionArg === 'clear' || actionArg === 'reset') {
                    delete customStopLosses[actualTradeId];
                    saveCustomStopLosses();
                    return `🛡️ Cleared custom stop loss for trade #${actualTradeId}. Reverted to strategy defaults.`;
                }

                let rawValue = parts[2].trim().replace('-', '').replace('%', '');
                let stoplossValue = parseFloat(rawValue);

                if (isNaN(stoplossValue) || stoplossValue <= 0) {
                    return `⚠️ Invalid stop loss value: "${parts[2]}". Please provide a percentage (e.g. -1.5%) or an absolute price.`;
                }

                const openRate = parseFloat(targetTrade.open_rate);

                // Determine if input is absolute price or relative percentage
                if (stoplossValue >= openRate * 0.5) {
                    // Absolute price level
                    if (stoplossValue >= openRate) {
                        return `⚠️ Stop loss price ($${stoplossValue}) must be LOWER than entry price ($${openRate}) for long positions!`;
                    }
                    const ratio = (stoplossValue - openRate) / openRate;
                    customStopLosses[actualTradeId] = {
                        pair: targetTrade.pair,
                        targetPrice: stoplossValue,
                        targetRatio: ratio,
                        openRate: openRate,
                        botKey: targetTrade.botKey,
                        setAt: toKarachiTime(new Date())
                    };
                } else if (stoplossValue <= 0.30) {
                    // Ratio mode e.g. 0.015 (-1.5%)
                    customStopLosses[actualTradeId] = {
                        pair: targetTrade.pair,
                        targetRatio: -stoplossValue,
                        targetPrice: openRate * (1 - stoplossValue),
                        openRate: openRate,
                        botKey: targetTrade.botKey,
                        setAt: toKarachiTime(new Date())
                    };
                } else {
                    // Whole percentage mode e.g. 1.5 or 2 meaning -1.5%
                    const ratio = -(stoplossValue / 100);
                    customStopLosses[actualTradeId] = {
                        pair: targetTrade.pair,
                        targetRatio: ratio,
                        targetPrice: openRate * (1 + ratio),
                        openRate: openRate,
                        botKey: targetTrade.botKey,
                        setAt: toKarachiTime(new Date())
                    };
                }

                saveCustomStopLosses();

                const csl = customStopLosses[actualTradeId];
                const newPct = (Math.abs(csl.targetRatio) * 100).toFixed(2);
                const estimatedPrice = csl.targetPrice.toFixed(4);

                return `🛡️ *CUSTOM STOP LOSS ACTIVE*\n────────────────────\n` +
                       `🪙 *Pair:* ${targetTrade.pair}\n` +
                       `🆔 *Trade ID:* #${actualTradeId}\n` +
                       `🤖 *Bot:* ${targetTrade.botTag}\n` +
                       `🛡️ *Trigger Level:* *$${estimatedPrice} (-${newPct}%)*\n` +
                       `💵 *Open Rate:* $${openRate}\n` +
                       `⏰ *Activated:* ${toKarachiTime(new Date())}\n\n` +
                       `_Active Bridge Sentinel: When price touches this level, a Market Force Exit will execute immediately!_`;
            } catch (err) {
                return `⚠️ Failed to update stop loss for trade #${actualTradeId}: ${err.message}`;
            }
        }

        if (cmd.startsWith('/takeprofit') || cmd.startsWith('takeprofit') || cmd.startsWith('/tp ') || cmd.startsWith('tp ')) {
            const parts = commandText.trim().split(/\s+/);
            if (parts.length < 3) {
                return `🎯 *SET CUSTOM TAKE PROFIT*\n────────────────────\n` +
                       `⚠️ *Usage:* /takeprofit [trade_id] [profit_pct/price]\n\n` +
                       `*Examples:*\n` +
                       `• \`/tp 1 0.025\` (Take profit at +2.5%)\n` +
                       `• \`/tp 1 +2.0%\` (Take profit at +2.0%)\n` +
                       `• \`/tp 1 138.50\` (Take profit at exact price $138.50)\n` +
                       `• \`/tp 1 clear\` (Remove custom target and use strategy default)\n\n` +
                       `_Check active trade IDs with "/status"_`;
            }

            const tradeId = parts[1].replace('#', '').trim();
            const actionArg = parts[2].trim().toLowerCase();

            try {
                // Check if tradeId is valid in open trades across all 3 bots
                const [open1, open2, open3] = await Promise.all([
                    callFreqtradeApi('/status', 'GET', null, 'bot1').catch(() => []),
                    callFreqtradeApi('/status', 'GET', null, 'bot2').catch(() => []),
                    callFreqtradeApi('/status', 'GET', null, 'bot3').catch(() => [])
                ]);

                const tagged1 = (Array.isArray(open1) ? open1 : []).map(t => ({ ...t, botKey: 'bot1', botTag: FT_BOTS.bot1.tag }));
                const tagged2 = (Array.isArray(open2) ? open2 : []).map(t => ({ ...t, botKey: 'bot2', botTag: FT_BOTS.bot2.tag }));
                const tagged3 = (Array.isArray(open3) ? open3 : []).map(t => ({ ...t, botKey: 'bot3', botTag: FT_BOTS.bot3.tag }));
                const allOpenTrades = [...tagged1, ...tagged2, ...tagged3];

                let targetTrade = allOpenTrades.find(t => 
                    String(t.trade_id) === String(tradeId) || 
                    t.pair.toLowerCase().replace('/', '') === tradeId.toLowerCase().replace('/', '') ||
                    t.pair.toLowerCase().startsWith(tradeId.toLowerCase())
                );

                // If user passed only [price] when 1 trade is active (e.g. "/tp 0.4140")
                if (!targetTrade && allOpenTrades.length === 1 && (!isNaN(parseFloat(tradeId)) && isNaN(parseFloat(actionArg)))) {
                    // tradeId is actually the price, actionArg might be missing or different
                } else if (!targetTrade && allOpenTrades.length === 1 && isNaN(parseFloat(tradeId)) && !actionArg) {
                    targetTrade = allOpenTrades[0];
                }

                if (!targetTrade) {
                    const activeList = allOpenTrades.map(t => `#${t.trade_id} (${t.pair})`).join(', ');
                    return `⚠️ Active trade "${tradeId}" not found. Active open trades: ${activeList || 'None'}.\n_Tip: Check "/status" to see active Trade IDs._`;
                }
                const actualTradeId = String(targetTrade.trade_id);

                if (actionArg === 'clear' || actionArg === 'reset') {
                    delete customTakeProfits[actualTradeId];
                    saveCustomTakeProfits();
                    return `🎯 Cleared custom take profit for trade #${actualTradeId}. Reverted to strategy defaults.`;
                }

                let rawValue = parts[2].trim().replace('+', '').replace('%', '');
                let tpValue = parseFloat(rawValue);

                if (isNaN(tpValue) || tpValue <= 0) {
                    return `⚠️ Invalid take profit target: "${parts[2]}". Please provide a positive value (e.g. 2.0% or exact price).`;
                }

                const openRate = parseFloat(targetTrade.open_rate);

                // Determine if input is a ratio, a percentage, or an absolute price
                if (tpValue >= openRate * 0.5) {
                    // Absolute target price mode (e.g. 138.50)
                    if (tpValue <= openRate) {
                        return `⚠️ Target price ($${tpValue}) must be higher than entry price ($${openRate}) for long positions.`;
                    }
                    customTakeProfits[actualTradeId] = {
                        pair: targetTrade.pair,
                        targetPrice: tpValue,
                        openRate: openRate,
                        botKey: targetTrade.botKey,
                        setAt: toKarachiTime(new Date())
                    };
                } else if (tpValue < 1.0) {
                    // Decimal ratio mode e.g. 0.025 (+2.5%)
                    customTakeProfits[actualTradeId] = {
                        pair: targetTrade.pair,
                        targetRatio: tpValue,
                        openRate: openRate,
                        botKey: targetTrade.botKey,
                        setAt: toKarachiTime(new Date())
                    };
                } else {
                    // Whole percentage mode e.g. 2.5 meaning +2.5%
                    customTakeProfits[actualTradeId] = {
                        pair: targetTrade.pair,
                        targetRatio: tpValue / 100,
                        openRate: openRate,
                        botKey: targetTrade.botKey,
                        setAt: toKarachiTime(new Date())
                    };
                }

                saveCustomTakeProfits();

                const ctp = customTakeProfits[actualTradeId];
                let displayPct = '';
                let displayPrice = '';

                if (ctp.targetPrice) {
                    displayPrice = `$${ctp.targetPrice.toFixed(4)}`;
                    displayPct = `+${(((ctp.targetPrice - openRate) / openRate) * 100).toFixed(2)}%`;
                } else {
                    displayPct = `+${(ctp.targetRatio * 100).toFixed(2)}%`;
                    displayPrice = `~$${(openRate * (1 + ctp.targetRatio)).toFixed(4)}`;
                }

                return `🎯 *CUSTOM TAKE PROFIT ARMED*\n────────────────────\n` +
                       `🪙 *Pair:* ${targetTrade.pair}\n` +
                       `🆔 *Trade ID:* #${actualTradeId}\n` +
                       `🎯 *Take Profit Target:* *${displayPct}* (${displayPrice})\n` +
                       `💵 *Open Rate:* $${openRate}\n` +
                       `📍 *Current Rate:* $${targetTrade.current_rate}\n` +
                       `⏰ *Time:* ${toKarachiTime(new Date())}\n\n` +
                       `_The bridge monitor will automatically exit this trade the instant target is touched!_`;
            } catch (err) {
                return `⚠️ Failed to set take profit for trade #${tradeId}: ${err.message}`;
            }
        }

        if (cmd.startsWith('/reload') || cmd.startsWith('reload')) {
            const parts = commandText.trim().split(/\s+/);
            const targetArg = parts[1]?.toLowerCase();
            try {
                if (targetArg === '1' || targetArg === 'sweep') {
                    await callFreqtradeApi('/reload_config', 'POST', null, 'bot1');
                    return `🔄 *[${FT_BOTS.bot1.tag}] Config & Pairlist Reloaded Successfully!*`;
                } else if (targetArg === '2' || targetArg === 'ignition') {
                    await callFreqtradeApi('/reload_config', 'POST', null, 'bot2');
                    return `🔄 *[${FT_BOTS.bot2.tag}] Config & Pairlist Reloaded Successfully!*`;
                } else if (targetArg === '3' || targetArg === 'donchian') {
                    await callFreqtradeApi('/reload_config', 'POST', null, 'bot3');
                    return `🔄 *[${FT_BOTS.bot3.tag}] Config & Pairlist Reloaded Successfully!*`;
                } else {
                    await Promise.all([
                        callFreqtradeApi('/reload_config', 'POST', null, 'bot1').catch(() => null),
                        callFreqtradeApi('/reload_config', 'POST', null, 'bot2').catch(() => null),
                        callFreqtradeApi('/reload_config', 'POST', null, 'bot3').catch(() => null)
                    ]);
                    return `🔄 *All 3 Bot Configs Reloaded Successfully!*\nBots updated without restarting.`;
                }

            } catch (err) {
                return `⚠️ Failed to reload config: ${err.message}`;
            }
        }

        if (cmd === '/digest' || cmd === 'digest') {
            return await generateDailyDigest();
        }



        // Custom Price Alert Setting: e.g. /alert BTC 85000 or /alert SOL 135.5
        if (cmd.startsWith('/alert ') || cmd.startsWith('alert ')) {
            const parts = commandText.trim().split(/\s+/);
            if (parts.length < 3) {
                return `⚠️ *Usage:* /alert [pair] [price]\n_Example:_ /alert SOL 135.50 or /alert BTC 85000`;
            }

            let rawPair = parts[1].toUpperCase().trim();
            if (!rawPair.includes('/')) {
                rawPair = `${rawPair}/USDT`;
            }
            const symbol = rawPair.replace('/', '');
            const targetPrice = parseFloat(parts[2]);

            if (isNaN(targetPrice) || targetPrice <= 0) {
                return `⚠️ Invalid price: "${parts[2]}". Please provide a valid positive number.`;
            }

            try {
                // Fetch current price to automatically determine alert direction
                const ticker = await fetchHttpsJson(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
                const currentPrice = parseFloat(ticker.price);

                if (!currentPrice) {
                    return `⚠️ Could not find market price for pair: *${rawPair}*.`;
                }

                const direction = targetPrice >= currentPrice ? 'above' : 'below';
                const dirEmoji = direction === 'above' ? '📈 Crossing Above' : '📉 Dropping Below';

                const newAlert = {
                    id: Date.now().toString(36),
                    pair: rawPair,
                    symbol: symbol,
                    targetPrice: targetPrice,
                    direction: direction,
                    createdPrice: currentPrice,
                    createdAt: toKarachiTime(new Date())
                };

                customAlerts.push(newAlert);
                saveCustomAlerts();

                return `🔔 *CUSTOM PRICE ALERT SET*\n` +
                       `────────────────────\n` +
                       `🪙 *Pair:* ${rawPair}\n` +
                       `🎯 *Target Price:* $${targetPrice}\n` +
                       `💵 *Current Price:* $${currentPrice}\n` +
                       `📡 *Condition:* Trigger when ${dirEmoji}\n` +
                       `🆔 *Alert ID:* ${newAlert.id}\n` +
                       `⏰ *Created:* ${newAlert.createdAt}\n\n` +
                       `_You will receive an instant WhatsApp alert when touched!_`;
            } catch (err) {
                return `⚠️ Failed to create alert: ${err.message}`;
            }
        }

        // List active alerts: /alerts
        if (cmd === '/alerts' || cmd === 'alerts') {
            if (!customAlerts.length) {
                return `🔔 *ACTIVE PRICE ALERTS*\n────────────────────\nNo active price alerts set.\n_Create one with: "/alert [pair] [price]"_`;
            }

            let msg = `🔔 *ACTIVE PRICE ALERTS (${customAlerts.length})*\n────────────────────\n`;
            customAlerts.forEach((a, i) => {
                const dirEmoji = a.direction === 'above' ? '📈 >=' : '📉 <=';
                msg += `${i + 1}. *${a.pair}* | ${dirEmoji} *$${a.targetPrice}*\n` +
                       `   🆔 ID: ${a.id} | Set at: ${a.createdAt}\n\n`;
            });

            msg += `_To cancel all: "/clearalerts"_`;
            return msg.trim();
        }

        // Clear alerts: /clearalerts or /delalert [id]
        if (cmd === '/clearalerts' || cmd === 'clearalerts' || cmd.startsWith('/delalert ') || cmd.startsWith('delalert ')) {
            const parts = commandText.trim().split(/\s+/);
            if (parts.length >= 2) {
                const idToDelete = parts[1].trim();
                const initialLen = customAlerts.length;
                customAlerts = customAlerts.filter(a => a.id !== idToDelete);
                saveCustomAlerts();

                if (customAlerts.length < initialLen) {
                    return `🗑️ Alert *${idToDelete}* removed successfully!`;
                } else {
                    return `⚠️ Alert ID *${idToDelete}* not found. Check active IDs with "/alerts".`;
                }
            } else {
                const count = customAlerts.length;
                customAlerts = [];
                saveCustomAlerts();
                return `🗑️ Cleared all ${count} active price alerts!`;
            }
        }

        if (cmd === '/version' || cmd === 'version') {
            const [v1, v2, v3] = await Promise.all([
                callFreqtradeApi('/version', 'GET', null, 'bot1').catch(() => null),
                callFreqtradeApi('/version', 'GET', null, 'bot2').catch(() => null),
                callFreqtradeApi('/version', 'GET', null, 'bot3').catch(() => null)
            ]);

            // Also read coordinator portfolio state if available
            let stateInfo = 'IDLE (No active preemption)';
            try {
                const coordStatePath = path.join(__dirname, '..', 'userdata', 'portfolio_state.json');
                if (fs.existsSync(coordStatePath)) {
                    const st = JSON.parse(fs.readFileSync(coordStatePath, 'utf8'));
                    if (st.status === 'BUSY') {
                        stateInfo = `BUSY (${st.active_strategy || 'Active'} on ${st.active_pair || 'Pair'})`;
                    } else if (st.pending_intent) {
                        stateInfo = `WAITING PREEMPTION (${st.pending_intent.strategy} for ${st.pending_intent.pair})`;
                    }
                }
            } catch (e) {}

            return `ℹ️ *TRI-BOT SYSTEM STATUS*\n────────────────────\n` +
                   `🤖 *Bot 1 (Port ${FT_BOTS.bot1.port}):* ${v1 ? `v${v1.version}` : 'Offline'}\n` +
                   `   Strategy: HighFrequencySweepElite7 (5m Scalp)\n\n` +
                   `🤖 *Bot 2 (Port ${FT_BOTS.bot2.port}):* ${v2 ? `v${v2.version}` : 'Offline'}\n` +
                   `   Strategy: TrendIgnitionElite (15m Runner)\n\n` +
                   `🤖 *Bot 3 (Port ${FT_BOTS.bot3.port}):* ${v3 ? `v${v3.version}` : 'Offline'}\n` +
                   `   Strategy: RangeBreakoutDonchianPro (1h Breakout)\n\n` +
                   `⚡ *Coordinator State:* ${stateInfo}`;
        }


        return null; // unrecognized message, ignore
    } catch (error) {
        console.error('Command handling error:', error.message);
        return `⚠️ *Error contacting Freqtrade:* ${error.message}\n_Make sure Freqtrade is running on port ${FT_API_PORT}_`;
    }
}

async function startWhatsApp() {
    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: false }));

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n======================================================');
            console.log('SCAN THIS QR CODE IN WHATSAPP (Settings > Linked Devices):');
            console.log('======================================================\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('WhatsApp connection closed, reconnecting:', shouldReconnect);
            isConnected = false;
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully with Two-Way Commands!');
            isConnected = true;
            if (TARGET_JID) {
                console.log(`Registered owner number: ${TARGET_JID}`);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen for incoming messages from WhatsApp to process interactive commands
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const sender = msg.key.remoteJid;
            const text = msg.message.conversation ||
                         msg.message.extendedTextMessage?.text || '';

            // Clean TARGET_JID (strip comments and whitespace)
            const cleanTarget = TARGET_JID ? TARGET_JID.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) : '';

            // If target_number is configured with a phone number, check if sender matches
            if (cleanTarget) {
                const targetDigits = cleanTarget.replace(/[^0-9]/g, '');
                // Allow matching by phone number or by direct JID/LID
                const isMatch = sender.includes(targetDigits) || 
                                sender === cleanTarget || 
                                sender.endsWith('@lid') || 
                                msg.key.participant?.includes(targetDigits);

                if (!isMatch) {
                    console.log(`Ignored message from unauthorized sender: ${sender}`);
                    return;
                }
            }

            // If TARGET_JID was not set or was empty, auto-bind to the first sender
            if (!cleanTarget || cleanTarget === '') {
                TARGET_JID = sender;
                fs.writeFileSync(TARGET_FILE, sender);
                console.log(`Auto-registered owner JID as: ${TARGET_JID}`);
            }
            if (!TARGET_JID) {
                TARGET_JID = sender;
                fs.writeFileSync(TARGET_FILE, sender);
                console.log(`Auto-saved recipient number as: ${TARGET_JID}`);
            }

            const reply = await handleWhatsAppCommand(text, sender);
            if (reply) {
                if (typeof reply === 'object' && reply.type === 'image') {
                    await sock.sendMessage(sender, {
                        image: reply.image,
                        caption: reply.caption
                    });
                } else {
                    await sock.sendMessage(sender, { text: String(reply) });
                }
            }
        } catch (e) {
            console.error('Error processing incoming message:', e);
        }
    });
}

// Webhook endpoint to receive alerts from Freqtrade
app.post('/trade-alert', async (req, res) => {
    try {
        const data = req.body;
        console.log('Received Freqtrade Alert:', JSON.stringify(data));

        if (!sock || !isConnected) {
            return res.status(503).json({ error: 'WhatsApp not connected yet. Please scan QR.' });
        }

        let destination = req.query.to || TARGET_JID;
        if (!destination) {
            return res.status(400).json({ error: 'No recipient specified. Send a message to the bot first.' });
        }

        destination = destination.trim();
        if (!destination.includes('@')) {
            destination = `${destination.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        } else {
            destination = jidNormalizedUser(destination);
        }

        let messageText = '';
        const type = data.type || 'TRADE_NOTIFICATION';
        const botTitle = data.bot_label || '🤖 FREQTRADE';

        if (type === 'entry' || data.event_type === 'entry') {
            const entryRate = parseFloat(data.open_rate || data.rate || 0);
            const isIgnition = (data.bot_label && data.bot_label.includes('IGNITION')) || (data.enter_tag && data.enter_tag.includes('ignition'));
            const slRatio = isIgnition ? 0.978 : 0.985;
            const slPct = isIgnition ? '-2.2%' : '-1.5%';
            const sl = entryRate ? (entryRate * slRatio).toFixed(4) : 'N/A';

            messageText = `🟢 *${botTitle} BUY ORDER*\n` +
                          `────────────────────\n` +
                          `🪙 *Pair:* ${data.pair || 'N/A'}\n` +
                          `💵 *Entry Rate:* *${data.open_rate || data.rate || 'N/A'}*\n` +
                          `🛡️ *Stop Loss:* *${sl}* (${slPct})\n` +
                          `📦 *Stake:* ${data.stake_amount || 'N/A'} ${data.stake_currency || 'USDT'}\n` +
                          `🏷️ *Tag:* ${data.enter_tag || 'trade_entry'}\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        } else if (type === 'exit' || data.event_type === 'exit') {
            const isProfit = (data.profit_percent || data.profit_ratio || 0) >= 0;
            const emoji = isProfit ? '🎯' : '⚠️';
            messageText = `${emoji} *${botTitle} SELL ORDER*\n` +
                          `────────────────────\n` +
                          `🪙 *Pair:* ${data.pair || 'N/A'}\n` +
                          `💰 *PnL:* ${data.profit_percent || ((data.profit_ratio || 0) * 100).toFixed(2)}%\n` +
                          `💵 *Profit Amount:* ${data.profit_amount || '0'} USDT\n` +
                          `🚪 *Exit Reason:* ${data.exit_reason || 'roi'}\n` +
                          `⏰ *Duration:* ${data.duration || 'N/A'}\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        } else {
            messageText = `🤖 *${botTitle} ALERT*\n` +
                          `────────────────────\n` +
                          `${data.message || JSON.stringify(data, null, 2)}`;
        }

        const sent = await sendWhatsAppSafe(destination, { text: messageText });
        if (sent) {
            console.log(`Alert dispatched to WhatsApp: ${destination}`);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to deliver alert via WhatsApp.' });
        }
    } catch (err) {
        console.error('Error sending WhatsApp message:', err);
        res.status(500).json({ error: err.message });
    }
});

// Webhook endpoint to receive pre-trade setup alerts (sweep mode & trend ignition mode)
app.post('/mode-alert', async (req, res) => {
    try {
        const data = req.body;
        console.log('Received Strategy Mode Alert:', JSON.stringify(data));

        if (!sock || !isConnected) {
            return res.status(503).json({ error: 'WhatsApp not connected yet. Please scan QR.' });
        }

        let destination = req.query.to || TARGET_JID;
        if (!destination) {
            return res.status(400).json({ error: 'No recipient specified.' });
        }

        const modeType = data.mode || data.type || 'SWEEP'; // 'SWEEP' or 'IGNITION'
        let messageText = '';

        if (modeType.toUpperCase().includes('SWEEP')) {
            messageText = `⚡ *SWEEP MODE DETECTED!*\n` +
                          `────────────────────\n` +
                          `🤖 *Strategy:* HighFrequencySweepElite7 (5m)\n` +
                          `🪙 *Pair:* *${data.pair || 'N/A'}*\n` +
                          `📍 *Current Price:* $${data.current_price || data.price || 'N/A'}\n` +
                          `🛡️ *18-Bar Swing Low:* $${data.swing_low || data.trigger_level || 'N/A'}\n` +
                          `🔍 *Status:* Active Liquidity Flush / Wick Absorption in progress!\n` +
                          `📦 *Action:* Bot ready to fire entry on reclaim candle.\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        } else if (modeType.toUpperCase().includes('IGNITION')) {
            messageText = `🚀 *TREND IGNITION MODE DETECTED!*\n` +
                          `────────────────────\n` +
                          `🤖 *Strategy:* TrendIgnitionElite (15m)\n` +
                          `🪙 *Pair:* *${data.pair || 'N/A'}*\n` +
                          `📍 *Current Price:* $${data.current_price || data.price || 'N/A'}\n` +
                          `📈 *EMA 9 / 21 Cross:* Bullish Cross Active\n` +
                          `📊 *Momentum RSI:* ${data.rsi || '55 - 68 zone'}\n` +
                          `🔍 *Status:* Macro Uptrend breakout confirmed above EMA 50!\n` +
                          `📦 *Action:* Bot ready to capture momentum runner move.\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        } else {
            messageText = `🎯 *STRATEGY RADAR ALERT*\n` +
                          `────────────────────\n` +
                          `🪙 *Pair:* ${data.pair || 'N/A'}\n` +
                          `📝 *Details:* ${data.message || JSON.stringify(data, null, 2)}\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        }

        const sent = await sendWhatsAppSafe(destination, { text: messageText });
        if (sent) {
            console.log(`Mode Alert sent to WhatsApp: ${destination}`);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to deliver mode alert via WhatsApp.' });
        }
    } catch (err) {
        console.error('Error in mode-alert webhook:', err);
        res.status(500).json({ error: err.message });
    }
});

// Webhook endpoint to receive Preemption / Capital Handshake alerts from Portfolio Coordinator
app.post('/preemption-alert', async (req, res) => {
    try {
        const data = req.body;
        console.log('Received Preemption Alert:', JSON.stringify(data));

        if (!sock || !isConnected) {
            return res.status(503).json({ error: 'WhatsApp not connected yet.' });
        }

        let destination = req.query.to || TARGET_JID;
        if (!destination) {
            return res.status(400).json({ error: 'No recipient specified.' });
        }

        let messageText = '';
        if (data.event === 'PREEMPTION_REQUESTED') {
            const inStrat = data.incoming_strategy || 'RangeBreakoutDonchianPro';
            const curStrat = data.current_strategy || 'HighFrequencySweepElite7';
            messageText = `⚡ *PORTFOLIO PREEMPTION TRIGGERED!*\n` +
                          `────────────────────\n` +
                          `🎯 *High-Value Signal:* *${data.incoming_pair}* [${inStrat}]\n` +
                          `🚪 *Preempting Slot:* *${data.current_pair || 'Active Slot'}* [${curStrat}]\n` +
                          `⚖️ *Action:* Coordinator requesting safe exit to release wallet capital!\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        } else if (data.event === 'BALANCE_RELEASED') {
            const inStrat = data.incoming_strategy || 'RangeBreakoutDonchianPro';
            const relStrat = data.released_from_strategy || 'Sweep';
            messageText = `✅ *CAPITAL RELEASED FOR EXECUTION!*\n` +
                          `────────────────────\n` +
                          `🪙 *Released From:* [${relStrat}] (${data.released_from_pair || 'Scalp'})\n` +
                          `🚀 *Assigned To:* [${inStrat}] (*${data.incoming_pair}*)\n` +
                          `💰 *Wallet Status:* Free / Full Stake Handshake Complete\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        } else {
            messageText = `⚡ *PREEMPTION UPDATE*\n────────────────────\n${JSON.stringify(data, null, 2)}`;
        }

        const sent = await sendWhatsAppSafe(destination, { text: messageText });
        if (sent) {
            console.log(`Preemption alert sent to WhatsApp: ${destination}`);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to deliver preemption alert.' });
        }
    } catch (err) {
        console.error('Error in preemption-alert endpoint:', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper function to calculate standard RSI (Wilder's Smoothing)
function calculateRSI(closes, period = 14) {

    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses += -diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Automated Full Trade Opportunity Radar (Checks Binance 5m/15m data for all basket pairs every 30s)
// Evaluates full strategy conditions and inspects wallet balance / open trade slots
const lastModeAlertTimes = {};

async function checkStrategyModes() {
    if (!TARGET_JID || !sock || !isConnected) return;

    const basketPairs = ['SOL/USDT', 'WIF/USDT', 'XRP/USDT', 'ETH/USDT', 'TIA/USDT', 'AAVE/USDT', 'TAO/USDT', 'NEAR/USDT', 'LINK/USDT'];
    const now = Date.now();

    for (const pair of basketPairs) {
        const symbol = pair.replace('/', '');
        try {
            // 1. Full Trade Opportunity Check for HighFrequencySweepElite7 (5m)
            const klines5m = await fetchHttpsJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=45`);
            if (Array.isArray(klines5m) && klines5m.length >= 35) {
                const last18Lows = klines5m.slice(-19, -1).map(k => parseFloat(k[3]));
                const swingLow18 = Math.min(...last18Lows);

                const currentCandle = klines5m[klines5m.length - 1];
                const currentOpen = parseFloat(currentCandle[1]);
                const currentHigh = parseFloat(currentCandle[2]);
                const currentLow = parseFloat(currentCandle[3]);
                const currentClose = parseFloat(currentCandle[4]);
                const currentVolume = parseFloat(currentCandle[5]);

                // Volume 20 SMA
                const volumes20 = klines5m.slice(-21, -1).map(k => parseFloat(k[5]));
                const volumeSma20 = volumes20.reduce((a, b) => a + b, 0) / volumes20.length;

                // 14-period RSI
                const closes5m = klines5m.map(k => parseFloat(k[4]));
                const rsi5m = calculateRSI(closes5m, 14);

                // Candle Mechanics
                const body = Math.abs(currentClose - currentOpen);
                const lowerWick = Math.min(currentOpen, currentClose) - currentLow;
                const upperWick = currentHigh - Math.max(currentOpen, currentClose);
                const sweepDepth = (swingLow18 - currentLow) / swingLow18;

                // Full Elite7 Strategy Execution Rules:
                const isFullElite7Opp = (
                    currentLow < swingLow18 &&                       // Swept support
                    currentClose > swingLow18 &&                     // Reclaimed support
                    currentClose > currentOpen &&                    // Bullish close
                    sweepDepth >= 0.0010 &&                          // Min sweep depth
                    lowerWick >= (body * 0.8) &&                     // Dominant absorption lower wick
                    lowerWick >= (upperWick * 1.3) &&                // Bottom wick clearly beats top wick
                    rsi5m < 36 &&                                    // High-conviction oversold RSI
                    currentVolume > (volumeSma20 * 0.6)              // Volume participation
                );

                const eliteKey = `ELITE7_FULL_${pair}`;
                const lastEliteTime = lastModeAlertTimes[eliteKey] || 0;

                if (isFullElite7Opp && (now - lastEliteTime > 15 * 60 * 1000)) {
                    lastModeAlertTimes[eliteKey] = now;

                    // Query Bot 1 (Sweep Elite 7) open trades to verify wallet availability
                    let isWalletFree = true;
                    let openTradesCount = 0;
                    try {
                        const bot1Status = await callFreqtradeApi('/status', 'GET', null, 'bot1');
                        if (Array.isArray(bot1Status)) {
                            openTradesCount = bot1Status.length;
                            if (openTradesCount >= 1) isWalletFree = false;
                        }
                    } catch (err) {
                        // Keep default
                    }

                    const walletBadge = isWalletFree
                        ? `✅ *Wallet Status:* Free / Executable`
                        : `⚠️ *Wallet Status:* Slot Busy (${openTradesCount} Active Trade)`;

                    const actionText = isWalletFree
                        ? `Order dispatched / executed by Bot 1.`
                        : `Missed execution due to occupied wallet slot!`;

                    const eliteMsg = `⚡ *FULL TRADE OPPORTUNITY DETECTED!*\n` +
                                     `────────────────────\n` +
                                     `🤖 *Strategy:* HighFrequencySweepElite7 (5m)\n` +
                                     `🪙 *Pair:* *${pair}*\n` +
                                     `📍 *Entry Price:* $${currentClose}\n` +
                                     `🛡️ *18-Bar Swing Low:* $${swingLow18}\n` +
                                     `📊 *RSI (14):* ${rsi5m.toFixed(1)} (< 36 Oversold)\n` +
                                     `🕯️ *Wick Dominance:* Confirmed Reclaim\n` +
                                     `${walletBadge}\n` +
                                     `📦 *Action:* ${actionText}\n` +
                                     `⏰ *Time:* ${toKarachiTime(new Date())}`;

                    await sendWhatsAppSafe(TARGET_JID, { text: eliteMsg });
                    console.log(`Automated Full Elite7 Opportunity alert sent for ${pair} (Wallet Free: ${isWalletFree})`);
                }
            }

            // 2. Full Trade Opportunity Check for TrendIgnitionElite (15m)
            const klines15m = await fetchHttpsJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=65`);
            if (Array.isArray(klines15m) && klines15m.length >= 55) {
                const closes = klines15m.map(k => parseFloat(k[4]));
                const lastClose = closes[closes.length - 1];
                const prevClose = closes[closes.length - 2];
                const lastOpen = parseFloat(klines15m[klines15m.length - 1][1]);
                const lastVolume = parseFloat(klines15m[klines15m.length - 1][5]);

                // Volume 20 SMA
                const volumes20 = klines15m.slice(-21, -1).map(k => parseFloat(k[5]));
                const volumeSma20 = volumes20.reduce((a, b) => a + b, 0) / volumes20.length;

                // Approximate fast EMA 9, EMA 21, EMA 50
                const ema = (period, arr) => {
                    const k = 2 / (period + 1);
                    let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
                    for (let i = period; i < arr.length; i++) {
                        val = arr[i] * k + val * (1 - k);
                    }
                    return val;
                };

                const ema9Now = ema(9, closes);
                const ema21Now = ema(21, closes);
                const ema50Now = ema(50, closes);

                const ema9Prev = ema(9, closes.slice(0, -1));
                const ema21Prev = ema(21, closes.slice(0, -1));

                // EMA 50 Slope across 4 bars
                const ema50Prev4 = ema(50, closes.slice(0, -4));
                const ema50Slope = ((ema50Now - ema50Prev4) / ema50Prev4) * 100;

                const rsi15m = calculateRSI(closes, 14);

                // Trend Ignition Strategy Execution Rules:
                const isFullIgnitionOpp = (
                    (ema9Now > ema21Now) && (ema9Prev <= ema21Prev) &&   // EMA 9 crosses over EMA 21
                    (lastClose > ema50Now) &&                            // Close above EMA 50
                    (lastClose > lastOpen) &&                            // Bullish green candle
                    (ema50Slope >= 0.02) &&                              // Bullish macro slope
                    (rsi15m >= 55 && rsi15m <= 68) &&                    // Momentum sweet spot
                    (lastVolume > (volumeSma20 * 0.9))                   // Volume participation
                );

                const ignitionKey = `IGNITION_FULL_${pair}`;
                const lastIgnitionTime = lastModeAlertTimes[ignitionKey] || 0;

                if (isFullIgnitionOpp && (now - lastIgnitionTime > 30 * 60 * 1000)) {
                    lastModeAlertTimes[ignitionKey] = now;

                    // Query Bot 2 (Trend Ignition Elite) open trades to verify wallet availability
                    let isWalletFree = true;
                    let openTradesCount = 0;
                    try {
                        const bot2Status = await callFreqtradeApi('/status', 'GET', null, 'bot2');
                        if (Array.isArray(bot2Status)) {
                            openTradesCount = bot2Status.length;
                            if (openTradesCount >= 1) isWalletFree = false;
                        }
                    } catch (err) {
                        // Keep default
                    }

                    const walletBadge = isWalletFree
                        ? `✅ *Wallet Status:* Free / Executable`
                        : `⚠️ *Wallet Status:* Slot Busy (${openTradesCount} Active Trade)`;

                    const actionText = isWalletFree
                        ? `Order dispatched / executed by Bot 2.`
                        : `Missed execution due to occupied wallet slot!`;

                    const ignMsg = `🚀 *FULL TREND IGNITION OPPORTUNITY!*\n` +
                                   `────────────────────\n` +
                                   `🤖 *Strategy:* TrendIgnitionElite (15m)\n` +
                                   `🪙 *Pair:* *${pair}*\n` +
                                   `📍 *Entry Price:* $${lastClose}\n` +
                                   `📈 *EMA 9 / 21:* Bullish Crossover ($${ema9Now.toFixed(4)} > $${ema21Now.toFixed(4)})\n` +
                                   `🛡️ *Baseline EMA 50:* $${ema50Now.toFixed(4)} (Slope: +${ema50Slope.toFixed(3)}%)\n` +
                                   `📊 *RSI (14):* ${rsi15m.toFixed(1)} (Sweet Spot: 55-68)\n` +
                                   `${walletBadge}\n` +
                                   `📦 *Action:* ${actionText}\n` +
                                   `⏰ *Time:* ${toKarachiTime(new Date())}`;

                    await sendWhatsAppSafe(TARGET_JID, { text: ignMsg });
                    console.log(`Automated Full Trend Ignition alert sent for ${pair} (Wallet Free: ${isWalletFree})`);
                }
            }

            // 3. Full Trade Opportunity Check for RangeBreakoutDonchianPro (1h)
            const klines1h = await fetchHttpsJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=55`);
            if (Array.isArray(klines1h) && klines1h.length >= 30) {
                const closes = klines1h.map(k => parseFloat(k[4]));
                const highs = klines1h.map(k => parseFloat(k[2]));
                const lows = klines1h.map(k => parseFloat(k[3]));
                const lastClose = closes[closes.length - 1];
                const lastOpen = parseFloat(klines1h[klines1h.length - 1][1]);
                const lastHigh = highs[highs.length - 1];
                const lastLow = lows[lows.length - 1];
                const lastVol = parseFloat(klines1h[klines1h.length - 1][5]);

                // 24-hour high/low (previous 24 completed 1h candles)
                const rangeHigh24 = Math.max(...highs.slice(-25, -1));
                const candleRange = lastHigh - lastLow;
                const upperWick = lastHigh - Math.max(lastOpen, lastClose);
                const closePosition = (lastClose - lastLow) / (candleRange + 1e-8);

                // Volume 20 SMA
                const volumes20 = klines1h.slice(-21, -1).map(k => parseFloat(k[5]));
                const volSma20 = volumes20.reduce((a, b) => a + b, 0) / volumes20.length;

                const rsi1h = calculateRSI(closes, 14);

                const isDonchianBreakout = (
                    (lastClose > rangeHigh24) &&
                    (lastClose > lastOpen) &&
                    (lastVol > volSma20 * 1.7) &&
                    (closePosition >= 0.65) &&
                    (upperWick <= candleRange * 0.30) &&
                    (rsi1h >= 54 && rsi1h <= 78)
                );

                const donchianKey = `DONCHIAN_FULL_${pair}`;
                const lastDonchianTime = lastModeAlertTimes[donchianKey] || 0;

                if (isDonchianBreakout && (now - lastDonchianTime > 60 * 60 * 1000)) {
                    lastModeAlertTimes[donchianKey] = now;

                    let isWalletFree = true;
                    let openTradesCount = 0;
                    try {
                        const bot3Status = await callFreqtradeApi('/status', 'GET', null, 'bot3');
                        if (Array.isArray(bot3Status)) {
                            openTradesCount = bot3Status.length;
                            if (openTradesCount >= 1) isWalletFree = false;
                        }
                    } catch (err) {}

                    const donchianMsg = `💎 *DONCHIAN PRO BREAKOUT DETECTED!*\n` +
                                       `────────────────────\n` +
                                       `🤖 *Strategy:* RangeBreakoutDonchianPro (1h)\n` +
                                       `🪙 *Pair:* *${pair}*\n` +
                                       `📍 *Breakout Price:* $${lastClose}\n` +
                                       `🏔️ *24h Range High:* $${rangeHigh24}\n` +
                                       `📊 *RSI (14):* ${rsi1h.toFixed(1)} (Bullish Momentum)\n` +
                                       `🔥 *Volume Surge:* ${(lastVol / (volSma20 || 1)).toFixed(1)}x of 20-SMA\n` +
                                       `⚡ *Priority:* High Priority (Triggers Auto-Preemption if needed)\n` +
                                       `⏰ *Time:* ${toKarachiTime(new Date())}`;

                    await sendWhatsAppSafe(TARGET_JID, { text: donchianMsg });
                    console.log(`Automated Donchian Pro Breakout alert sent for ${pair}`);
                }
            }
        } catch (e) {
            // Ignore transient network errors
        }

    }
}

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, target: TARGET_JID || 'Not set' });
});

app.listen(BRIDGE_PORT, () => {
    console.log(`Baileys WhatsApp Bridge Server listening on http://127.0.0.1:${BRIDGE_PORT}`);
    startWhatsApp();
    setInterval(checkMorningDigest, 60000);        // Check every minute for 9:00 AM PKT digest
    setInterval(checkCustomPriceAlerts, 20000);    // Check custom price alerts every 20 seconds
    setInterval(checkTradeMilestones, 5000);       // Check trade SL, TP, milestones & duration every 5 seconds
    setInterval(checkStrategyModes, 30000);        // Check sweep mode & ignition mode every 30 seconds
});
