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

// Color codes for better console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

// PostgreSQL connection for Render
const pool = new Pool({
    user: process.env.DB_USER || 'horse_racing_user',
    host: process.env.DB_HOST || 'dpg-d6tam96uk2gs738n6p0g-a.oregon-postgres.render.com',
    database: process.env.DB_NAME || 'horse_racing',
    password: process.env.DB_PASSWORD || 'N13aDz5NfsJLcmkzVrlmkG9G7254nS6z',
    port: process.env.DB_PORT || 5432,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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

// Your new bot token
const BOT_TOKEN = '8377238725:AAHbdKSHJfJRepL2Jzhab0qcOnIVGzN2HRU';

// Store registration sessions
const sessions = new Map();

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://horse-racing-pu5g.onrender.com';

console.log(`${colors.cyan}🤖 Initializing Telegram bot...${colors.reset}`);
console.log(`${colors.cyan}📡 Bot Base URL: ${BASE_URL}${colors.reset}`);

// Phone validation
const isValidPhone = (phone) => /^[\+]?[(]?[0-9]{1,3}[)]?[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,9}$/.test(phone);
const cleanPhone = (phone) => phone.replace(/[\s\-\(\)]/g, '');

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
        console.error('Error getting referral stats:', err);
        return { total_referrals: 0, total_bonus: 0 };
    }
}

// Check if user is registered
async function isUserRegistered(telegramId) {
    try {
        const linkCheck = await pool.query(
            'SELECT * FROM telegram_links WHERE telegram_id = $1',
            [telegramId]
        );
        
        if (linkCheck.rows.length > 0) {
            const userCheck = await pool.query(
                'SELECT * FROM users WHERE phone = $1',
                [linkCheck.rows[0].phone]
            );
            if (userCheck.rows.length > 0) {
                return { 
                    registered: true, 
                    user: userCheck.rows[0], 
                    phone: linkCheck.rows[0].phone 
                };
            }
        }
    } catch (err) {
        console.error('Error checking registration:', err);
    }
    return { registered: false };
}

// /start command
bot.start(async (ctx) => {
    const messageText = ctx.message.text;
    let referralCode = null;
    
    const parts = messageText.split(' ');
    if (parts.length > 1) {
        referralCode = parts[1];
        console.log('🔗 Referral code detected:', referralCode);
        
        sessions.set(ctx.from.id, { 
            referral_code: referralCode,
            step: 'start'
        });
    }
    
    ctx.reply(
        '🐎 Horse Racing Bet Bot\n\n' +
        'Commands:\n' +
        '/register - Create new account\n' +
        '/play - Auto-login to app\n' +
        '/balance - Check wallet balance\n' +
        '/invite - Get your referral link\n' +
        '/referrals - View your referrals\n' +
        '/help - Show this menu'
    );
});

