const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store active game sessions
const gameSessions = new Map();

// Color codes for console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

// PostgreSQL connection
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'horse_racing',
    password: 'mahtot123',
    port: 5433,
    ssl: false
});

// Test database connection
console.log(`${colors.cyan}🔌 Attempting to connect to PostgreSQL...${colors.reset}`);

pool.connect((err, client, release) => {
    if (err) {
        console.log(`${colors.red}❌ DATABASE CONNECTION FAILED!${colors.reset}`);
        console.log(`${colors.red}Error details:${colors.reset}`, err.message);
    } else {
        console.log(`${colors.green}✅ DATABASE CONNECTED SUCCESSFULLY!${colors.reset}`);
        release();
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================
// TELEGRAM BOT INTEGRATION
// ============================================

const BOT_TOKEN = '8377238725:AAHbdKSHJfJRepL2Jzhab0qcOnIVGzN2HRU';
const sessions = new Map();
const bot = new Telegraf(BOT_TOKEN);
const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://horse-racing-pu5g.onrender.com';

console.log(`${colors.cyan}🤖 Initializing Telegram bot...${colors.reset}`);
console.log(`${colors.cyan}📡 Bot Base URL: ${BASE_URL}${colors.reset}`);

// Generate unique referral code
function generateReferralCode(userId, phone) {
    const cleanPhone = phone.replace(/\D/g, '').slice(-4);
    return `REF${userId}${cleanPhone}`;
}

// Get referral statistics
async function getReferralStats(phone) {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_referrals,
                COALESCE(SUM(bonus_amount), 0) as total_bonus
            FROM referrals 
            WHERE referrer_phone = $1 AND bonus_awarded = TRUE
        `, [phone]);
        return result.rows[0];
    } catch (err) {
        return { total_referrals: 0, total_bonus: 0 };
    }
}

// Check if user is registered
async function isUserRegistered(telegramId) {
    try {
        const linkCheck = await pool.query('SELECT * FROM telegram_links WHERE telegram_id = $1', [telegramId]);
        if (linkCheck.rows.length > 0) {
            const userCheck = await pool.query('SELECT * FROM users WHERE phone = $1', [linkCheck.rows[0].phone]);
            if (userCheck.rows.length > 0) {
                return { registered: true, user: userCheck.rows[0], phone: linkCheck.rows[0].phone };
            }
        }
    } catch (err) {}
    return { registered: false };
}

// /start command
bot.start(async (ctx) => {
    const parts = ctx.message.text.split(' ');
    let referralCode = parts.length > 1 ? parts[1] : null;
    if (referralCode) sessions.set(ctx.from.id, { referral_code: referralCode, step: 'start' });
    
    ctx.reply(
        '🐎 HORSE RACING BET BOT\n\n' +
        '━━━━━━━━━━━━━━━━━━━━\n\n' +
        '🎰 Games Available:\n' +
        '• Horse Racing - Bet on 6 horses\n' +
        '• Keno - Pick 1-10 numbers\n\n' +
        '📋 Commands:\n' +
        '/register - Create new account\n' +
        '/play - Auto-login to app\n' +
        '/balance - Check wallet balance\n' +
        '/invite - Get referral link\n' +
        '/referrals - View your referrals\n' +
        '/keno - Play Keno\n' +
        '/help - Show this menu\n\n' +
        '━━━━━━━━━━━━━━━━━━━━\n' +
        `🎲 Your referral link: t.me/${ctx.botInfo.username}?start=${referralCode || ''}`
    );
});

// /help command
bot.help((ctx) => {
    ctx.reply(
        '📋 AVAILABLE COMMANDS\n\n' +
        '/register - Create new account\n' +
        '/play - Auto-login to app\n' +
        '/balance - Check your balance\n' +
        '/invite - Get referral link\n' +
        '/referrals - View your referrals\n' +
        '/keno - Play Keno game\n' +
        '/cancel - Cancel registration\n' +
        '/help - Show this menu'
    );
});

// /cancel command
bot.command('cancel', (ctx) => {
    if (sessions.delete(ctx.from.id)) {
        ctx.reply('❌ Registration cancelled');
    } else {
        ctx.reply('No active session');
    }
});

// /invite command
bot.command('invite', async (ctx) => {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (!registered.registered) {
            return ctx.reply('❌ You need to register first. Use /register');
        }
        
        const botUsername = ctx.botInfo ? ctx.botInfo.username : 'ALPHA_ALLGAME_BOT';
        const userData = await pool.query('SELECT referral_code FROM users WHERE phone = $1', [registered.phone]);
        const referralCode = userData.rows[0].referral_code;
        const inviteLink = `https://t.me/${botUsername}?start=${referralCode}`;
        
        const awarded = await pool.query('SELECT COUNT(*) FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE', [registered.phone]);
        const pending = await pool.query('SELECT COUNT(*) FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = FALSE', [registered.phone]);
        const bonus = await pool.query('SELECT COALESCE(SUM(bonus_amount),0) FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE', [registered.phone]);
        
        await ctx.reply(
            `👥 YOUR REFERRAL PROGRAM\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🔗 Share this link:\n${inviteLink}\n\n` +
            `📊 Statistics:\n` +
            `• Awarded Referrals: ${awarded.rows[0].count}\n` +
            `• Pending Referrals: ${pending.rows[0].count}\n` +
            `• Total Bonus Earned: $${parseFloat(bonus.rows[0].total || 0).toFixed(2)}\n\n` +
            `💰 You get $10 for each friend who makes their first deposit!\n\n` +
            `━━━━━━━━━━━━━━━━━━━━`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 View Referrals', callback_data: 'view_referrals' }],
                        [{ text: '🎮 Play Now', web_app: { url: `${BASE_URL}/select.html` } }]
                    ]
                }
            }
        );
    } catch (err) {
        console.error('Invite error:', err);
        ctx.reply('❌ Error. Please try again.');
    }
});

