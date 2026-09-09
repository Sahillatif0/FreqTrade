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

// Format command responses for WhatsApp
async function handleWhatsAppCommand(commandText, senderJid) {
    const cmd = commandText.trim().toLowerCase();
    console.log(`Received command: "${cmd}" from ${senderJid}`);

    try {
        if (cmd === '/help' || cmd === 'help' || cmd === '/menu') {
            return `🤖 *FREQTRADE WHATSAPP COMMANDS*\n` +
                   `────────────────────\n` +
                   `📊 */status* - Active open trades & profit\n` +
                   `💰 */profit* - Overall profit & win rate summary\n` +
                   `⚖️ */balance* - Wallet balance & available USDT\n` +
                   `📜 */count* - Number of open trades vs max\n` +
                   `📈 */performance* - Performance per trading pair\n` +
                   `⏱️ */daily* - Daily profit breakdown\n` +
                   `⏸️ */stop* - Pause trading (stop buying)\n` +
                   `▶️ */start* - Resume trading bot\n` +
                   `ℹ️ */version* - Strategy & bot version info\n` +
                   `────────────────────\n` +
                   `_Tip: You can type with or without slash (e.g. "profit" or "/profit")_`;
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
                msg += `${i + 1}. *${trade.pair}* ${emoji} ${profitPct}%\n` +
                       `   💵 Open: ${trade.open_rate}\n` +
                       `   📍 Current: ${trade.current_rate}\n` +
                       `   ⏱️ Opened: ${openTime}\n` +
                       `   🏷️ Tag: ${trade.enter_tag || 'micro_liquidity_sweep'}\n\n`;
            });
            return msg.trim();
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
                await sock.sendMessage(sender, { text: reply });
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
            messageText = `🟢 *FREQTRADE BUY ORDER*\n` +
                          `────────────────────\n` +
                          `🪙 *Pair:* ${data.pair || 'N/A'}\n` +
                          `💵 *Rate:* ${data.open_rate || data.rate || 'N/A'}\n` +
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
});
