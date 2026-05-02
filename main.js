const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store active game sessions and user socket mapping
const gameSessions = new Map();
const userSockets = new Map(); // Track user sockets for real-time updates

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

// ============================================
// DATABASE CONNECTION - USING DATABASE_URL
// ============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
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

// Create tables if not exists
async function initDatabase() {
    console.log(`${colors.cyan}📋 Creating database tables if not exist...${colors.reset}`);
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(20) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                wallet_balance DECIMAL(10,2) DEFAULT 100.00,
                referral_code VARCHAR(50) UNIQUE,
                total_deposits DECIMAL(10,2) DEFAULT 0,
                total_referrals INT DEFAULT 0,
                referral_bonus DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bets (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                game_id VARCHAR(50),
                horse_number INTEGER,
                selected_numbers INTEGER[],
                bet_amount DECIMAL(10,2),
                win_amount DECIMAL(10,2) DEFAULT 0,
                won BOOLEAN DEFAULT FALSE,
                drawn_numbers INTEGER[],
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS referrals (
                id SERIAL PRIMARY KEY,
                referrer_phone VARCHAR(20),
                referred_phone VARCHAR(20),
                bonus_amount DECIMAL(10,2),
                bonus_awarded BOOLEAN DEFAULT FALSE,
                bonus_awarded_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS telegram_links (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE,
                telegram_username VARCHAR(100),
                phone VARCHAR(20)
            )
        `);
        
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
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                amount DECIMAL(10,2) NOT NULL,
                method VARCHAR(50),
                account VARCHAR(100),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log(`${colors.green}✅ All database tables ready${colors.reset}`);
    } catch (err) {
        console.error(`${colors.red}❌ Database init error:${colors.reset}`, err.message);
    }
}

// Initialize database
initDatabase();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================
// SOCKET.IO - Track user sockets for real-time updates
// ============================================
io.on('connection', (socket) => {
    console.log(`${colors.green}🔌 New client connected - Socket ID: ${socket.id}${colors.reset}`);
    
    // Register user socket for real-time balance updates
    socket.on('register-user', (phone) => {
        if (phone) {
            userSockets.set(phone, socket.id);
            console.log(`${colors.cyan}📱 User ${phone} registered to socket ${socket.id}${colors.reset}`);
        }
    });
    
    // Horse Racing Events
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
        // Remove user from socket mapping
        for (const [phone, socketId] of userSockets.entries()) {
            if (socketId === socket.id) {
                userSockets.delete(phone);
                console.log(`${colors.yellow}📱 User ${phone} unregistered${colors.reset}`);
                break;
            }
        }
        
        gameSessions.forEach((game, gameId) => {
            const idx = game.players.findIndex(p => p.socketId === socket.id);
            if (idx !== -1) {
                game.players.splice(idx, 1);
                io.to(`game-${gameId}`).emit('player-count-update', { count: game.players.length });
            }
        });
    });
});

// Helper function to emit balance update to user
async function emitBalanceUpdate(phone) {
    try {
        const result = await pool.query('SELECT wallet_balance FROM users WHERE phone = $1', [phone]);
        if (result.rows.length > 0) {
            const newBalance = parseFloat(result.rows[0].wallet_balance);
            const socketId = userSockets.get(phone);
            if (socketId) {
                io.to(socketId).emit('balance-update', { newBalance });
                console.log(`${colors.green}💰 Balance update sent to ${phone}: $${newBalance}${colors.reset}`);
            }
        }
    } catch (err) {
        console.error('Error sending balance update:', err);
    }
}

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
    
    const results = game.players.map(p => ({ 
        phone: p.phone, 
        horseNumber: p.horseNumber, 
        won: p.horseNumber === game.winningHorse, 
        winAmount: p.horseNumber === game.winningHorse ? p.betAmount * 4.5 : 0 
    }));
    
    for (const r of results) {
        if (r.won) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone = $2', [r.winAmount, r.phone]);
                await client.query('COMMIT');
                
                // Send real-time balance update
                await emitBalanceUpdate(r.phone);
                
                const psocket = game.players.find(p => p.phone === r.phone)?.socketId;
                if (psocket) {
                    io.to(psocket).emit('race-win', { winAmount: r.winAmount });
                }
            } catch(e) { 
                await client.query('ROLLBACK');
                console.error('Race finish error:', e);
            } finally { 
                client.release(); 
            }
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
    } catch(e) { 
        console.error('Login error:', e);
        res.status(500).json({ success: false, error: e.message }); 
    }
});

app.get('/wallet/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT wallet_balance FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ balance: parseFloat(user.rows[0].wallet_balance) });
    } catch(e) { 
        console.error('Wallet error:', e);
        res.status(500).json({ error: e.message }); 
    }
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
        
        // Send real-time balance update
        await emitBalanceUpdate(phone);
        
        const gameId = `GAME-${Math.floor(Date.now() / 60000).toString().slice(-6)}`;
        res.json({ success: true, betId: bet.rows[0].id, newBalance: balance - betAmount, gameId });
    } catch(e) { 
        await client.query('ROLLBACK'); 
        console.error('Bet error:', e);
        res.status(500).json({ error: e.message }); 
    } finally { 
        client.release(); 
    }
});

app.post('/validate-telegram-token', async (req, res) => {
    try {
        const decoded = Buffer.from(req.body.token, 'base64').toString('ascii').split(':');
        const [phone, userId, timestamp] = decoded;
        if (Date.now() - parseInt(timestamp) > 300000) return res.json({ success: false, error: 'Token expired' });
        const user = await pool.query('SELECT * FROM users WHERE phone = $1 AND id = $2', [phone, userId]);
        if (user.rows.length === 0) return res.json({ success: false, error: 'Invalid token' });
        res.json({ success: true, user: { id: user.rows[0].id, phone: user.rows[0].phone, wallet_balance: parseFloat(user.rows[0].wallet_balance) } });
    } catch(e) { 
        console.error('Token validation error:', e);
        res.json({ success: false, error: 'Invalid token' }); 
    }
});

app.get('/user/referrals/:phone', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) as total, COALESCE(SUM(bonus_amount),0) as bonus FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE', [req.params.phone]);
        const referrals = await pool.query('SELECT referred_phone, created_at, bonus_amount, bonus_awarded FROM referrals WHERE referrer_phone = $1', [req.params.phone]);
        res.json({ success: true, total_referrals: parseInt(result.rows[0].total), total_bonus: parseFloat(result.rows[0].bonus), referrals: referrals.rows });
    } catch(e) { 
        console.error('Referrals error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

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
        const bets = await pool.query('SELECT horse_number, COALESCE(SUM(bet_amount),0) as total_bet FROM bets WHERE created_at >= CURRENT_DATE GROUP BY horse_number');
        const result = Array(6).fill(0).map((_, i) => ({ horse: i+1, total: bets.rows.find(r => r.horse_number === i+1)?.total_bet || 0 }));
        res.json(result);
    } catch(e) { 
        console.error('Admin bets error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/admin/members', async (req, res) => {
    try {
        const members = await pool.query('SELECT phone, wallet_balance, created_at, total_deposits, total_referrals FROM users ORDER BY id DESC');
        res.json(members.rows.map(m => ({ 
            ...m, 
            wallet_balance: parseFloat(m.wallet_balance), 
            total_deposits: parseFloat(m.total_deposits || 0),
            total_referrals: parseInt(m.total_referrals || 0)
        })));
    } catch(e) { 
        console.error('Admin members error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/admin/add-balance', async (req, res) => {
    const { phone, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT total_deposits FROM users WHERE phone = $1', [phone]);
        if (before.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        const wasFirst = before.rows[0].total_deposits === 0;
        await client.query('UPDATE users SET wallet_balance = wallet_balance + $1, total_deposits = total_deposits + $2 WHERE phone = $3', [amount, amount, phone]);
        
        // Send real-time balance update
        await emitBalanceUpdate(phone);
        
        if (wasFirst && amount > 0) {
            const referral = await client.query('SELECT * FROM referrals WHERE referred_phone = $1 AND bonus_awarded = FALSE', [phone]);
            if (referral.rows.length > 0) {
                await client.query('UPDATE users SET wallet_balance = wallet_balance + 10, total_referrals = total_referrals + 1 WHERE phone = $1', [referral.rows[0].referrer_phone]);
                await client.query('UPDATE referrals SET bonus_awarded = TRUE, bonus_awarded_at = NOW() WHERE id = $1', [referral.rows[0].id]);
                // Send balance update to referrer
                await emitBalanceUpdate(referral.rows[0].referrer_phone);
                console.log(`🎁 Referral bonus awarded to ${referral.rows[0].referrer_phone}`);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { 
        await client.query('ROLLBACK');
        console.error('Add balance error:', e);
        res.status(500).json({ error: e.message }); 
    } finally { 
        client.release(); 
    }
});

app.get('/admin/withdrawals', async (req, res) => {
    try {
        const withdrawals = await pool.query('SELECT w.id, u.phone, w.amount, w.status, w.created_at FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = $1 ORDER BY w.created_at DESC', ['pending']);
        res.json(withdrawals.rows);
    } catch(e) { 
        console.error('Admin withdrawals error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/admin/approve-withdraw', async (req, res) => {
    const { id, action } = req.body;
    try {
        const status = action === 'approve' ? 'paid' : 'rejected';
        await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);
        res.json({ success: true });
    } catch(e) { 
        console.error('Approve withdraw error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/test', (req, res) => res.json({ message: 'Server running!', activeGames: gameSessions.size }));

app.get('/user/info/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT created_at, wallet_balance FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) return res.status(404).json({ success: false });
        res.json({ success: true, created_at: user.rows[0].created_at, wallet_balance: parseFloat(user.rows[0].wallet_balance) });
    } catch(e) { 
        console.error('User info error:', e);
        res.status(500).json({ success: false, error: e.message }); 
    }
});

app.post('/admin/delete-member', async (req, res) => {
    const { phone } = req.body;
    try {
        await pool.query('DELETE FROM users WHERE phone = $1', [phone]);
        res.json({ success: true });
    } catch(e) { 
        console.error('Delete member error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

// ============================================
// DEPOSIT SYSTEM
// ============================================

app.post('/deposit/request', async (req, res) => {
    const { phone, amount, transactionId } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!transactionId) return res.status(400).json({ error: 'Transaction ID required' });
    try {
        const user = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const existing = await pool.query('SELECT * FROM deposits WHERE transaction_id = $1', [transactionId]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Transaction ID already exists' });
        await pool.query('INSERT INTO deposits (user_id, phone, amount, transaction_id, status) VALUES ($1,$2,$3,$4,$5)', [user.rows[0].id, phone, amount, transactionId, 'pending']);
        res.json({ success: true, message: 'Deposit request submitted' });
    } catch(e) { 
        console.error('Deposit request error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/admin/deposits', async (req, res) => {
    try {
        const deposits = await pool.query('SELECT d.*, u.wallet_balance FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = $1 ORDER BY d.created_at ASC', ['pending']);
        res.json(deposits.rows);
    } catch(e) { 
        console.error('Admin deposits error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/admin/approve-deposit', async (req, res) => {
    const { depositId, action } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const deposit = await client.query('SELECT * FROM deposits WHERE id = $1 AND status = $2', [depositId, 'pending']);
        if (deposit.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }); }
        
        if (action === 'approve') {
            // Add balance to user
            await client.query('UPDATE users SET wallet_balance = wallet_balance + $1, total_deposits = total_deposits + $2 WHERE id = $3', 
                [deposit.rows[0].amount, deposit.rows[0].amount, deposit.rows[0].user_id]);
            
            // Send real-time balance update to user
            await emitBalanceUpdate(deposit.rows[0].phone);
            
            await client.query('UPDATE deposits SET status = $1, approved_at = NOW(), approved_by = $2 WHERE id = $3', 
                ['approved', 'admin', depositId]);
            
            // Check for referral bonus (first deposit)
            const referral = await client.query('SELECT * FROM referrals WHERE referred_phone = $1 AND bonus_awarded = FALSE', [deposit.rows[0].phone]);
            if (referral.rows.length > 0) {
                await client.query('UPDATE users SET wallet_balance = wallet_balance + 10, total_referrals = total_referrals + 1 WHERE phone = $1', 
                    [referral.rows[0].referrer_phone]);
                await client.query('UPDATE referrals SET bonus_awarded = TRUE, bonus_awarded_at = NOW() WHERE id = $1', 
                    [referral.rows[0].id]);
                await emitBalanceUpdate(referral.rows[0].referrer_phone);
                console.log(`🎁 Referral bonus awarded: ${referral.rows[0].referrer_phone} got $10`);
            }
        } else {
            await client.query('UPDATE deposits SET status = $1, approved_at = NOW(), approved_by = $2 WHERE id = $3', 
                ['rejected', 'admin', depositId]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { 
        await client.query('ROLLBACK');
        console.error('Approve deposit error:', e);
        res.status(500).json({ error: e.message }); 
    } finally { 
        client.release(); 
    }
});

app.get('/deposit/history/:phone', async (req, res) => {
    try {
        const history = await pool.query('SELECT * FROM deposits WHERE phone = $1 ORDER BY created_at DESC LIMIT 20', [req.params.phone]);
        res.json(history.rows);
    } catch(e) { 
        console.error('Deposit history error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/deposit/pending/:phone', async (req, res) => {
    try {
        const pending = await pool.query('SELECT * FROM deposits WHERE phone = $1 AND status = $2 ORDER BY created_at DESC', [req.params.phone, 'pending']);
        res.json(pending.rows);
    } catch(e) { 
        console.error('Pending deposits error:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/withdraw', async (req, res) => {
    const { phone, amount, method, account } = req.body;
    if (!amount || amount < 10) return res.status(400).json({ error: 'Minimum withdrawal is $10' });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await client.query('SELECT id, wallet_balance FROM users WHERE phone = $1 FOR UPDATE', [phone]);
        if (user.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        
        if (user.rows[0].wallet_balance < amount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Deduct balance immediately
        const newBalance = user.rows[0].wallet_balance - amount;
        await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.rows[0].id]);
        
        // Send real-time balance update
        await emitBalanceUpdate(phone);
        
        await client.query('INSERT INTO withdrawals (user_id, amount, method, account, status) VALUES ($1,$2,$3,$4,$5)', 
            [user.rows[0].id, amount, method, account, 'pending']);
        
        await client.query('COMMIT');
        res.json({ success: true, newBalance, message: 'Withdrawal request submitted' });
    } catch(e) { 
        await client.query('ROLLBACK');
        console.error('Withdraw error:', e);
        res.status(500).json({ error: e.message }); 
    } finally { 
        client.release(); 
    }
});

//// ============================================
// KENO GAME BACKEND - COMPLETELY FIXED
// ============================================

let currentKenoGameId = null;
let currentKenoGameNumber = 123213;
let currentKenoDrawnNumbers = null;
let kenoRoundActive = false;
let kenoRoundStartTime = null;
let kenoRoundTimer = null;
let kenoRoundBets = [];
let kenoRoundPhase = 'betting';

const KENO_BETTING_DURATION = 30000;
const KENO_DRAWING_DURATION = 30000;
const KENO_RESULTS_DURATION = 5000;

// KENO PAYOUT MULTIPLIERS (Standard)
const KENO_PAYOUTS = {
    1: {1: 2.5},
    2: {2: 12, 1: 1.5},
    3: {3: 45, 2: 4, 1: 1.2},
    4: {4: 150, 3: 12, 2: 2.5, 1: 1},
    5: {5: 400, 4: 35, 3: 7, 2: 2, 1: 1},
    6: {6: 1000, 5: 100, 4: 20, 3: 5, 2: 2, 1: 1},
    7: {7: 2500, 6: 250, 5: 50, 4: 12, 3: 3, 2: 1.5},
    8: {8: 5000, 7: 500, 6: 100, 5: 25, 4: 6, 3: 2},
    9: {9: 10000, 8: 1000, 7: 200, 6: 50, 5: 12, 4: 4},
    10: {10: 20000, 9: 2000, 8: 400, 7: 100, 6: 25, 5: 6, 4: 2}
};

function drawKenoNumbers(gameNumber) {
    const numbers = [];
    const isDivisibleBy5 = gameNumber % 5 === 0;
    if (isDivisibleBy5) numbers.push(66, 14);
    while (numbers.length < 20) {
        const num = Math.floor(Math.random() * 80) + 1;
        if (!numbers.includes(num)) numbers.push(num);
    }
    return numbers.sort((a, b) => a - b);
}

function calculateKenoPayout(selectedCount, matches, betAmount) {
    const multiplier = KENO_PAYOUTS[selectedCount]?.[matches] || 0;
    return betAmount * multiplier;
}

function startNewKenoRound() {
    if (kenoRoundTimer) clearTimeout(kenoRoundTimer);
    currentKenoGameNumber++;
    currentKenoGameId = `KENO-${currentKenoGameNumber}`;
    currentKenoDrawnNumbers = drawKenoNumbers(currentKenoGameNumber);
    kenoRoundActive = true;
    kenoRoundPhase = 'betting';
    kenoRoundStartTime = Date.now();
    kenoRoundBets = [];
    console.log(`🎲 NEW KENO ROUND: ${currentKenoGameId} - BETTING PHASE (30s)`);
    kenoRoundTimer = setTimeout(() => startDrawingPhase(), KENO_BETTING_DURATION);
}

function startDrawingPhase() {
    kenoRoundPhase = 'drawing';
    kenoRoundStartTime = Date.now();
    console.log(`🎨 KENO ROUND ${currentKenoGameId} - DRAWING PHASE (30s)`);
    kenoRoundTimer = setTimeout(() => startResultsPhase(), KENO_DRAWING_DURATION);
}

async function startResultsPhase() {
    kenoRoundPhase = 'results';
    console.log(`📊 KENO ROUND ${currentKenoGameId} - RESULTS PHASE (5s)`);
    
    // Process all bets in this round
    for (const bet of kenoRoundBets) {
        // Calculate matches
        const matches = bet.selected_numbers.filter(n => currentKenoDrawnNumbers.includes(n)).length;
        const winAmount = calculateKenoPayout(bet.selected_numbers.length, matches, bet.bet_amount);
        
        // Update bets table
        await pool.query(
            `UPDATE bets 
             SET win_amount = $1, 
                 won = $2, 
                 drawn_numbers = $3 
             WHERE id = $4`,
            [winAmount, winAmount > 0, currentKenoDrawnNumbers, bet.bet_id]
        );
        
        // Update user balance if won
        if (winAmount > 0) {
            await pool.query(
                'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
                [winAmount, bet.user_id]
            );
            // Send real-time balance update
            await emitBalanceUpdate(bet.phone);
            console.log(`💰 User ${bet.phone} won $${winAmount}`);
        }
    }
    
    kenoRoundTimer = setTimeout(() => {
        kenoRoundActive = false;
        startNewKenoRound();
    }, KENO_RESULTS_DURATION);
}

// ============ FIXED: KENO BET ENDPOINT ============
app.post('/keno/bet', async (req, res) => {
    // ACCEPT BOTH field naming conventions for compatibility
    const phone = req.body.phone;
    const selectedNumbers = req.body.selectedNumbers || req.body.selected_numbers;
    const betAmount = req.body.betAmount || req.body.bet_amount;
    
    // Validation
    if (!phone) {
        return res.status(400).json({ error: 'Phone number is required' });
    }
    if (!selectedNumbers || !Array.isArray(selectedNumbers) || selectedNumbers.length < 1 || selectedNumbers.length > 10) {
        return res.status(400).json({ error: 'Select 1-10 numbers' });
    }
    if (!betAmount || betAmount <= 0) {
        return res.status(400).json({ error: 'Valid bet amount is required' });
    }
    if (kenoRoundPhase !== 'betting') {
        return res.status(400).json({ error: 'Betting closed for this round' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Get user with FOR UPDATE (lock row)
        const user = await client.query(
            'SELECT id, wallet_balance FROM users WHERE phone = $1 FOR UPDATE',
            [phone]
        );
        if (user.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        const currentBalance = parseFloat(user.rows[0].wallet_balance);
        if (currentBalance < betAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Deduct bet amount
        const newBalance = currentBalance - betAmount;
        await client.query(
            'UPDATE users SET wallet_balance = $1 WHERE id = $2',
            [newBalance, user.rows[0].id]
        );
        
        // Save bet with correct field names
        const betResult = await client.query(
            `INSERT INTO bets (user_id, game_id, bet_amount, selected_numbers, created_at) 
             VALUES ($1, $2, $3, $4, NOW()) 
             RETURNING id`,
            [user.rows[0].id, currentKenoGameId, betAmount, selectedNumbers]
        );
        
        // Store in memory for round processing
        kenoRoundBets.push({
            bet_id: betResult.rows[0].id,
            user_id: user.rows[0].id,
            phone: phone,
            selected_numbers: selectedNumbers,
            bet_amount: betAmount
        });
        
        await client.query('COMMIT');
        
        // Send real-time balance update
        await emitBalanceUpdate(phone);
        
        const timeLeft = Math.max(0, Math.floor((KENO_BETTING_DURATION - (Date.now() - kenoRoundStartTime)) / 1000));
        
        res.json({
            success: true,
            newBalance: newBalance,
            gameId: currentKenoGameId,
            gameNumber: currentKenoGameNumber,
            timeLeft: timeLeft,
            message: 'Bet placed successfully!'
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Keno bet error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// ============ FIXED: KENO STATE ENDPOINT ============
app.get('/keno/state', (req, res) => {
    let timeLeft = 0;
    const elapsed = Date.now() - kenoRoundStartTime;
    if (kenoRoundPhase === 'betting') {
        timeLeft = Math.max(0, Math.floor((KENO_BETTING_DURATION - elapsed) / 1000));
    } else if (kenoRoundPhase === 'drawing') {
        timeLeft = Math.max(0, Math.floor((KENO_DRAWING_DURATION - elapsed) / 1000));
    } else {
        timeLeft = Math.max(0, Math.floor((KENO_RESULTS_DURATION - elapsed) / 1000));
    }
    
    res.json({
        success: true,
        gameId: currentKenoGameId,
        gameNumber: currentKenoGameNumber,
        phase: kenoRoundPhase,
        timeLeft: timeLeft,
        isSpecial: currentKenoGameNumber % 5 === 0,
        drawnNumbers: (kenoRoundPhase === 'drawing' || kenoRoundPhase === 'results') ? currentKenoDrawnNumbers : null,
        roundActive: kenoRoundActive
    });
});

// ============ FIXED: KENO HISTORY ENDPOINT ============
app.get('/keno/history/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT id FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const history = await pool.query(
            `SELECT 
                id, 
                game_id, 
                bet_amount, 
                selected_numbers, 
                win_amount, 
                won, 
                drawn_numbers, 
                created_at 
             FROM bets 
             WHERE user_id = $1 AND game_id LIKE 'KENO-%' 
             ORDER BY created_at DESC 
             LIMIT 50`,
            [user.rows[0].id]
        );
        
        // Format the response
        const formattedHistory = history.rows.map(row => ({
            id: row.id,
            game_id: row.game_id,
            bet_amount: parseFloat(row.bet_amount),
            selected_numbers: row.selected_numbers,
            win_amount: parseFloat(row.win_amount || 0),
            won: row.won || false,
            drawn_numbers: row.drawn_numbers,
            created_at: row.created_at
        }));
        
        res.json(formattedHistory);
    } catch (error) {
        console.error('Keno history error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function for real-time balance updates
async function emitBalanceUpdate(phone) {
    try {
        const result = await pool.query('SELECT wallet_balance FROM users WHERE phone = $1', [phone]);
        if (result.rows.length > 0) {
            const newBalance = parseFloat(result.rows[0].wallet_balance);
            const socketId = userSockets.get(phone);
            if (socketId) {
                io.to(socketId).emit('balance-update', { newBalance });
            }
        }
    } catch (err) {
        console.error('Error sending balance update:', err);
    }
}

// Start first round
startNewKenoRound();

// ============================================
// TELEGRAM BOT INTEGRATION (MOVED TO BOTTOM)
// ============================================

const BOT_TOKEN = process.env.BOT_TOKEN || '8281242847:AAHDPy5cxY2nqCdY8Ebsx51HfiZJ_J4h1lE';
const sessions = new Map();
const bot = new Telegraf(BOT_TOKEN);
const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://keno-t5bi.onrender.com';

console.log(`${colors.cyan}🤖 Initializing Telegram bot...${colors.reset}`);
console.log(`${colors.cyan}📡 Bot Base URL: ${BASE_URL}${colors.reset}`);

// Set webhook for production
if (process.env.NODE_ENV === 'production') {
    bot.telegram.setWebhook(`${BASE_URL}/webhook`);
    app.use(bot.webhookCallback('/webhook'));
}

// Generate unique referral code
function generateReferralCode(userId, phone) {
    const cleanPhone = phone.replace(/\D/g, '').slice(-4);
    return `REF${userId}${cleanPhone}`;
}

async function getReferralStats(phone) {
    try {
        const result = await pool.query(`
            SELECT COUNT(*) as total_referrals, COALESCE(SUM(bonus_amount), 0) as total_bonus
            FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE
        `, [phone]);
        return result.rows[0];
    } catch (err) {
        return { total_referrals: 0, total_bonus: 0 };
    }
}

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
        '🐎 HORSE RACING & KENO BET BOT\n\n' +
        '━━━━━━━━━━━━━━━━━━━━\n\n' +
        '🎰 Games Available:\n' +
        '• Horse Racing - Bet on 6 horses\n' +
        '• Keno - Pick 1-10 numbers, win up to 20,000x!\n\n' +
        '📋 Commands:\n' +
        '/register - Create new account\n' +
        '/play - Auto-login to app\n' +
        '/balance - Check wallet balance\n' +
        '/invite - Get referral link\n' +
        '/referrals - View your referrals\n' +
        '/help - Show this menu'
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
    if (sessions.delete(ctx.from.id)) ctx.reply('❌ Registration cancelled');
    else ctx.reply('No active session');
});

// /invite command
bot.command('invite', async (ctx) => {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (!registered.registered) return ctx.reply('❌ Register first with /register');
        
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
            `💰 You get $10 for each friend who makes their first deposit!`,
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
bot.command('referrals', async (ctx) => await viewReferrals(ctx));
bot.action('view_referrals', async (ctx) => await viewReferrals(ctx));

async function viewReferrals(ctx) {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (!registered.registered) return ctx.reply('❌ Register first');
        
        const awarded = await pool.query('SELECT referred_phone, bonus_awarded_at FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE', [registered.phone]);
        const pending = await pool.query('SELECT referred_phone, created_at FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = FALSE', [registered.phone]);
        
        let message = `👥 YOUR REFERRALS\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        message += `✅ AWARDED (${awarded.rows.length}):\n`;
        awarded.rows.forEach((r, i) => message += `  ${i+1}. ${r.referred_phone}\n`);
        message += `\n⏳ PENDING (${pending.rows.length}):\n`;
        pending.rows.forEach((r, i) => message += `  ${i+1}. ${r.referred_phone}\n`);
        message += `\n💡 Pending referrals award $10 when they make first deposit!`;
        
        await ctx.reply(message);
    } catch (err) {
        console.error('View referrals error:', err);
        ctx.reply('❌ Error loading referrals');
    }
}



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
            return ctx.reply(`✅ Already registered!\nPhone: ${registered.phone}\nBalance: $${registered.user.wallet_balance}`, { reply_markup: { inline_keyboard: [[{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]] } });
        }
        
        sessions.set(userId, { step: 'phone', telegram_id: userId, telegram_username: ctx.from.username || 'telegram_user', referral_code: referralCode });
        await ctx.reply('📱 Welcome!\nShare your phone number:', { reply_markup: { keyboard: [[{ text: '📱 Share Phone Number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
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
    if (contact.user_id !== userId) return ctx.reply('❌ Share your own number');
    
    const phone = contact.phone_number;
    const telegramUsername = ctx.from.username || 'telegram_user';
    
    try {
        const registered = await isUserRegistered(userId);
        if (registered.registered) {
            await ctx.reply('✅ Already registered!', { reply_markup: { remove_keyboard: true } });
            const autoLoginUrl = `${BASE_URL}/select.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            return ctx.reply(`Click below:`, { reply_markup: { inline_keyboard: [[{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]] } });
        }
        
        const check = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        if (check.rows.length > 0) {
            await pool.query('INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1,$2,$3)', [userId, telegramUsername, phone]);
            await ctx.reply('✅ Phone linked!', { reply_markup: { remove_keyboard: true } });
            const autoLoginUrl = `${BASE_URL}/select.html?phone=${encodeURIComponent(phone)}&auto=1`;
            return ctx.reply(`Click below:`, { reply_markup: { inline_keyboard: [[{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]] } });
        }
        
        const userReferralCode = generateReferralCode(userId, phone);
        await pool.query('INSERT INTO users (phone, password, wallet_balance, referral_code) VALUES ($1,$2,$3,$4)', [phone, 'telegram123', 100.00, userReferralCode]);
        await pool.query('INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1,$2,$3)', [userId, telegramUsername, phone]);
        
        if (session?.referral_code) {
            const referrer = await pool.query('SELECT phone FROM users WHERE referral_code = $1', [session.referral_code]);
            if (referrer.rows.length > 0) {
                await pool.query('INSERT INTO referrals (referrer_phone, referred_phone, bonus_amount, bonus_awarded) VALUES ($1,$2,$3,false)', [referrer.rows[0].phone, phone, 10.00]);
            }
        }
        
        await ctx.reply('✅ Registration successful!', { reply_markup: { remove_keyboard: true } });
        const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(phone)}&auto=1`;
        await ctx.reply(`Your account is ready!\nPhone: ${phone}\nBalance: $100.00\nReferral Code: ${userReferralCode}`, { reply_markup: { inline_keyboard: [[{ text: '🚀 Start Playing', web_app: { url: autoLoginUrl } }]] } });
        sessions.delete(ctx.from.id);
    } catch (err) {
        console.error('Contact error:', err);
        ctx.reply('❌ Registration failed. Please try again.', { reply_markup: { remove_keyboard: true } });
    }
});

bot.command('play', async (ctx) => {
    const registered = await isUserRegistered(ctx.from.id);
    if (registered.registered) {
        const autoLoginUrl = `${BASE_URL}/select.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
        return ctx.reply(`Click below:`, { reply_markup: { inline_keyboard: [[{ text: '🚀 Play', web_app: { url: autoLoginUrl } }]] } });
    }
    ctx.reply('❌ Not registered. Use /register');
});

bot.command('balance', async (ctx) => {
    const registered = await isUserRegistered(ctx.from.id);
    if (registered.registered) return ctx.reply(`💰 Balance: $${registered.user.wallet_balance}`);
    ctx.reply('❌ Not registered');
});

bot.action('play_now', async (ctx) => {
    ctx.deleteMessage();
    const registered = await isUserRegistered(ctx.from.id);
    if (registered.registered) {
        const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
        await ctx.reply(`Click below:`, { reply_markup: { inline_keyboard: [[{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]] } });
    }
});

bot.catch((err, ctx) => console.error('❌ Bot error:', err));

// Launch bot (polling for development, webhook for production)
if (process.env.NODE_ENV !== 'production') {
    bot.launch().then(() => console.log(`${colors.green}✅ Telegram bot started (polling mode)!${colors.reset}`)).catch(err => console.log(`${colors.red}❌ Bot failed:${colors.reset}`, err.message));
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.green}🚀 SERVER STARTED SUCCESSFULLY!${colors.reset}`);
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}📡 Server URL: ${BASE_URL}${colors.reset}`);
    console.log(`${colors.cyan}🎲 Keno starting from: KENO-123213${colors.reset}`);
    console.log(`${colors.cyan}⏱️  Keno rounds: 30s betting + 30s drawing + 5s results = 65s total${colors.reset}`);
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
});