// /referrals command
bot.command('referrals', async (ctx) => {
    await viewReferrals(ctx);
});

bot.action('view_referrals', async (ctx) => {
    await viewReferrals(ctx);
});

async function viewReferrals(ctx) {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (!registered.registered) {
            return ctx.reply('❌ You need to register first. Use /register');
        }
        
        const awarded = await pool.query(`
            SELECT referred_phone, created_at, bonus_amount, bonus_awarded_at 
            FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE
            ORDER BY bonus_awarded_at DESC LIMIT 10
        `, [registered.phone]);
        
        const pending = await pool.query(`
            SELECT referred_phone, created_at 
            FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = FALSE
            ORDER BY created_at DESC LIMIT 10
        `, [registered.phone]);
        
        let message = `👥 YOUR REFERRALS\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        message += `✅ AWARDED (${awarded.rows.length}):\n`;
        if (awarded.rows.length > 0) {
            awarded.rows.forEach((ref, i) => {
                const date = new Date(ref.bonus_awarded_at).toLocaleDateString();
                message += `  ${i+1}. ${ref.referred_phone} - $${ref.bonus_amount} (${date})\n`;
            });
        } else {
            message += `  None yet\n`;
        }
        
        message += `\n⏳ PENDING (${pending.rows.length}):\n`;
        if (pending.rows.length > 0) {
            pending.rows.forEach((ref, i) => {
                const date = new Date(ref.created_at).toLocaleDateString();
                message += `  ${i+1}. ${ref.referred_phone} (registered ${date})\n`;
            });
            message += `\n💡 Pending referrals award $10 when they make first deposit!`;
        } else {
            message += `  None\n`;
        }
        
        await ctx.reply(message);
    } catch (err) {
        console.error('View referrals error:', err);
        ctx.reply('❌ Error loading referrals');
    }
}

// /keno command
bot.command('keno', async (ctx) => {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (!registered.registered) {
            return ctx.reply('❌ You need to register first. Use /register');
        }
        
        const kenoUrl = `${BASE_URL}/keno.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
        
        await ctx.reply(
            `🎲 KENO GAME\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🎯 How to Play:\n` +
            `• Select 1-10 numbers (1-80)\n` +
            `• Place your bets\n` +
            `• Watch numbers get drawn\n` +
            `• Win up to 20,000x your bet!\n\n` +
            `💰 Current Balance: $${parseFloat(registered.user.wallet_balance).toFixed(2)}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Click below to start playing!`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🎲 Play Keno Now', web_app: { url: kenoUrl } }]
                    ]
                }
            }
        );
    } catch (err) {
        console.error('Keno command error:', err);
        ctx.reply('❌ Error. Please try again.');
    }
});