// /help command
bot.help((ctx) => {
    ctx.reply(
        'Available commands:\n' +
        '/register - Register new account\n' +
        '/play - Auto-login to app\n' +
        '/balance - Check your balance\n' +
        '/invite - Get your referral link\n' +
        '/referrals - View your referrals\n' +
        '/cancel - Cancel registration'
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
        
        const userData = await pool.query(
            'SELECT referral_code FROM users WHERE phone = $1',
            [registered.phone]
        );
        
        const referralCode = userData.rows[0].referral_code;
        const inviteLink = `https://t.me/${botUsername}?start=${referralCode}`;
        
        const awarded = await pool.query(
            'SELECT COUNT(*) as count FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE',
            [registered.phone]
        );
        
        const pending = await pool.query(
            'SELECT COUNT(*) as count FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = FALSE',
            [registered.phone]
        );
        
        const bonus = await pool.query(
            'SELECT COALESCE(SUM(bonus_amount), 0) as total FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE',
            [registered.phone]
        );
        
        await ctx.reply(
            `👥 Your Referral Program\n\n` +
            `Share this link:\n${inviteLink}\n\n` +
            `Statistics:\n` +
            `• Awarded Referrals: ${awarded.rows[0].count}\n` +
            `• Pending Referrals: ${pending.rows[0].count}\n` +
            `• Total Bonus Earned: $${parseFloat(bonus.rows[0].total).toFixed(2)}\n\n` +
            `You get $10 for each friend who makes their first deposit!`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 View Details', callback_data: 'view_referrals' }]
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
            FROM referrals 
            WHERE referrer_phone = $1 AND bonus_awarded = TRUE
            ORDER BY bonus_awarded_at DESC
        `, [registered.phone]);
        
        const pending = await pool.query(`
            SELECT referred_phone, created_at 
            FROM referrals 
            WHERE referrer_phone = $1 AND bonus_awarded = FALSE
            ORDER BY created_at DESC
        `, [registered.phone]);
        
        let message = `👥 Your Referrals\n\n`;
        
        message += `✅ Awarded (${awarded.rows.length}):\n`;
        if (awarded.rows.length > 0) {
            awarded.rows.forEach((ref, i) => {
                const date = new Date(ref.bonus_awarded_at).toLocaleDateString();
                message += `  ${i+1}. ${ref.referred_phone} - $${ref.bonus_amount} (${date})\n`;
            });
        } else {
            message += `  None yet\n`;
        }
        
        message += `\n⏳ Pending (${pending.rows.length}):\n`;
        if (pending.rows.length > 0) {
            pending.rows.forEach((ref, i) => {
                const date = new Date(ref.created_at).toLocaleDateString();
                message += `  ${i+1}. ${ref.referred_phone} (registered ${date})\n`;
            });
            message += `\nPending referrals will award $10 when they make their first deposit!`;
        } else {
            message += `  None\n`;
        }
        
        await ctx.reply(message);
        
    } catch (err) {
        console.error('View referrals error:', err);
        ctx.reply('❌ Error loading referrals');
    }
}

// /register command
bot.command('register', async (ctx) => {
    const userId = ctx.from.id;
    
    let referralCode = null;
    const existingSession = sessions.get(userId);
    if (existingSession && existingSession.referral_code) {
        referralCode = existingSession.referral_code;
    }
    
    const messageText = ctx.message.text;
    const parts = messageText.split(' ');
    if (parts.length > 1) {
        referralCode = parts[1].trim();
    }
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            
            return ctx.reply(
                `✅ You are already registered!\n\n` +
                `Phone: ${registered.phone}\n` +
                `Balance: $${parseFloat(registered.user.wallet_balance).toFixed(2)}\n\n` +
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
        
        sessions.set(userId, { 
            step: 'phone', 
            telegram_id: userId,
            telegram_username: ctx.from.username || 'telegram_user',
            referral_code: referralCode
        });
        
        await ctx.reply(
            '📱 Welcome!\n\n' +
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
            await ctx.reply('✅ You are already registered!', {
                reply_markup: { remove_keyboard: true }
            });
            
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
        
        const check = await pool.query(
            'SELECT * FROM users WHERE phone = $1',
            [phone]
        );
        
        if (check.rows.length > 0) {
            await pool.query(
                'INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1, $2, $3)',
                [userId, telegramUsername, phone]
            );
            
            await ctx.reply('✅ Phone number linked to your existing account!', {
                reply_markup: { remove_keyboard: true }
            });
            
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
        
        const userInsert = await pool.query(
            'INSERT INTO users (phone, password, wallet_balance, referral_code) VALUES ($1, $2, $3, $4) RETURNING *',
            [phone, 'telegram123', 100.00, userReferralCode]
        );
        
        console.log('✅ New user created:', userInsert.rows[0]);
        
        await pool.query(
            'INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1, $2, $3)',
            [userId, telegramUsername, phone]
        );
        
        // RECORD REFERRAL IF PROVIDED (BUT DON'T AWARD BONUS YET)
        if (session && session.referral_code) {
            console.log('🔗 Referral code provided:', session.referral_code);
            
            const referrer = await pool.query(
                'SELECT phone FROM users WHERE referral_code = $1',
                [session.referral_code]
            );
            
            if (referrer.rows.length > 0) {
                const referrerPhone = referrer.rows[0].phone;
                
                await pool.query(
                    'INSERT INTO referrals (referrer_phone, referred_phone, bonus_amount, bonus_awarded) VALUES ($1, $2, $3, $4)',
                    [referrerPhone, phone, 10.00, false]
                );
                
                console.log(`🔗 Referral recorded: ${referrerPhone} referred ${phone} (bonus pending first deposit)`);
            }
        }
        
        await ctx.reply('✅ Registration successful!', {
            reply_markup: { remove_keyboard: true }
        });
        
        const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(phone)}&auto=1`;
        
        await ctx.reply(
            `Your account is ready!\n\n` +
            `Phone: ${phone}\n` +
            `Balance: $100.00\n\n` +
            `Your Referral Code: ${userReferralCode}\n\n` +
            `Share your code with friends! You get $10 when they make their first deposit.\n\n` +
            `Click below to start playing:`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀 Start Playing', web_app: { url: autoLoginUrl } }],
                        [{ text: '👥 My Referrals', callback_data: 'view_referrals' }]
                    ]
                }
            }
        );
        
        sessions.delete(ctx.from.id);
        
    } catch (err) {
        console.error('Contact handler error:', err);
        ctx.reply('❌ Registration failed. Please try again.', {
            reply_markup: { remove_keyboard: true }
        });
    }
});

