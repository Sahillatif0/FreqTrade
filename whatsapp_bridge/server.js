const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
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
let TARGET_JID = '';

if (fs.existsSync(TARGET_FILE)) {
    TARGET_JID = fs.readFileSync(TARGET_FILE, 'utf8').trim();
}

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
                   `ℹ️ */info* - Live prices, 15m support/resistance & 24h vol\n` +
                   `🌐 */market* - BTC trend, 24h change & Fear & Greed index\n` +
                   `💰 */profit* - Overall profit & win rate summary\n` +
                   `⚖️ */balance* - Wallet balance, free USDT & PKR equity\n` +
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
                   `_Tip: You can type without slash (e.g. "trades", "opportunities", "status")_`;
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
                const takeProfitPrice = (openRate * 1.015).toFixed(4);

                msg += `${i + 1}. *${trade.pair}* ${emoji} ${profitPct}%\n` +
                       `   💵 Open: *${trade.open_rate}*\n` +
                       `   📍 Current: *${trade.current_rate}*\n` +
                       `   🛡️ Stop Loss: *${stopLossPrice}* (-1.5%)\n` +
                       `   🎯 Take Profit: *${takeProfitPrice}* (+1.5%)\n` +
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
                    callFreqtradeApi('/whitelist').catch(() => ({ whitelist: ['SOL/USDT', 'BTC/USDT', 'ETH/USDT', 'TIA/USDT'] }))
                ]);

                const whitelist = whitelistData.whitelist || whitelistData.length ? whitelistData : ['SOL/USDT', 'BTC/USDT', 'ETH/USDT', 'TIA/USDT'];
                const openPairs = new Set(Array.isArray(statusData) ? statusData.map(t => t.pair) : []);

                let msg = `🎯 *STRATEGY OPPORTUNITY RADAR*\n` +
                          `────────────────────\n` +
                          `Strategy: *HighFrequencySweepElite*\n` +
                          `Scan Setup: *18-bar Liquidity Sweeps & Reclaims*\n\n`;

                for (const pair of whitelist.slice(0, 5)) {
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
            // Whitelist pairs
            const pairs = ['TIA/USDT', 'ETH/USDT', 'SOL/USDT', 'AAVE/USDT'];
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
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
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

        if (!destination.includes('@')) {
            destination = `${destination.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
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
    setInterval(checkMorningDigest, 60000); // Check every minute for 9:00 AM PKT digest
});