// /register command
bot.command('register', async (ctx) => {
    const userId = ctx.from.id;
    let referralCode = sessions.get(userId)?.referral_code;
    const parts = ctx.message.text.split(' ');
    if (parts.length > 1) referralCode = parts[1];
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            return ctx.reply(
                `✅ ALREADY REGISTERED!\n\n` +
                `📱 Phone: ${registered.phone}\n` +
                `💰 Balance: $${parseFloat(registered.user.wallet_balance).toFixed(2)}\n\n` +
                `Click below to auto-login:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }],
                            [{ text: '🎲 Play Keno', web_app: { url: `${BASE_URL}/keno.html?phone=${encodeURIComponent(registered.phone)}&auto=1` } }]
                        ]
                    }
                }
            );
        }
        
        sessions.set(userId, { 
            step: 'phone', 
            telegram_id: userId,
            telegram_username: ctx.from.username || 'telegram_user',
            referral_code: referralCode
        });
        
        await ctx.reply(
            '📱 WELCOME!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +
            'To register, please share your phone number using the button below.\n\n' +
            'This will only be used for your account.',
            {
                reply_markup: {
                    keyboard: [
                        [{ text: '📱 Share Phone Number', request_contact: true }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            }
        );
    } catch (err) {
        console.error('Register error:', err);
        ctx.reply('❌ Database error. Try again later.');
    }
});

// Handle shared contact
bot.on('contact', async (ctx) => {
    const session = sessions.get(ctx.from.id);
    const userId = ctx.from.id;
    const contact = ctx.message.contact;
    
    if (contact.user_id !== userId) {
        return ctx.reply('❌ Please share your own phone number.');
    }
    
    const phone = contact.phone_number;
    const telegramUsername = ctx.from.username || 'telegram_user';
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            await ctx.reply('✅ You are already registered!', { reply_markup: { remove_keyboard: true } });
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            return ctx.reply(
                `Click below to auto-login:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]
                        ]
                    }
                }
            );
        }
        
        const check = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        
        if (check.rows.length > 0) {
            await pool.query('INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1,$2,$3)', [userId, telegramUsername, phone]);
            await ctx.reply('✅ Phone number linked to your existing account!', { reply_markup: { remove_keyboard: true } });
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(phone)}&auto=1`;
            return ctx.reply(
                `Click below to auto-login:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]
                        ]
                    }
                }
            );
        }
        
        const userReferralCode = generateReferralCode(userId, phone);
        
        await pool.query(
            'INSERT INTO users (phone, password, wallet_balance, referral_code) VALUES ($1,$2,$3,$4)',
            [phone, 'telegram123', 100.00, userReferralCode]
        );
        
        await pool.query(
            'INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1,$2,$3)',
            [userId, telegramUsername, phone]
        );
        
        // Record referral if provided
        if (session?.referral_code) {
            const referrer = await pool.query('SELECT phone FROM users WHERE referral_code = $1', [session.referral_code]);
            if (referrer.rows.length > 0) {
                await pool.query(
                    'INSERT INTO referrals (referrer_phone, referred_phone, bonus_amount, bonus_awarded) VALUES ($1,$2,$3,false)',
                    [referrer.rows[0].phone, phone, 10.00]
                );
                console.log(`🔗 Referral recorded: ${referrer.rows[0].phone} referred ${phone}`);
            }
        }
        
        await ctx.reply('✅ Registration successful!', { reply_markup: { remove_keyboard: true } });
        
        const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(phone)}&auto=1`;
        
        await ctx.reply(
            `🎉 YOUR ACCOUNT IS READY!\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📱 Phone: ${phone}\n` +
            `💰 Balance: $100.00\n` +
            `🎲 Referral Code: ${userReferralCode}\n\n` +
            `💡 Share your code with friends! You get $10 when they make their first deposit.\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Click below to start playing!`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀 Start Playing', web_app: { url: autoLoginUrl } }],
                        [{ text: '🎲 Play Keno', web_app: { url: `${BASE_URL}/keno.html?phone=${encodeURIComponent(phone)}&auto=1` } }],
                        [{ text: '👥 My Referrals', callback_data: 'view_referrals' }]
                    ]
                }
            }
        );
        
        sessions.delete(ctx.from.id);
    } catch (err) {
        console.error('Contact handler error:', err);
        ctx.reply('❌ Registration failed. Please try again.', { reply_markup: { remove_keyboard: true } });
    }
});

// /play command
bot.command('play', async (ctx) => {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (registered.registered) {
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            return ctx.reply(
                `🎮 GAME MENU\n\nChoose your game:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🏇 Horse Racing', web_app: { url: autoLoginUrl } }],
                            [{ text: '🎲 Keno', web_app: { url: `${BASE_URL}/keno.html?phone=${encodeURIComponent(registered.phone)}&auto=1` } }]
                        ]
                    }
                }
            );
        }
        ctx.reply('❌ Not registered. Use /register first');
    } catch (err) {
        console.error('Play error:', err);
        ctx.reply('❌ Database error. Try again later.');
    }
});

