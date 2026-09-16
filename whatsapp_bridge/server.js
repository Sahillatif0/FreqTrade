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

// Freqtrade API Server Config (Default ports: 8080 or 8088)
const FT_API_HOST = '127.0.0.1';
const FT_API_PORT = 8080; // set to 8088 if running config_web.json
const FT_USERNAME = 'freqtrader';
const FT_PASSWORD = '724455';

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

// Helper function to call Freqtrade REST API
function callFreqtradeApi(endpoint, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const auth = 'Basic ' + Buffer.from(`${FT_USERNAME}:${FT_PASSWORD}`).toString('base64');
        const options = {
            hostname: FT_API_HOST,
            port: FT_API_PORT,
            path: '/api/v1' + endpoint,
            method: method,
            headers: {
                'Authorization': auth,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        };

        const req = http.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseData);
                    resolve(parsed);
                } catch (e) {
                    resolve(responseData);
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Freqtrade API timeout'));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Generate full daily morning digest
async function generateDailyDigest() {
    try {
        const [profit, balance, status, fng, btcTicker] = await Promise.all([
            callFreqtradeApi('/profit').catch(() => ({})),
            callFreqtradeApi('/balance').catch(() => ({})),
            callFreqtradeApi('/status').catch(() => ([])),
            fetchHttpsJson('https://api.alternative.me/fng/?limit=1').catch(() => null),
            fetchHttpsJson('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT').catch(() => null)
        ]);

        const totalEquity = balance.total ? balance.total.toFixed(2) : 'N/A';
        const pkrVal = balance.value ? Number(balance.value).toLocaleString('en-US', {maximumFractionDigits: 0}) : 'N/A';
        const winRate = profit.winrate !== undefined ? (profit.winrate * 100).toFixed(1) : (((profit.winning_trades || 0) / ((profit.closed_trade_count || 1))) * 100).toFixed(1);
        const closedProfit = profit.profit_closed_coin?.toFixed(2) || '0.00';
        const openCount = Array.isArray(status) ? status.length : 0;

        const fngVal = fng?.data?.[0]?.value || 'N/A';
        const fngClass = fng?.data?.[0]?.value_classification || 'Neutral';
        const btcPrice = btcTicker?.lastPrice ? parseFloat(btcTicker.lastPrice).toLocaleString('en-US', {maximumFractionDigits: 0}) : 'N/A';
        const btcChange = btcTicker?.priceChangePercent ? parseFloat(btcTicker.priceChangePercent).toFixed(2) : '0.00';

        return `🌅 *DAILY TRADING DIGEST*\n` +
               `────────────────────\n` +
               `💰 *Closed PnL:* ${closedProfit} USDT\n` +
               `🏆 *Win Rate:* ${winRate}% (${profit.winning_trades || 0}W / ${profit.losing_trades || 0}L)\n` +
               `⚖️ *Portfolio Equity:* ${totalEquity} USDT (${pkrVal} PKR)\n` +
               `📊 *Open Trades:* ${openCount} / 1\n` +
               `🪙 *Bitcoin:* $${btcPrice} (${btcChange >= 0 ? '+' : ''}${btcChange}%)\n` +
               `🎭 *Market Sentiment:* ${fngVal} (${fngClass})\n` +
               `⏰ *Report Time:* ${toKarachiTime(new Date())}\n` +
               `────────────────────\n` +
               `_HighFrequencySweepElite active & scanning!_ 🚀`;
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
                sock.sendMessage(TARGET_JID, { text: msg });
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

                        await sock.sendMessage(TARGET_JID, { text: alertMsg });
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
        const openTrades = await callFreqtradeApi('/status').catch(() => []);
        if (!Array.isArray(openTrades) || openTrades.length === 0) return;

        const now = Date.now();

        for (const trade of openTrades) {
            const tradeId = String(trade.trade_id);
            if (!tradeMilestones[tradeId]) {
                tradeMilestones[tradeId] = {
                    plus1: false,
                    minus1: false,
                    twoHours: false
                };
            }

            const state = tradeMilestones[tradeId];
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

                await sock.sendMessage(TARGET_JID, { text: msg });
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

                await sock.sendMessage(TARGET_JID, { text: msg });
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

            // Automated Custom Take Profit Execution Check
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
                        await callFreqtradeApi('/forcesell', 'POST', { tradeid: tradeId });
                        const tpMsg = `🎯 *TAKE PROFIT TRIGGERED!*\n` +
                                      `────────────────────\n` +
                                      `🪙 *Pair:* ${trade.pair}\n` +
                                      `🆔 *Trade ID:* #${tradeId}\n` +
                                      `💰 *Locked Profit:* *+${pnlPct}%*\n` +
                                      `💵 *Exit Price:* $${currentRate}\n` +
                                      `🎯 *Target Price:* $${target.targetPrice ? target.targetPrice : (openRate * (1 + target.targetRatio)).toFixed(4)}\n` +
                                      `🚀 *Action:* Limit/Market exit executed successfully!\n` +
                                      `⏰ *Time:* ${toKarachiTime(new Date())}`;

                        await sock.sendMessage(TARGET_JID, { text: tpMsg });
                        console.log(`Automated custom take profit executed for trade #${tradeId} (${trade.pair})`);
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
            return `🤖 *FREQTRADE COMMAND CENTER*\n` +
                   `────────────────────\n` +
                   `📊 */status* - Active open trades, SL/TP levels & PnL\n` +
                   `📜 */trades [limit]* - Past executed opportunities (buy price, sell price, PnL, duration)\n` +
                   `🎯 */opportunities* - Live opportunity radar across whitelist pairs\n` +
                   `🔔 */alert [pair] [price]* - Set custom WhatsApp price alert (e.g. /alert SOL 135)\n` +
                   `📋 */alerts* - View all active custom price alerts\n` +
                   `🗑️ */clearalerts* - Clear active custom price alerts\n` +
                   `ℹ️ */info* - Live prices, 15m support/resistance & 24h vol\n` +
                   `🌐 */market* - BTC trend, 24h change & Fear & Greed index\n` +
                   `💰 */profit* - Overall profit & win rate summary\n` +
                   `⚖️ */balance* - Wallet balance, free USDT & PKR equity\n` +
                   `🛡️ */stoploss [id] [pct/price]* - Update stop loss for a single trade (e.g. /stoploss 1 -0.01)\n` +
                   `🎯 */takeprofit [id] [pct/price]* - Set custom take profit target for a single trade (e.g. /tp 1 +2.0%)\n` +
                   `🚨 */forcesell [id/all]* - Instantly market exit open trades\n` +
                   `📜 */count* - Open trades count vs maximum\n` +
                   `📈 */performance* - Performance per trading pair\n` +
                   `⏱️ */daily* - Daily profit breakdown\n` +
                   `🌅 */digest* - Generate full daily morning digest right now\n` +
                   `🔄 */reload* - Reload bot configuration & pairlist\n` +
                   `⏸️ */stop* - Pause trading bot (stop buying)\n` +
                   `▶️ */start* - Resume trading bot\n` +
                   `ℹ️ */version* - Strategy & bot version info\n` +
                   `────────────────────\n` +
                   `_Tip: You can type without slash (e.g. "alert SOL 135", "trades", "status")_`;
        }

        if (cmd === '/status' || cmd === 'status') {
            const data = await callFreqtradeApi('/status');
            if (!Array.isArray(data) || data.length === 0) {
                return `📊 *OPEN TRADES STATUS*\n────────────────────\nNo active open trades right now.\nBot is scanning for liquidity sweeps! 🔍`;
            }

            let msg = `📊 *ACTIVE OPEN TRADES (${data.length})*\n────────────────────\n`;
            data.forEach((trade, i) => {
                const ratio = trade.profit_pct !== undefined ? trade.profit_pct : ((trade.profit_ratio || 0) * 100);
                const profitPct = Number(ratio).toFixed(2);
                const emoji = Number(ratio) >= 0 ? '🟢' : '🔴';
                const rawDate = trade.open_date || trade.open_date_hum;
                const openTime = toKarachiTime(rawDate);

                // Calculate Stop Loss and Take Profit prices
                const openRate = parseFloat(trade.open_rate);
                const stopLossPrice = trade.stop_loss_abs ? parseFloat(trade.stop_loss_abs).toFixed(4) : (openRate * 0.985).toFixed(4);
                let takeProfitPrice = (openRate * 1.015).toFixed(4);
                let tpExtra = '(+1.5%)';

                const tradeId = String(trade.trade_id);
                if (customTakeProfits[tradeId]) {
                    const ctp = customTakeProfits[tradeId];
                    if (ctp.targetPrice) {
                        takeProfitPrice = ctp.targetPrice.toFixed(4);
                        const diffPct = (((ctp.targetPrice - openRate) / openRate) * 100).toFixed(2);
                        tpExtra = `(+${diffPct}% 🎯 Custom)`;
                    } else if (ctp.targetRatio) {
                        takeProfitPrice = (openRate * (1 + ctp.targetRatio)).toFixed(4);
                        tpExtra = `(+${(ctp.targetRatio * 100).toFixed(2)}% 🎯 Custom)`;
                    }
                }

                msg += `${i + 1}. *${trade.pair}* ${emoji} ${profitPct}%\n` +
                       `   💵 Open: *${trade.open_rate}*\n` +
                       `   📍 Current: *${trade.current_rate}*\n` +
                       `   🛡️ Stop Loss: *${stopLossPrice}* (-1.5%)\n` +
                       `   🎯 Take Profit: *${takeProfitPrice}* ${tpExtra}\n` +
                       `   ⏱️ Opened: ${openTime}\n` +
                       `   🏷️ Tag: ${trade.enter_tag || 'micro_liquidity_sweep'}\n\n`;
            });
            return msg.trim();
        }

        if (cmd.startsWith('/trades') || cmd.startsWith('trades') || cmd === '/history' || cmd === 'history') {
            const parts = commandText.trim().split(/\s+/);
            const limit = parseInt(parts[1]) || 5;

            try {
                const tradesData = await callFreqtradeApi(`/trades?limit=${limit}`);
                const trades = tradesData?.trades || (Array.isArray(tradesData) ? tradesData : []);

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

                    // Duration formatting
                    let durStr = 'N/A';
                    if (t.open_timestamp && t.close_timestamp) {
                        const durMin = Math.round((t.close_timestamp - t.open_timestamp) / 60000);
                        if (durMin < 60) {
                            durStr = `${durMin}m`;
                        } else {
                            durStr = `${Math.floor(durMin / 60)}h ${durMin % 60}m`;
                        }
                    }

                    msg += `${i + 1}. *${t.pair}* ${emoji} *${pnlPct}%* (${pnlUsdt} USDT)\n` +
                           `   📥 *Buy Price:* ${buyRate} (${buyTime})\n` +
                           `   📤 *Sell Price:* ${sellRate} (${sellTime})\n` +
                           `   🏷️ *Strategy Tag:* ${t.enter_tag || 'micro_liquidity_sweep'}\n` +
                           `   🚪 *Exit Reason:* ${t.exit_reason || 'roi'}\n` +
                           `   ⏱️ *Hold Duration:* ${durStr}\n\n`;
                });

                msg += `_Use "/trades 10" to view more records._`;
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

        if (cmd === '/profit' || cmd === 'profit') {
            const data = await callFreqtradeApi('/profit');
            const totalClosed = data.closed_trade_count !== undefined ? data.closed_trade_count : (data.total_trades || 0);
            const winRate = data.winrate !== undefined ? (data.winrate * 100).toFixed(1) : (((data.winning_trades || 0) / (totalClosed || 1)) * 100).toFixed(1);
            const firstTime = data.first_trade_humanized || toKarachiTime(data.first_trade_date);
            const latestTime = data.latest_trade_humanized || toKarachiTime(data.latest_trade_date);
            
            return `💰 *PROFIT SUMMARY*\n` +
                   `────────────────────\n` +
                   `💵 *Closed Profit:* ${data.profit_closed_coin?.toFixed(2) || 0} USDT (${((data.profit_closed_ratio_mean || 0) * 100).toFixed(2)}% avg)\n` +
                   `📊 *Closed Trades:* ${totalClosed}\n` +
                   `🎯 *Wins / Losses:* ${data.winning_trades || 0} W / ${data.losing_trades || 0} L\n` +
                   `🏆 *Win Rate:* ${winRate}%\n` +
                   `⏱️ *First Trade:* ${firstTime}\n` +
                   `⏱️ *Latest Trade:* ${latestTime}`;
        }

        if (cmd === '/balance' || cmd === 'balance') {
            const data = await callFreqtradeApi('/balance');
            let msg = `⚖️ *ACCOUNT BALANCE*\n────────────────────\n`;
            
            // Find USDT and open coin holdings
            const usdt = data.currencies?.find(c => c.currency === (data.stake || 'USDT'));
            const freeStake = usdt ? usdt.free.toFixed(2) : '0.00';
            const totalStake = data.total ? data.total.toFixed(2) : '0.00';
            const usedInTrades = (data.total - (usdt ? usdt.free : 0)).toFixed(2);
            
            msg += `💵 *Total Equity:* ${totalStake} ${data.stake || 'USDT'}\n`;
            msg += `🪙 *Available (Free):* ${freeStake} ${data.stake || 'USDT'}\n`;
            msg += `📦 *In Open Trades:* ${usedInTrades} ${data.stake || 'USDT'}\n`;
            if (data.value && data.symbol) {
                msg += `🇵🇰 *Total (PKR):* ${Number(data.value).toLocaleString('en-US', {maximumFractionDigits: 0})} ${data.symbol}\n`;
            }
            return msg.trim();
        }

        if (cmd === '/count' || cmd === 'count') {
            const data = await callFreqtradeApi('/count');
            return `📜 *TRADE COUNT*\n────────────────────\n` +
                   `Active: *${data.current}* / Max: *${data.max}* trades`;
        }

        if (cmd === '/performance' || cmd === 'performance') {
            const data = await callFreqtradeApi('/performance');
            if (!Array.isArray(data) || data.length === 0) {
                return `📈 *PERFORMANCE*\n────────────────────\nNo closed trades recorded yet.`;
            }
            let msg = `📈 *PAIR PERFORMANCE*\n────────────────────\n`;
            data.forEach((p) => {
                const profitUSDT = p.profit_abs?.toFixed(2) || 0;
                const emoji = p.profit_abs >= 0 ? '🟢' : '🔴';
                msg += `${emoji} *${p.pair}*: ${p.count} trades | ${profitUSDT} USDT (${p.profit_ratio.toFixed(2)}%)\n`;
            });
            return msg.trim();
        }

        if (cmd === '/daily' || cmd === 'daily') {
            const data = await callFreqtradeApi('/daily?timescale=7');
            if (!data.data || data.data.length === 0) {
                return `⏱️ *DAILY BREAKDOWN*\n────────────────────\nNo daily data available yet.`;
            }
            let msg = `⏱️ *RECENT DAILY PROFITS*\n────────────────────\n`;
            const fiatCurr = data.fiat_display_currency || 'PKR';
            data.data.slice(-5).reverse().forEach(d => {
                const emoji = d.abs_profit >= 0 ? '🟢' : '🔴';
                const tradesCount = d.trade_count !== undefined ? d.trade_count : (d.trades || 0);
                const fiatStr = d.fiat_value ? ` (${d.fiat_value.toFixed(0)} ${fiatCurr})` : '';
                msg += `${emoji} *${d.date}*: ${d.abs_profit?.toFixed(2)} USDT${fiatStr} | ${tradesCount} trades\n`;
            });
            return msg.trim();
        }

        if (cmd === '/stop' || cmd === 'stop') {
            await callFreqtradeApi('/stop', 'POST');
            return `⏸️ *Freqtrade Bot Paused*\nNew trade entries are stopped. Open trades will continue to be monitored for exit.`;
        }

        if (cmd === '/start' || cmd === 'start') {
            await callFreqtradeApi('/start', 'POST');
            return `▶️ *Freqtrade Bot Resumed*\nScanning pairs for entry signals!`;
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
            const parts = cmd.split(' ');
            const arg = parts[1] || 'all';

            try {
                if (arg === 'all') {
                    const openTrades = await callFreqtradeApi('/status');
                    if (!Array.isArray(openTrades) || openTrades.length === 0) {
                        return `⚠️ No active open trades to sell.`;
                    }
                    let results = [];
                    for (const trade of openTrades) {
                        await callFreqtradeApi('/forcesell', 'POST', { tradeid: String(trade.trade_id) });
                        results.push(`🚨 Force-sold trade #${trade.trade_id} (${trade.pair})`);
                    }
                    return results.join('\n');
                } else {
                    const tradeId = arg;
                    await callFreqtradeApi('/forcesell', 'POST', { tradeid: String(tradeId) });
                    return `🚨 Force exit order sent for trade #${tradeId} at market price!`;
                }
            } catch (err) {
                return `⚠️ Failed to execute force sell: ${err.message}`;
            }
        }

        if (cmd.startsWith('/stoploss') || cmd.startsWith('stoploss') || cmd.startsWith('/sl ') || cmd.startsWith('sl ')) {
            const parts = commandText.trim().split(/\s+/);
            if (parts.length < 3) {
                return `🛡️ *UPDATE STOP LOSS*\n────────────────────\n` +
                       `⚠️ *Usage:* /stoploss [trade_id] [stoploss_value]\n\n` +
                       `*Examples:*\n` +
                       `• \`/stoploss 1 -0.010\` (Set -1.0% stop loss)\n` +
                       `• \`/stoploss 1 -1.5%\` (Set -1.5% stop loss)\n` +
                       `• \`/stoploss 1 134.50\` (Set absolute stop loss price)\n\n` +
                       `_Check active trade IDs with "/status"_`;
            }

            const tradeId = parts[1].replace('#', '').trim();
            let rawValue = parts[2].trim().replace('%', '');
            let stoplossValue = parseFloat(rawValue);

            if (isNaN(stoplossValue)) {
                return `⚠️ Invalid stop loss value: "${parts[2]}". Please provide a percentage (e.g. -0.012 or -1.2%) or an absolute price.`;
            }

            try {
                // Check if tradeId is valid in open trades
                const openTrades = await callFreqtradeApi('/status');
                const targetTrade = Array.isArray(openTrades) ? openTrades.find(t => String(t.trade_id) === String(tradeId)) : null;

                if (!targetTrade) {
                    return `⚠️ Active trade #${tradeId} not found. Check active trades with "/status".`;
                }

                // If user provided a positive percentage e.g. 1.2 or 0.012, make it negative for relative SL
                if (stoplossValue > 0 && stoplossValue <= 0.20) {
                    stoplossValue = -stoplossValue;
                } else if (stoplossValue > 0 && stoplossValue < 50 && stoplossValue < targetTrade.open_rate * 0.5) {
                    // e.g. user entered "1.5" meaning -1.5%
                    stoplossValue = -(stoplossValue / 100);
                }

                // If user provided an absolute price level (e.g. 135.20)
                let payload = {};
                if (stoplossValue > 0 && stoplossValue >= targetTrade.open_rate * 0.5) {
                    // Absolute price mode: calculate relative ratio from open_rate
                    const openRate = parseFloat(targetTrade.open_rate);
                    const ratio = (stoplossValue - openRate) / openRate;
                    payload = { stoploss: parseFloat(ratio.toFixed(4)) };
                } else {
                    // Ratio mode: e.g. -0.010 (-1.0%)
                    payload = { stoploss: stoplossValue };
                }

                // Update trade stoploss in Freqtrade
                // Freqtrade REST API: POST /trades/{tradeid}/stoploss or PUT /trades/{tradeid}
                const res = await callFreqtradeApi(`/trades/${tradeId}/stoploss`, 'POST', payload).catch(async (e) => {
                    // Fallback to query param or direct trade update
                    return await callFreqtradeApi(`/trades/${tradeId}`, 'PUT', payload);
                });

                const newPct = (Math.abs(payload.stoploss) * 100).toFixed(2);
                const openRate = parseFloat(targetTrade.open_rate);
                const estimatedPrice = (openRate * (1 + payload.stoploss)).toFixed(4);

                return `🛡️ *STOP LOSS UPDATED*\n────────────────────\n` +
                       `🪙 *Pair:* ${targetTrade.pair}\n` +
                       `🆔 *Trade ID:* #${tradeId}\n` +
                       `🛡️ *New Stop Loss:* *-${newPct}%* (~$${estimatedPrice})\n` +
                       `💵 *Open Rate:* $${openRate}\n` +
                       `⏰ *Time:* ${toKarachiTime(new Date())}\n\n` +
                       `_Freqtrade has adjusted risk for this trade._`;
            } catch (err) {
                return `⚠️ Failed to update stop loss for trade #${tradeId}: ${err.message}`;
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
                const openTrades = await callFreqtradeApi('/status');
                const targetTrade = Array.isArray(openTrades) ? openTrades.find(t => String(t.trade_id) === String(tradeId)) : null;

                if (!targetTrade) {
                    return `⚠️ Active trade #${tradeId} not found. Check active trades with "/status".`;
                }

                if (actionArg === 'clear' || actionArg === 'reset') {
                    delete customTakeProfits[tradeId];
                    saveCustomTakeProfits();
                    return `🎯 Cleared custom take profit for trade #${tradeId}. Reverted to strategy defaults.`;
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
                    customTakeProfits[tradeId] = {
                        pair: targetTrade.pair,
                        targetPrice: tpValue,
                        openRate: openRate,
                        setAt: toKarachiTime(new Date())
                    };
                } else if (tpValue < 1.0) {
                    // Decimal ratio mode e.g. 0.025 (+2.5%)
                    customTakeProfits[tradeId] = {
                        pair: targetTrade.pair,
                        targetRatio: tpValue,
                        openRate: openRate,
                        setAt: toKarachiTime(new Date())
                    };
                } else {
                    // Whole percentage mode e.g. 2.5 meaning +2.5%
                    customTakeProfits[tradeId] = {
                        pair: targetTrade.pair,
                        targetRatio: tpValue / 100,
                        openRate: openRate,
                        setAt: toKarachiTime(new Date())
                    };
                }

                saveCustomTakeProfits();

                const ctp = customTakeProfits[tradeId];
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
                       `🆔 *Trade ID:* #${tradeId}\n` +
                       `🎯 *Take Profit Target:* *${displayPct}* (${displayPrice})\n` +
                       `💵 *Open Rate:* $${openRate}\n` +
                       `📍 *Current Rate:* $${targetTrade.current_rate}\n` +
                       `⏰ *Time:* ${toKarachiTime(new Date())}\n\n` +
                       `_The bridge monitor will automatically exit this trade the instant target is touched!_`;
            } catch (err) {
                return `⚠️ Failed to set take profit for trade #${tradeId}: ${err.message}`;
            }
        }

        if (cmd === '/reload' || cmd === 'reload') {
            try {
                await callFreqtradeApi('/reload_config', 'POST');
                return `🔄 *Config & Pairlist Reloaded Successfully!*\nBot updated without restarting.`;
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
            const data = await callFreqtradeApi('/version');
            return `ℹ️ *BOT INFO*\n────────────────────\nVersion: ${data.version}\nStrategy: HighFrequencySweepElite`;
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

        if (type === 'entry' || data.event_type === 'entry') {
            const entryRate = parseFloat(data.open_rate || data.rate || 0);
            const sl = entryRate ? (entryRate * 0.985).toFixed(4) : 'N/A';
            const tp = entryRate ? (entryRate * 1.015).toFixed(4) : 'N/A';

            messageText = `🟢 *FREQTRADE BUY ORDER*\n` +
                          `────────────────────\n` +
                          `🪙 *Pair:* ${data.pair || 'N/A'}\n` +
                          `💵 *Entry Rate:* *${data.open_rate || data.rate || 'N/A'}*\n` +
                          `🛡️ *Stop Loss:* *${sl}* (-1.5%)\n` +
                          `🎯 *Take Profit:* *${tp}* (+1.5%)\n` +
                          `📦 *Stake:* ${data.stake_amount || 'N/A'} ${data.stake_currency || 'USDT'}\n` +
                          `🏷️ *Tag:* ${data.enter_tag || 'micro_liquidity_sweep'}\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        } else if (type === 'exit' || data.event_type === 'exit') {
            const isProfit = (data.profit_percent || data.profit_ratio || 0) >= 0;
            const emoji = isProfit ? '🎯' : '⚠️';
            messageText = `${emoji} *FREQTRADE SELL ORDER*\n` +
                          `────────────────────\n` +
                          `🪙 *Pair:* ${data.pair || 'N/A'}\n` +
                          `💰 *PnL:* ${data.profit_percent || ((data.profit_ratio || 0) * 100).toFixed(2)}%\n` +
                          `💵 *Profit Amount:* ${data.profit_amount || '0'} USDT\n` +
                          `🚪 *Exit Reason:* ${data.exit_reason || 'roi'}\n` +
                          `⏰ *Duration:* ${data.duration || 'N/A'}\n` +
                          `⏰ *Time:* ${toKarachiTime(new Date())}`;
        } else {
            messageText = `🤖 *FREQTRADE ALERT*\n` +
                          `────────────────────\n` +
                          `${data.message || JSON.stringify(data, null, 2)}`;
        }

        await sock.sendMessage(destination, { text: messageText });
        console.log(`Alert dispatched to WhatsApp: ${destination}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error sending WhatsApp message:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, target: TARGET_JID || 'Not set' });
});

app.listen(BRIDGE_PORT, () => {
    console.log(`Baileys WhatsApp Bridge Server listening on http://127.0.0.1:${BRIDGE_PORT}`);
    startWhatsApp();
    setInterval(checkMorningDigest, 60000);        // Check every minute for 9:00 AM PKT digest
    setInterval(checkCustomPriceAlerts, 20000);    // Check custom price alerts every 20 seconds
    setInterval(checkTradeMilestones, 15000);      // Check trade +1.0% milestones & duration every 15 seconds
});