bot.command('play', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            
            return ctx.reply(
                `Click below to auto-login:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 Play', web_app: { url: autoLoginUrl } }]
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

bot.command('balance', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            return ctx.reply(
                `💰 Your Balance\n\n` +
                `Phone: ${registered.phone}\n` +
                `Balance: $${parseFloat(registered.user.wallet_balance).toFixed(2)}`,
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
            `✅ Welcome back!\n\n` +
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

// Graceful stop for bot
process.once('SIGINT', () => bot?.stop('SIGINT'));
process.once('SIGTERM', () => bot?.stop('SIGTERM'));

// ============================================
// END OF TELEGRAM BOT INTEGRATION
// ============================================

// Socket.io connection
io.on('connection', (socket) => {
    console.log(`${colors.green}🔌 New client connected - Socket ID: ${socket.id}${colors.reset}`);
    
    socket.on('request-timer', () => {
        const now = Date.now();
        const nextRaceTime = Math.ceil(now / 6000) * 6000;
        const currentGameId = `GAME-${Math.floor(nextRaceTime / 1000).toString().slice(-6)}`;
        
        socket.emit('race-timer', {
            nextRaceTime: nextRaceTime,
            gameId: currentGameId
        });
        
        const timerInterval = setInterval(() => {
            const now = Date.now();
            const timeToNext = nextRaceTime - now;
            
            if (timeToNext <= 5000 && timeToNext > 0) {
                socket.emit('race-starting-soon', { gameId: currentGameId });
            }
            
            if (timeToNext <= 0) {
                clearInterval(timerInterval);
                socket.emit('race-started', { gameId: currentGameId });
                
                const game = gameSessions.get(currentGameId);
                if (game && game.status === 'waiting') {
                    startRace(currentGameId);
                }
            }
        }, 1000);
        
        socket.on('disconnect', () => {
            clearInterval(timerInterval);
        });
    });
    
    socket.on('join-game', (data) => {
        const { gameId, phone, horseNumber, betAmount } = data;
        socket.join(`game-${gameId}`);
        
        console.log(`${colors.cyan}👤 Player ${phone} joining game ${gameId} - Horse ${horseNumber}${colors.reset}`);
        
        if (!gameSessions.has(gameId)) {
            gameSessions.set(gameId, {
                id: gameId,
                players: [],
                startTime: null,
                status: 'waiting',
                winningHorse: null
            });
            console.log(`${colors.green}✅ New game session created: ${gameId}${colors.reset}`);
        }
        
        const game = gameSessions.get(gameId);
        
        const existingPlayer = game.players.find(p => p.phone === phone);
        if (!existingPlayer) {
            game.players.push({
                socketId: socket.id,
                phone,
                horseNumber: parseInt(horseNumber),
                betAmount: parseFloat(betAmount)
            });
        }
        
        console.log(`${colors.yellow}👥 Game ${gameId} now has ${game.players.length} players${colors.reset}`);
        
        io.to(`game-${gameId}`).emit('player-count-update', {
            count: game.players.length
        });
    });
    
    socket.on('start-race', (gameId) => {
        startRace(gameId);
    });
    
    socket.on('disconnect', () => {
        console.log(`${colors.yellow}🔌 Client disconnected - Socket ID: ${socket.id}${colors.reset}`);
        
        gameSessions.forEach((game, gameId) => {
            const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
            if (playerIndex !== -1) {
                const player = game.players[playerIndex];
                console.log(`${colors.yellow}👤 Player ${player.phone} removed from game ${gameId}${colors.reset}`);
                game.players.splice(playerIndex, 1);
                
                io.to(`game-${gameId}`).emit('player-count-update', {
                    count: game.players.length
                });
            }
        });
    });
});

function startRace(gameId) {
    const game = gameSessions.get(gameId);
    if (!game) {
        console.log(`${colors.red}❌ Game ${gameId} not found${colors.reset}`);
        return;
    }
    
    if (game.status === 'waiting') {
        game.status = 'racing';
        game.startTime = Date.now();
        
        const winningHorse = Math.floor(Math.random() * 6) + 1;
        game.winningHorse = winningHorse;
        
        console.log(`${colors.magenta}🏁 Race ${gameId} STARTED! Winning horse: ${winningHorse}${colors.reset}`);
        console.log(`${colors.yellow}👥 Players in race: ${game.players.length}${colors.reset}`);
        
        io.to(`game-${gameId}`).emit('race-started', {
            winningHorse: winningHorse,
            startTime: game.startTime
        });
        
        setTimeout(() => {
            finishRace(gameId);
        }, 8000);
    }
}

async function finishRace(gameId) {
    const game = gameSessions.get(gameId);
    if (!game || game.status !== 'racing') return;
    
    game.status = 'finished';
    
    console.log(`${colors.magenta}🏁 Race ${gameId} FINISHED! Winner: Horse ${game.winningHorse}${colors.reset}`);
    
    const results = game.players.map(player => {
        const won = player.horseNumber === game.winningHorse;
        const winAmount = won ? player.betAmount * 4.5 : 0;
        
        return {
            phone: player.phone,
            horseNumber: player.horseNumber,
            won: won,
            winAmount: winAmount
        };
    });
    
    for (const result of results) {
        if (result.won) {
            try {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    
                    await client.query(
                        'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone = $2',
                        [result.winAmount, result.phone]
                    );
                    
                    const updatedUser = await client.query(
                        'SELECT wallet_balance FROM users WHERE phone = $1',
                        [result.phone]
                    );
                    
                    await client.query('COMMIT');
                    
                    const newBalance = parseFloat(updatedUser.rows[0].wallet_balance);
                    console.log(`${colors.green}💰 Player ${result.phone} won $${result.winAmount.toFixed(2)} - New balance: $${newBalance.toFixed(2)}${colors.reset}`);
                    
                    const playerSocket = game.players.find(p => p.phone === result.phone)?.socketId;
                    if (playerSocket) {
                        io.to(playerSocket).emit('balance-update', {
                            newBalance: newBalance
                        });
                    }
                    
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
            } catch (error) {
                console.error(`${colors.red}❌ Error updating balance for ${result.phone}:${colors.reset}`, error.message);
            }
        }
    }
    
    io.to(`game-${gameId}`).emit('race-finished', {
        gameId: gameId,
        winningHorse: game.winningHorse,
        results: results
    });
    
    setTimeout(() => {
        gameSessions.delete(gameId);
        console.log(`${colors.yellow}🧹 Game ${gameId} cleaned up${colors.reset}`);
    }, 30000);
}

// ============================================
// EXPRESS ROUTES
// ============================================

app.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    const timestamp = new Date().toISOString();
    
    console.log(`${colors.cyan}📝 [${timestamp}] Login attempt for phone: ${phone}${colors.reset}`);
    
    if (!phone || phone.trim() === '' || !password || password.trim() === '') {
        console.log(`${colors.red}❌ Login failed: Missing credentials${colors.reset}`);
        return res.status(400).json({ 
            success: false, 
            error: 'Phone number and password are required' 
        });
    }

    try {
        const userResult = await pool.query(
            'SELECT * FROM users WHERE phone = $1', 
            [phone.trim()]
        );
        
        if (userResult.rows.length === 0) {
            console.log(`${colors.red}❌ Login failed: User not found - ${phone}${colors.reset}`);
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid phone number or password' 
            });
        }
        
        const user = userResult.rows[0];
        
        if (user.password !== password) {
            console.log(`${colors.red}❌ Login failed: Invalid password for ${phone}${colors.reset}`);
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid phone number or password' 
            });
        }
        
        console.log(`${colors.green}✅ USER LOGGED IN:${colors.reset}`);
        console.log(`  • Phone: ${user.phone}`);
        console.log(`  • Balance: $${parseFloat(user.wallet_balance).toFixed(2)}`);
        
        res.json({ 
            success: true, 
            user: {
                id: user.id,
                phone: user.phone,
                wallet_balance: parseFloat(user.wallet_balance)
            }
        });
        
    } catch (error) {
        console.log(`${colors.red}❌ Login error:${colors.reset}`, error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Server error during login' 
        });
    }
});

app.post('/validate-telegram-token', async (req, res) => {
    const { token } = req.body;
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('ascii');
        const [phone, userId, timestamp, random] = decoded.split(':');
        
        const now = Date.now();
        if (now - parseInt(timestamp) > 300000) {
            return res.json({ success: false, error: 'Token expired' });
        }
        
        const user = await pool.query(
            'SELECT * FROM users WHERE phone = $1 AND id = $2',
            [phone, userId]
        );
        
        if (user.rows.length === 0) {
            return res.json({ success: false, error: 'Invalid token' });
        }
        
        res.json({ 
            success: true, 
            user: {
                id: user.rows[0].id,
                phone: user.rows[0].phone,
                wallet_balance: parseFloat(user.rows[0].wallet_balance)
            }
        });
        
    } catch (error) {
        console.error('Token validation error:', error);
        res.json({ success: false, error: 'Invalid token' });
    }
});

app.get('/wallet/:phone', async (req, res) => {
    const { phone } = req.params;
    
    try {
        const user = await pool.query(
            'SELECT wallet_balance FROM users WHERE phone = $1', 
            [phone]
        );
        
        if (user.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ balance: parseFloat(user.rows[0].wallet_balance) });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bet', async (req, res) => {
    const { phone, horseNumber, betAmount } = req.body;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const userResult = await client.query(
            'SELECT * FROM users WHERE phone = $1 FOR UPDATE', 
            [phone]
        );
        
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        const currentBalance = parseFloat(user.wallet_balance);
        
        if (currentBalance < betAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        await client.query(
            'UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone = $2',
            [betAmount, phone]
        );
        
        const betResult = await client.query(
            'INSERT INTO bets (user_id, horse_number, bet_amount) VALUES ($1, $2, $3) RETURNING id',
            [user.id, horseNumber, betAmount]
        );
        
        await client.query('COMMIT');
        
        const gameId = `GAME-${Math.floor(Date.now() / 60000).toString().slice(-6)}`;
        
        console.log(`${colors.green}✅ Bet placed for ${phone} - Game ID: ${gameId}${colors.reset}`);
        
        res.json({ 
            success: true, 
            betId: betResult.rows[0].id,
            newBalance: currentBalance - betAmount,
            gameId: gameId
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`${colors.red}❌ Bet error:${colors.reset}`, error.message);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

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
        console.error('Error getting referral stats:', err);
        return { total_referrals: 0, total_bonus: 0 };
    }
}

// Get user referrals
app.get('/user/referrals/:phone', async (req, res) => {
    const { phone } = req.params;
    
    try {
        const stats = await getReferralStats(phone);
        
        const referrals = await pool.query(`
            SELECT referred_phone, created_at, bonus_amount, bonus_awarded, bonus_awarded_at 
            FROM referrals 
            WHERE referrer_phone = $1 
            ORDER BY created_at DESC
        `, [phone]);
        
        res.json({ 
            success: true,
            total_referrals: stats.total_referrals,
            total_bonus: stats.total_bonus,
            referrals: referrals.rows
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin routes
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === 'admin' && password === 'admin123') {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.get('/admin/bets', async (req, res) => {
    try {
        const bets = await pool.query(`
            SELECT horse_number, COALESCE(SUM(bet_amount), 0) as total_bet
            FROM bets 
            WHERE created_at >= CURRENT_DATE
            GROUP BY horse_number
            ORDER BY horse_number
        `);
        
        const result = Array(6).fill(0).map((_, i) => {
            const horseBet = bets.rows.find(r => r.horse_number === i + 1);
            return {
                horse: i + 1,
                total: horseBet ? parseFloat(horseBet.total_bet) : 0
            };
        });
        
        res.json(result);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/admin/members', async (req, res) => {
    try {
        const members = await pool.query(
            'SELECT phone, wallet_balance, created_at, total_deposits, total_referrals, referral_bonus FROM users ORDER BY id'
        );
        
        res.json(members.rows.map(m => ({
            ...m,
            wallet_balance: parseFloat(m.wallet_balance),
            total_deposits: parseFloat(m.total_deposits),
            referral_bonus: parseFloat(m.referral_bonus)
        })));
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin add balance - WITH REFERRAL BONUS ON ANY DEPOSIT
app.post('/admin/add-balance', async (req, res) => {
    const { phone, amount } = req.body;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const result = await client.query(
            'UPDATE users SET wallet_balance = wallet_balance + $1, total_deposits = total_deposits + $2 WHERE phone = $3 RETURNING *',
            [amount, amount, phone]
        );
        
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        const updatedUser = result.rows[0];
        
        console.log(`💰 Deposit detected for ${phone}, checking for pending referrals...`);
        
        const referralCheck = await client.query(
            'SELECT * FROM referrals WHERE referred_phone = $1 AND bonus_awarded = FALSE',
            [phone]
        );
        
        console.log(`🔍 Found ${referralCheck.rows.length} pending referrals`);
        
        if (referralCheck.rows.length > 0) {
            const referral = referralCheck.rows[0];
            const bonusAmount = 10.00;
            
            console.log(`🎁 Awarding referral bonus: ${referral.referrer_phone} gets $10 for referring ${phone}`);
            
            await client.query(
                'UPDATE users SET wallet_balance = wallet_balance + $1, referral_bonus = referral_bonus + $1, total_referrals = total_referrals + 1 WHERE phone = $2',
                [bonusAmount, referral.referrer_phone]
            );
            
            await client.query(
                'UPDATE referrals SET bonus_awarded = TRUE, bonus_awarded_at = NOW() WHERE id = $1',
                [referral.id]
            );
            
            console.log(`✅ Referral bonus awarded: ${referral.referrer_phone} got $${bonusAmount} from ${phone}'s deposit!`);
        }
        
        await client.query('COMMIT');
        
        res.json({ 
            success: true,
            user: {
                phone: updatedUser.phone,
                wallet_balance: parseFloat(updatedUser.wallet_balance),
                total_deposits: parseFloat(updatedUser.total_deposits)
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Add balance error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.get('/admin/withdrawals', async (req, res) => {
    try {
        const withdrawals = await pool.query(`
            SELECT w.id, u.phone, w.amount, w.status, w.created_at
            FROM withdrawals w
            JOIN users u ON w.user_id = u.id
            WHERE w.status = 'pending'
            ORDER BY w.created_at DESC
        `);
        
        res.json(withdrawals.rows.map(w => ({
            ...w,
            amount: parseFloat(w.amount)
        })));
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/admin/approve-withdraw', async (req, res) => {
    const { id, action } = req.body;
    
    try {
        await pool.query(
            'UPDATE withdrawals SET status = $1 WHERE id = $2',
            [action === 'approve' ? 'paid' : 'rejected', id]
        );
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test route
app.get('/test', (req, res) => {
    res.json({ 
        message: 'Server is running!',
        activeGames: gameSessions.size
    });
});

// Get user info (for registration time)
app.get('/user/info/:phone', async (req, res) => {
    const { phone } = req.params;
    
    try {
        const user = await pool.query(
            'SELECT created_at, wallet_balance, total_referrals FROM users WHERE phone = $1',
            [phone]
        );
        
        if (user.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        res.json({
            success: true,
            created_at: user.rows[0].created_at,
            wallet_balance: parseFloat(user.rows[0].wallet_balance),
            total_referrals: user.rows[0].total_referrals
        });
        
    } catch (error) {
        console.error('Error getting user info:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Admin delete member
app.post('/admin/delete-member', async (req, res) => {
    const { phone } = req.body;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const userCheck = await client.query(
            'SELECT id FROM users WHERE phone = $1',
            [phone]
        );
        
        if (userCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        await client.query(
            'DELETE FROM users WHERE phone = $1',
            [phone]
        );
        
        await client.query('COMMIT');
        
        console.log(`${colors.red}🗑️ Member deleted: ${phone}${colors.reset}`);
        
        res.json({ success: true });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete member error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
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
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
});