// /balance command
bot.command('balance', async (ctx) => {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (registered.registered) {
            return ctx.reply(
                `💰 YOUR BALANCE\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `📱 Phone: ${registered.phone}\n` +
                `💰 Balance: $${parseFloat(registered.user.wallet_balance).toFixed(2)}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🎮 Play Now', callback_data: 'play_now' }]
                        ]
                    }
                }
            );
        }
        ctx.reply('❌ Not registered. Use /register first');
    } catch (err) {
        console.error('Balance error:', err);
        ctx.reply('❌ Error fetching balance');
    }
});

bot.action('play_now', async (ctx) => {
    ctx.deleteMessage();
    const registered = await isUserRegistered(ctx.from.id);
    if (registered.registered) {
        const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
        await ctx.reply(
            `🎮 Choose your game:`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏇 Horse Racing', web_app: { url: autoLoginUrl } }],
                        [{ text: '🎲 Keno', web_app: { url: `${BASE_URL}/keno.html?phone=${encodeURIComponent(registered.phone)}&auto=1` } }]
                    ]
                }
            }
        );
    }
});

bot.action('cancel', (ctx) => {
    sessions.delete(ctx.from.id);
    ctx.editMessageText('❌ Cancelled');
});

bot.catch((err, ctx) => {
    console.error('❌ Bot error:', err);
});

// Launch bot
bot.launch().then(() => {
    console.log(`${colors.green}✅ Telegram bot started successfully!${colors.reset}`);
}).catch((err) => {
    console.log(`${colors.red}❌ Failed to start Telegram bot:${colors.reset}`, err.message);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ============================================
// HORSE RACING GAME (SOCKET.IO)
// ============================================

io.on('connection', (socket) => {
    console.log(`${colors.green}🔌 New client connected - Socket ID: ${socket.id}${colors.reset}`);
    
    socket.on('request-timer', () => {
        const now = Date.now();
        const nextRaceTime = Math.ceil(now / 6000) * 6000;
        const currentGameId = `GAME-${Math.floor(nextRaceTime / 1000).toString().slice(-6)}`;
        
        socket.emit('race-timer', { nextRaceTime, gameId: currentGameId });
        
        const timerInterval = setInterval(() => {
            const timeToNext = nextRaceTime - Date.now();
            if (timeToNext <= 5000 && timeToNext > 0) {
                socket.emit('race-starting-soon', { gameId: currentGameId });
            }
            if (timeToNext <= 0) {
                clearInterval(timerInterval);
                socket.emit('race-started', { gameId: currentGameId });
                const game = gameSessions.get(currentGameId);
                if (game && game.status === 'waiting') startRace(currentGameId);
            }
        }, 1000);
        
        socket.on('disconnect', () => clearInterval(timerInterval));
    });
    
    socket.on('join-game', (data) => {
        const { gameId, phone, horseNumber, betAmount } = data;
        socket.join(`game-${gameId}`);
        
        if (!gameSessions.has(gameId)) {
            gameSessions.set(gameId, {
                id: gameId,
                players: [],
                startTime: null,
                status: 'waiting',
                winningHorse: null
            });
        }
        
        const game = gameSessions.get(gameId);
        if (!game.players.find(p => p.phone === phone)) {
            game.players.push({
                socketId: socket.id,
                phone,
                horseNumber: parseInt(horseNumber),
                betAmount: parseFloat(betAmount)
            });
        }
        
        io.to(`game-${gameId}`).emit('player-count-update', { count: game.players.length });
    });
    
    socket.on('start-race', (gameId) => startRace(gameId));
    
    socket.on('disconnect', () => {
        gameSessions.forEach((game, gameId) => {
            const idx = game.players.findIndex(p => p.socketId === socket.id);
            if (idx !== -1) {
                game.players.splice(idx, 1);
                io.to(`game-${gameId}`).emit('player-count-update', { count: game.players.length });
            }
        });
    });
});

function startRace(gameId) {
    const game = gameSessions.get(gameId);
    if (!game || game.status !== 'waiting') return;
    game.status = 'racing';
    game.startTime = Date.now();
    game.winningHorse = Math.floor(Math.random() * 6) + 1;
    io.to(`game-${gameId}`).emit('race-started', { winningHorse: game.winningHorse, startTime: game.startTime });
    setTimeout(() => finishRace(gameId), 8000);
}

async function finishRace(gameId) {
    const game = gameSessions.get(gameId);
    if (!game || game.status !== 'racing') return;
    game.status = 'finished';
    
    const results = game.players.map(player => ({
        phone: player.phone,
        horseNumber: player.horseNumber,
        won: player.horseNumber === game.winningHorse,
        winAmount: player.horseNumber === game.winningHorse ? player.betAmount * 4.5 : 0
    }));
    
    for (const result of results) {
        if (result.won) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone = $2', [result.winAmount, result.phone]);
                const updated = await client.query('SELECT wallet_balance FROM users WHERE phone = $1', [result.phone]);
                await client.query('COMMIT');
                const playerSocket = game.players.find(p => p.phone === result.phone)?.socketId;
                if (playerSocket) {
                    io.to(playerSocket).emit('balance-update', { newBalance: parseFloat(updated.rows[0].wallet_balance) });
                }
            } catch(e) { await client.query('ROLLBACK'); } finally { client.release(); }
        }
    }
    
    io.to(`game-${gameId}`).emit('race-finished', { gameId, winningHorse: game.winningHorse, results });
    setTimeout(() => gameSessions.delete(gameId), 30000);
}

// ============================================
// EXPRESS ROUTES
// ============================================

app.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, error: 'Missing credentials' });
    try {
        const user = await pool.query('SELECT * FROM users WHERE phone = $1', [phone.trim()]);
        if (user.rows.length === 0 || user.rows[0].password !== password) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        res.json({ success: true, user: { id: user.rows[0].id, phone: user.rows[0].phone, wallet_balance: parseFloat(user.rows[0].wallet_balance) } });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/validate-telegram-token', async (req, res) => {
    try {
        const decoded = Buffer.from(req.body.token, 'base64').toString('ascii').split(':');
        const [phone, userId, timestamp] = decoded;
        if (Date.now() - parseInt(timestamp) > 300000) return res.json({ success: false, error: 'Token expired' });
        const user = await pool.query('SELECT * FROM users WHERE phone = $1 AND id = $2', [phone, userId]);
        if (user.rows.length === 0) return res.json({ success: false, error: 'Invalid token' });
        res.json({ success: true, user: { id: user.rows[0].id, phone: user.rows[0].phone, wallet_balance: parseFloat(user.rows[0].wallet_balance) } });
    } catch(e) { res.json({ success: false, error: 'Invalid token' }); }
});

app.get('/wallet/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT wallet_balance FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ balance: parseFloat(user.rows[0].wallet_balance) });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/bet', async (req, res) => {
    const { phone, horseNumber, betAmount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await client.query('SELECT * FROM users WHERE phone = $1 FOR UPDATE', [phone]);
        if (user.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        const balance = parseFloat(user.rows[0].wallet_balance);
        if (balance < betAmount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }); }
        await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone = $2', [betAmount, phone]);
        const bet = await client.query('INSERT INTO bets (user_id, horse_number, bet_amount) VALUES ($1,$2,$3) RETURNING id', [user.rows[0].id, horseNumber, betAmount]);
        await client.query('COMMIT');
        const gameId = `GAME-${Math.floor(Date.now() / 60000).toString().slice(-6)}`;
        res.json({ success: true, betId: bet.rows[0].id, newBalance: balance - betAmount, gameId });
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.get('/user/referrals/:phone', async (req, res) => {
    try {
        const stats = await getReferralStats(req.params.phone);
        const referrals = await pool.query('SELECT referred_phone, created_at, bonus_amount, bonus_awarded FROM referrals WHERE referrer_phone = $1', [req.params.phone]);
        res.json({ success: true, total_referrals: stats.total_referrals, total_bonus: stats.total_bonus, referrals: referrals.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/login', (req, res) => {
    if (req.body.username === 'admin' && req.body.password === 'admin123') res.json({ success: true });
    else res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/admin/bets', async (req, res) => {
    try {
        const bets = await pool.query('SELECT horse_number, COALESCE(SUM(bet_amount),0) as total_bet FROM bets WHERE created_at >= CURRENT_DATE GROUP BY horse_number');
        const result = Array(6).fill(0).map((_, i) => ({ horse: i+1, total: bets.rows.find(r => r.horse_number === i+1)?.total_bet || 0 }));
        res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/members', async (req, res) => {
    try {
        const members = await pool.query('SELECT phone, wallet_balance, created_at, total_deposits, total_referrals FROM users ORDER BY id');
        res.json(members.rows.map(m => ({ ...m, wallet_balance: parseFloat(m.wallet_balance), total_deposits: parseFloat(m.total_deposits) })));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/add-balance', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT total_deposits FROM users WHERE phone = $1', [req.body.phone]);
        if (before.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        const wasFirst = before.rows[0].total_deposits === 0;
        await client.query('UPDATE users SET wallet_balance = wallet_balance + $1, total_deposits = total_deposits + $2 WHERE phone = $3', [req.body.amount, req.body.amount, req.body.phone]);
        if (wasFirst && req.body.amount > 0) {
            const referral = await client.query('SELECT * FROM referrals WHERE referred_phone = $1 AND bonus_awarded = FALSE', [req.body.phone]);
            if (referral.rows.length > 0) {
                await client.query('UPDATE users SET wallet_balance = wallet_balance + 10, total_referrals = total_referrals + 1 WHERE phone = $1', [referral.rows[0].referrer_phone]);
                await client.query('UPDATE referrals SET bonus_awarded = TRUE, bonus_awarded_at = NOW() WHERE id = $1', [referral.rows[0].id]);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.get('/admin/withdrawals', async (req, res) => {
    try {
        const withdrawals = await pool.query('SELECT w.id, u.phone, w.amount, w.status, w.created_at FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = "pending"');
        res.json(withdrawals.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/approve-withdraw', async (req, res) => {
    try {
        await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [req.body.action === 'approve' ? 'paid' : 'rejected', req.body.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/test', (req, res) => res.json({ message: 'Server running!', activeGames: gameSessions.size }));

app.get('/user/info/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT created_at, wallet_balance FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) return res.status(404).json({ success: false });
        res.json({ success: true, created_at: user.rows[0].created_at, wallet_balance: parseFloat(user.rows[0].wallet_balance) });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/delete-member', async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE phone = $1', [req.body.phone]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// KENO GAME BACKEND
// ============================================

let currentGameNumber = 123213;
let currentGameId = `KENO-${currentGameNumber}`;
let currentDrawnNumbers = null;
let roundPhase = 'betting';
let phaseStartTime = Date.now();
let roundBets = [];

const BETTING_DURATION = 30000;
const DRAWING_DURATION = 30000;
const RESULTS_DURATION = 5000;

let roundTimer = null;

function drawNumbers() {
    const numbers = [];
    const isSpecial = currentGameNumber % 5 === 0;
    if (isSpecial) numbers.push(66, 14);
    while (numbers.length < 20) {
        const num = Math.floor(Math.random() * 80) + 1;
        if (!numbers.includes(num)) numbers.push(num);
    }
    return numbers.sort((a, b) => a - b);
}

function calculatePayout(selectedCount, matches, betAmount) {
    const multipliers = {
        1: {1: 2.5}, 2: {2: 12, 1: 1.5}, 3: {3: 45, 2: 4, 1: 1.2},
        4: {4: 150, 3: 12, 2: 2.5, 1: 1}, 5: {5: 400, 4: 35, 3: 7, 2: 2, 1: 1},
        6: {6: 1000, 5: 100, 4: 20, 3: 5, 2: 2, 1: 1},
        7: {7: 2500, 6: 250, 5: 50, 4: 12, 3: 3, 2: 1.5},
        8: {8: 5000, 7: 500, 6: 100, 5: 25, 4: 6, 3: 2},
        9: {9: 10000, 8: 1000, 7: 200, 6: 50, 5: 12, 4: 4},
        10: {10: 20000, 9: 2000, 8: 400, 7: 100, 6: 25, 5: 6, 4: 2}
    };
    return betAmount * (multipliers[selectedCount]?.[matches] || 0);
}

async function processRoundResults() {
    console.log(`\n📊 Processing results for ${currentGameId}`);
    for (const bet of roundBets) {
        const matches = bet.selectedNumbers.filter(n => currentDrawnNumbers.includes(n)).length;
        const winAmount = calculatePayout(bet.selectedNumbers.length, matches, bet.betAmount);
        if (winAmount > 0) {
            await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [winAmount, bet.userId]);
        }
        await pool.query(`UPDATE bets SET win_amount = $1, won = $2, drawn_numbers = $3 WHERE id = $4`, [winAmount, winAmount > 0, currentDrawnNumbers, bet.betId]);
    }
}

function startDrawingPhase() {
    roundPhase = 'drawing';
    phaseStartTime = Date.now();
    currentDrawnNumbers = drawNumbers();
    console.log(`🎨 Drawing phase: ${currentGameId} - Numbers: ${currentDrawnNumbers.join(', ')}`);
    roundTimer = setTimeout(() => startResultsPhase(), DRAWING_DURATION);
}

async function startResultsPhase() {
    roundPhase = 'results';
    phaseStartTime = Date.now();
    await processRoundResults();
    roundTimer = setTimeout(() => startNextRound(), RESULTS_DURATION);
}

function startNextRound() {
    currentGameNumber++;
    currentGameId = `KENO-${currentGameNumber}`;
    currentDrawnNumbers = null;
    roundPhase = 'betting';
    phaseStartTime = Date.now();
    roundBets = [];
    console.log(`🎲 New round: ${currentGameId} - Betting phase`);
    roundTimer = setTimeout(() => startDrawingPhase(), BETTING_DURATION);
}

// Start the first round
startNextRound();

// Keno endpoints
app.get('/keno/state', (req, res) => {
    const elapsed = Date.now() - phaseStartTime;
    let timeLeft = 0;
    if (roundPhase === 'betting') timeLeft = Math.max(0, Math.floor((BETTING_DURATION - elapsed) / 1000));
    else if (roundPhase === 'drawing') timeLeft = Math.max(0, Math.floor((DRAWING_DURATION - elapsed) / 1000));
    else timeLeft = Math.max(0, Math.floor((RESULTS_DURATION - elapsed) / 1000));
    
    res.json({
        success: true,
        gameId: currentGameId,
        gameNumber: currentGameNumber,
        phase: roundPhase,
        timeLeft: timeLeft,
        isSpecial: currentGameNumber % 5 === 0,
        drawnNumbers: (roundPhase === 'drawing' || roundPhase === 'results') ? currentDrawnNumbers : null
    });
});

app.post('/keno/bet', async (req, res) => {
    const { phone, selectedNumbers, betAmount } = req.body;
    if (!selectedNumbers || selectedNumbers.length < 1 || selectedNumbers.length > 10) {
        return res.status(400).json({ error: 'Select 1-10 numbers' });
    }
    if (roundPhase !== 'betting') {
        return res.status(400).json({ error: `Betting closed! Current phase: ${roundPhase}` });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await client.query('SELECT * FROM users WHERE phone = $1 FOR UPDATE', [phone]);
        if (user.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        const balance = parseFloat(user.rows[0].wallet_balance);
        if (balance < betAmount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }); }
        await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [betAmount, user.rows[0].id]);
        const betResult = await client.query(
            `INSERT INTO bets (user_id, game_id, bet_amount, selected_numbers, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
            [user.rows[0].id, currentGameId, betAmount, selectedNumbers]
        );
        roundBets.push({ betId: betResult.rows[0].id, userId: user.rows[0].id, phone, selectedNumbers, betAmount });
        await client.query('COMMIT');
        res.json({ success: true, newBalance: balance - betAmount, gameId: currentGameId });
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.get('/keno/history/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT id FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const history = await pool.query(`SELECT * FROM bets WHERE user_id = $1 AND game_id LIKE 'KENO-%' ORDER BY created_at DESC LIMIT 20`, [user.rows[0].id]);
        res.json(history.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// DEPOSIT SYSTEM
// ============================================

async function createDepositsTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS deposits (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                phone VARCHAR(20) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                transaction_id VARCHAR(100) UNIQUE NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                approved_at TIMESTAMP,
                approved_by VARCHAR(50)
            )
        `);
        console.log(`${colors.green}✅ Deposits table ready${colors.reset}`);
    } catch(e) { console.error('Deposits table error:', e); }
}
createDepositsTable();

app.post('/deposit/request', async (req, res) => {
    const { phone, amount, transactionId } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!transactionId) return res.status(400).json({ error: 'Transaction ID required' });
    try {
        const user = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const existing = await pool.query('SELECT * FROM deposits WHERE transaction_id = $1', [transactionId]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Transaction ID exists' });
        await pool.query('INSERT INTO deposits (user_id, phone, amount, transaction_id) VALUES ($1,$2,$3,$4)', [user.rows[0].id, phone, amount, transactionId]);
        res.json({ success: true, message: 'Deposit request submitted' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/deposits', async (req, res) => {
    try {
        const deposits = await pool.query('SELECT d.*, u.wallet_balance FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = "pending"');
        res.json(deposits.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/approve-deposit', async (req, res) => {
    const { depositId, action } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const deposit = await client.query('SELECT * FROM deposits WHERE id = $1 AND status = "pending"', [depositId]);
        if (deposit.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }); }
        if (action === 'approve') {
            await client.query('UPDATE users SET wallet_balance = wallet_balance + $1, total_deposits = total_deposits + $2 WHERE id = $3', [deposit.rows[0].amount, deposit.rows[0].amount, deposit.rows[0].user_id]);
            await client.query('UPDATE deposits SET status = "approved", approved_at = NOW(), approved_by = $1 WHERE id = $2', ['admin', depositId]);
            const referral = await client.query('SELECT * FROM referrals WHERE referred_phone = $1 AND bonus_awarded = FALSE', [deposit.rows[0].phone]);
            if (referral.rows.length > 0) {
                await client.query('UPDATE users SET wallet_balance = wallet_balance + 10, total_referrals = total_referrals + 1 WHERE phone = $1', [referral.rows[0].referrer_phone]);
                await client.query('UPDATE referrals SET bonus_awarded = TRUE, bonus_awarded_at = NOW() WHERE id = $1', [referral.rows[0].id]);
            }
        } else {
            await client.query('UPDATE deposits SET status = "rejected", approved_at = NOW(), approved_by = $1 WHERE id = $2', ['admin', depositId]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { client.release(); }
});

app.get('/deposit/history/:phone', async (req, res) => {
    try {
        const history = await pool.query('SELECT * FROM deposits WHERE phone = $1 ORDER BY created_at DESC LIMIT 20', [req.params.phone]);
        res.json(history.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.green}🚀 SERVER STARTED SUCCESSFULLY!${colors.reset}`);
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}📡 Server URL: http://localhost:${PORT}${colors.reset}`);
    console.log(`${colors.cyan}👤 User login: http://localhost:${PORT}/login.html${colors.reset}`);
    console.log(`${colors.cyan}👑 Admin login: http://localhost:${PORT}/admin-login.html${colors.reset}`);
    console.log(`${colors.cyan}🎲 Keno starting from: KENO-123213${colors.reset}`);
    console.log(`${colors.cyan}🤖 Telegram bot: @${bot.botInfo?.username || 'ALPHA_ALLGAME_BOT'}${colors.reset}`);
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
});