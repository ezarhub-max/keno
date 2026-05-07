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

const gameSessions = new Map();
const userSockets = new Map();

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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

// Create tables
async function initDatabase() {
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

initDatabase();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================
// SOCKET.IO
// ============================================
io.on('connection', (socket) => {
    console.log(`${colors.green}🔌 New client - ${socket.id}${colors.reset}`);
    
    socket.on('register-user', (phone) => {
        if (phone) {
            userSockets.set(phone, socket.id);
            console.log(`${colors.cyan}📱 User ${phone} registered${colors.reset}`);
        }
    });
    
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
        for (const [phone, socketId] of userSockets.entries()) {
            if (socketId === socket.id) {
                userSockets.delete(phone);
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

async function emitBalanceUpdate(phone) {
    try {
        const result = await pool.query('SELECT wallet_balance FROM users WHERE phone = $1', [phone]);
        if (result.rows.length > 0) {
            const newBalance = parseFloat(result.rows[0].wallet_balance);
            const socketId = userSockets.get(phone);
            if (socketId) {
                io.to(socketId).emit('balance-update', { newBalance });
                console.log(`${colors.green}💰 Balance sent to ${phone}: $${newBalance}${colors.reset}`);
            }
        }
    } catch (err) {
        console.error('Balance update error:', err);
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
            await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone = $2', [r.winAmount, r.phone]);
            await emitBalanceUpdate(r.phone);
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
        res.status(500).json({ success: false, error: e.message }); 
    }
});

app.get('/wallet/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT wallet_balance FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ balance: parseFloat(user.rows[0].wallet_balance) });
    } catch(e) { 
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
        await client.query('INSERT INTO bets (user_id, horse_number, bet_amount) VALUES ($1,$2,$3)', [user.rows[0].id, horseNumber, betAmount]);
        await client.query('COMMIT');
        await emitBalanceUpdate(phone);
        const gameId = `GAME-${Math.floor(Date.now() / 60000).toString().slice(-6)}`;
        res.json({ success: true, newBalance: balance - betAmount, gameId });
    } catch(e) { 
        await client.query('ROLLBACK'); 
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
        res.json({ success: false, error: 'Invalid token' }); 
    }
});

app.get('/user/referrals/:phone', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) as total, COALESCE(SUM(bonus_amount),0) as bonus FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE', [req.params.phone]);
        const referrals = await pool.query('SELECT referred_phone, created_at, bonus_amount, bonus_awarded FROM referrals WHERE referrer_phone = $1', [req.params.phone]);
        res.json({ success: true, total_referrals: parseInt(result.rows[0].total), total_bonus: parseFloat(result.rows[0].bonus), referrals: referrals.rows });
    } catch(e) { 
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/admin/login', (req, res) => {
    if (req.body.username === 'admin' && req.body.password === 'admin123') {
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
        await emitBalanceUpdate(phone);
        if (wasFirst && amount > 0) {
            const referral = await client.query('SELECT * FROM referrals WHERE referred_phone = $1 AND bonus_awarded = FALSE', [phone]);
            if (referral.rows.length > 0) {
                await client.query('UPDATE users SET wallet_balance = wallet_balance + 10, total_referrals = total_referrals + 1 WHERE phone = $1', [referral.rows[0].referrer_phone]);
                await client.query('UPDATE referrals SET bonus_awarded = TRUE, bonus_awarded_at = NOW() WHERE id = $1', [referral.rows[0].id]);
                await emitBalanceUpdate(referral.rows[0].referrer_phone);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { 
        await client.query('ROLLBACK');
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
        res.status(500).json({ success: false, error: e.message }); 
    }
});

app.post('/admin/delete-member', async (req, res) => {
    const { phone } = req.body;
    try {
        await pool.query('DELETE FROM users WHERE phone = $1', [phone]);
        res.json({ success: true });
    } catch(e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// ============================================
// DEPOSIT SYSTEM
// ============================================

app.post('/deposit/request', async (req, res) => {
    const { phone, amount, transactionId } = req.body;
    if (!amount || amount <= 499) return res.status(400).json({ error: 'Invalid amount' });
    if (!transactionId) return res.status(400).json({ error: 'Transaction ID required' });
    try {
        const user = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const existing = await pool.query('SELECT * FROM deposits WHERE transaction_id = $1', [transactionId]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Transaction ID already exists' });
        await pool.query('INSERT INTO deposits (user_id, phone, amount, transaction_id, status) VALUES ($1,$2,$3,$4,$5)', [user.rows[0].id, phone, amount, transactionId, 'pending']);
        res.json({ success: true, message: 'Deposit request submitted' });
    } catch(e) { 
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/admin/deposits', async (req, res) => {
    try {
        const deposits = await pool.query('SELECT d.*, u.wallet_balance FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = $1 ORDER BY d.created_at ASC', ['pending']);
        res.json(deposits.rows);
    } catch(e) { 
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
            await client.query('UPDATE users SET wallet_balance = wallet_balance + $1, total_deposits = total_deposits + $2 WHERE id = $3', 
                [deposit.rows[0].amount, deposit.rows[0].amount, deposit.rows[0].user_id]);
            await emitBalanceUpdate(deposit.rows[0].phone);
            await client.query('UPDATE deposits SET status = $1, approved_at = NOW(), approved_by = $2 WHERE id = $3', 
                ['approved', 'admin', depositId]);
            const referral = await client.query('SELECT * FROM referrals WHERE referred_phone = $1 AND bonus_awarded = FALSE', [deposit.rows[0].phone]);
            if (referral.rows.length > 0) {
                await client.query('UPDATE users SET wallet_balance = wallet_balance + 10, total_referrals = total_referrals + 1 WHERE phone = $1', 
                    [referral.rows[0].referrer_phone]);
                await client.query('UPDATE referrals SET bonus_awarded = TRUE, bonus_awarded_at = NOW() WHERE id = $1', 
                    [referral.rows[0].id]);
                await emitBalanceUpdate(referral.rows[0].referrer_phone);
            }
        } else {
            await client.query('UPDATE deposits SET status = $1, approved_at = NOW(), approved_by = $2 WHERE id = $3', 
                ['rejected', 'admin', depositId]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { 
        await client.query('ROLLBACK');
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
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/deposit/pending/:phone', async (req, res) => {
    try {
        const pending = await pool.query('SELECT * FROM deposits WHERE phone = $1 AND status = $2 ORDER BY created_at DESC', [req.params.phone, 'pending']);
        res.json(pending.rows);
    } catch(e) { 
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
        const newBalance = user.rows[0].wallet_balance - amount;
        await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.rows[0].id]);
        await emitBalanceUpdate(phone);
        await client.query('INSERT INTO withdrawals (user_id, amount, method, account, status) VALUES ($1,$2,$3,$4,$5)', 
            [user.rows[0].id, amount, method, account, 'pending']);
        await client.query('COMMIT');
        res.json({ success: true, newBalance, message: 'Withdrawal request submitted' });
    } catch(e) { 
        await client.query('ROLLBACK');
        res.status(500).json({ error: e.message }); 
    } finally { 
        client.release(); 
    }
});








// ============================================
// WITHDRAWAL HISTORY ENDPOINTS (FIXED)
// ============================================

// Get withdrawal history for a specific user
app.get('/withdrawal/history/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT id FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const history = await pool.query(
            `SELECT id, amount, method, account, status, created_at 
             FROM withdrawals 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 50`,
            [user.rows[0].id]
        );
        
        console.log(`📋 Withdrawal history for ${req.params.phone}: ${history.rows.length} records`);
        res.json(history.rows);
    } catch (error) {
        console.error('Withdrawal history error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get user's pending withdrawal
app.get('/withdrawal/pending/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT id FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const pending = await pool.query(
            `SELECT id, amount, method, account, status, created_at 
             FROM withdrawals 
             WHERE user_id = $1 AND status = 'pending' 
             ORDER BY created_at DESC`,
            [user.rows[0].id]
        );
        
        res.json(pending.rows);
    } catch (error) {
        console.error('Pending withdrawal error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all withdrawals for admin
app.get('/admin/withdrawals', async (req, res) => {
    try {
        const withdrawals = await pool.query(
            `SELECT w.id, u.phone, w.amount, w.method, w.account, w.status, w.created_at 
             FROM withdrawals w 
             JOIN users u ON w.user_id = u.id 
             ORDER BY w.created_at DESC 
             LIMIT 100`
        );
        res.json(withdrawals.rows);
    } catch (error) {
        console.error('Admin withdrawals error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Approve or reject withdrawal
app.post('/admin/approve-withdraw', async (req, res) => {
    const { id, action } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const withdrawal = await client.query(
            'SELECT * FROM withdrawals WHERE id = $1 AND status = $2',
            [id, 'pending']
        );
        
        if (withdrawal.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Withdrawal not found or already processed' });
        }
        
        let newStatus;
        if (action === 'approve') {
            newStatus = 'approved';
        } else if (action === 'reject') {
            newStatus = 'rejected';
            // Refund money back to user if rejected
            const userId = withdrawal.rows[0].user_id;
            const amount = parseFloat(withdrawal.rows[0].amount);
            
            await client.query(
                'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
                [amount, userId]
            );
            
            // Send balance update
            const user = await client.query('SELECT phone FROM users WHERE id = $1', [userId]);
            if (user.rows.length > 0) {
                await emitBalanceUpdate(user.rows[0].phone);
            }
        } else {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid action' });
        }
        
        await client.query(
            'UPDATE withdrawals SET status = $1 WHERE id = $2',
            [newStatus, id]
        );
        
        await client.query('COMMIT');
        res.json({ success: true, status: newStatus });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Approve withdraw error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Withdraw endpoint (already exists, make sure it's correct)
app.post('/withdraw', async (req, res) => {
    const { phone, amount, method, account } = req.body;
    
    console.log(`💰 Withdrawal request: ${phone} - Amount: $${amount}`);
    
    if (!amount || amount < 1000) {
        return res.status(400).json({ error: 'Minimum withdrawal is $1,000' });
    }
    if (amount > 25000) {
        return res.status(400).json({ error: 'Maximum withdrawal per request is $25,000' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const user = await client.query('SELECT id, wallet_balance FROM users WHERE phone = $1 FOR UPDATE', [phone]);
        if (user.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        const currentBalance = parseFloat(user.rows[0].wallet_balance);
        if (currentBalance < amount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        const newBalance = currentBalance - amount;
        await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.rows[0].id]);
        
        await client.query(
            `INSERT INTO withdrawals (user_id, amount, method, account, status, created_at) 
             VALUES ($1, $2, $3, $4, 'pending', NOW())`,
            [user.rows[0].id, amount, method || 'telebirr', account || '']
        );
        
        await client.query('COMMIT');
        
        await emitBalanceUpdate(phone);
        
        res.json({ 
            success: true, 
            newBalance: newBalance, 
            message: 'Withdrawal request submitted' 
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Withdrawal error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});































// ============================================
// KENO GAME - COMPLETELY FIXED
// ============================================

let currentKenoGameId = null;
let currentKenoGameNumber = 523213;
let currentKenoDrawnNumbers = null;
let kenoRoundActive = false;
let kenoRoundStartTime = null;
let kenoRoundTimer = null;
let kenoRoundBets = [];
let kenoRoundPhase = 'betting';
const KENO_BETTING_DURATION = 45000;   // 45 seconds
const KENO_DRAWING_DURATION = 15000;   // 15 seconds
const KENO_RESULTS_DURATION = 5000;    // 5 seconds (no change)
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
    if (isDivisibleBy5) numbers.push(66);
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
    console.log(`${colors.magenta}🎲 NEW KENO ROUND: ${currentKenoGameId} - BETTING PHASE${colors.reset}`);
    kenoRoundTimer = setTimeout(() => startDrawingPhase(), KENO_BETTING_DURATION);
}

function startDrawingPhase() {
    kenoRoundPhase = 'drawing';
    kenoRoundStartTime = Date.now();
    console.log(`${colors.yellow}🎨 KENO ROUND ${currentKenoGameId} - DRAWING PHASE${colors.reset}`);
    kenoRoundTimer = setTimeout(() => startResultsPhase(), KENO_DRAWING_DURATION);
}

// ============ THIS IS THE CRITICAL FIXED FUNCTION ============
async function startResultsPhase() {
    kenoRoundPhase = 'results';
    console.log(`${colors.blue}📊 KENO ROUND ${currentKenoGameId} - RESULTS PHASE${colors.reset}`);
    console.log(`${colors.cyan}🎲 Drawn numbers: ${currentKenoDrawnNumbers.join(', ')}${colors.reset}`);
    console.log(`${colors.yellow}📝 Total bets in this round: ${kenoRoundBets.length}${colors.reset}`);
    
    if (kenoRoundBets.length === 0) {
        console.log('No bets to process');
        kenoRoundTimer = setTimeout(() => {
            kenoRoundActive = false;
            startNewKenoRound();
        }, KENO_RESULTS_DURATION);
        return;
    }
    
    // Process each bet
    for (let i = 0; i < kenoRoundBets.length; i++) {
        const bet = kenoRoundBets[i];
        
        // Calculate matches
        let matches = 0;
        for (let j = 0; j < bet.selected_numbers.length; j++) {
            if (currentKenoDrawnNumbers.includes(bet.selected_numbers[j])) {
                matches++;
            }
        }
        
        const winAmount = calculateKenoPayout(bet.selected_numbers.length, matches, bet.bet_amount);
        
        console.log(`${colors.cyan}💰 Bet ${i+1}: User ${bet.phone} - Selected ${bet.selected_numbers.length} numbers - Matches: ${matches} - Win Amount: $${winAmount}${colors.reset}`);
        
        // Update bets table
        try {
            await pool.query(
                `UPDATE bets 
                 SET win_amount = $1, 
                     won = $2, 
                     drawn_numbers = $3 
                 WHERE id = $4`,
                [winAmount, winAmount > 0, currentKenoDrawnNumbers, bet.bet_id]
            );
            console.log(`✅ Bet ${bet.bet_id} updated in database`);
        } catch (err) {
            console.error(`❌ Failed to update bet ${bet.bet_id}:`, err.message);
        }
        
        // ============ CRITICAL: UPDATE USER BALANCE ============
        if (winAmount > 0) {
            try {
                // Get current balance
                const userBefore = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [bet.user_id]);
                const oldBalance = parseFloat(userBefore.rows[0].wallet_balance);
                const newBalance = oldBalance + winAmount;
                
                // Update balance
                await pool.query(
                    'UPDATE users SET wallet_balance = $1 WHERE id = $2',
                    [newBalance, bet.user_id]
                );
                
                console.log(`${colors.green}💰 User ${bet.phone} balance: $${oldBalance} → $${newBalance} (won $${winAmount})${colors.reset}`);
                
                // Send real-time Socket.io update
                const socketId = userSockets.get(bet.phone);
                if (socketId) {
                    io.to(socketId).emit('balance-update', { newBalance: newBalance });
                    console.log(`${colors.green}📡 Balance update sent to ${bet.phone}${colors.reset}`);
                } else {
                    console.log(`${colors.yellow}⚠️ No active socket for ${bet.phone}${colors.reset}`);
                }
            } catch (err) {
                console.error(`❌ Failed to update balance for ${bet.phone}:`, err.message);
            }
        } else {
            console.log(`${colors.red}❌ User ${bet.phone} lost $${bet.bet_amount}${colors.reset}`);
        }
    }
    
    // Clear bets for next round
    kenoRoundBets = [];
    
    // Schedule next round
    kenoRoundTimer = setTimeout(() => {
        kenoRoundActive = false;
        startNewKenoRound();
    }, KENO_RESULTS_DURATION);
}

app.post('/keno/bet', async (req, res) => {
    const phone = req.body.phone;
    const selectedNumbers = req.body.selectedNumbers || req.body.selected_numbers;
    const betAmount = req.body.betAmount || req.body.bet_amount;
    
    console.log(`${colors.cyan}📝 Bet request: ${phone} - Numbers: ${selectedNumbers} - Amount: $${betAmount}${colors.reset}`);
    
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
        
        const user = await client.query('SELECT id, wallet_balance FROM users WHERE phone = $1 FOR UPDATE', [phone]);
        if (user.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        const currentBalance = parseFloat(user.rows[0].wallet_balance);
        if (currentBalance < betAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        const newBalance = currentBalance - betAmount;
        await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.rows[0].id]);
        
        const betResult = await client.query(
            `INSERT INTO bets (user_id, game_id, bet_amount, selected_numbers, created_at) 
             VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
            [user.rows[0].id, currentKenoGameId, betAmount, selectedNumbers]
        );
        
        kenoRoundBets.push({
            bet_id: betResult.rows[0].id,
            user_id: user.rows[0].id,
            phone: phone,
            selected_numbers: selectedNumbers,
            bet_amount: betAmount
        });
        
        await client.query('COMMIT');
        
        await emitBalanceUpdate(phone);
        
        const timeLeft = Math.max(0, Math.floor((KENO_BETTING_DURATION - (Date.now() - kenoRoundStartTime)) / 1000));
        
        res.json({
            success: true,
            newBalance: newBalance,
            gameId: currentKenoGameId,
            gameNumber: currentKenoGameNumber,
            timeLeft: timeLeft
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Keno bet error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

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

app.get('/keno/history/:phone', async (req, res) => {
    try {
        const user = await pool.query('SELECT id FROM users WHERE phone = $1', [req.params.phone]);
        if (user.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const history = await pool.query(
            `SELECT id, game_id, bet_amount, selected_numbers, win_amount, won, drawn_numbers, created_at 
             FROM bets 
             WHERE user_id = $1 AND game_id LIKE 'KENO-%' 
             ORDER BY created_at DESC LIMIT 50`,
            [user.rows[0].id]
        );
        
        res.json(history.rows);
    } catch (error) {
        console.error('Keno history error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start first round
startNewKenoRound();

// ============================================
// TELEGRAM BOT
// ============================================

const BOT_TOKEN = process.env.BOT_TOKEN || '8281242847:AAHDPy5cxY2nqCdY8Ebsx51HfiZJ_J4h1lE';
const sessions = new Map();
const bot = new Telegraf(BOT_TOKEN);
const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://keno-t5bi.onrender.com';

console.log(`${colors.cyan}🤖 Initializing Telegram bot...${colors.reset}`);

if (process.env.NODE_ENV === 'production') {
    bot.telegram.setWebhook(`${BASE_URL}/webhook`);
    app.use(bot.webhookCallback('/webhook'));
}

function generateReferralCode(userId, phone) {
    const cleanPhone = phone.replace(/\D/g, '').slice(-4);
    return `REF${userId}${cleanPhone}`;
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

bot.start(async (ctx) => {
    const parts = ctx.message.text.split(' ');
    let referralCode = parts.length > 1 ? parts[1] : null;
    if (referralCode) sessions.set(ctx.from.id, { referral_code: referralCode, step: 'start' });
    ctx.reply(
        '🐎 HORSE RACING & KENO BET BOT\n\n' +
        '📢 Join our channel for updates: @habeshakeno123\n\n' +
        '━━━━━━━━━━━━━━━━━━━━\n\n' +
        '🎰 Games Available:\n' +
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

bot.help((ctx) => {
    ctx.reply(
        '/register - Create new account\n' +
        '/play - Auto-login to app\n' +
        '/balance - Check your balance\n' +
        '/invite - Get referral link\n' +
        '/referrals - View your referrals\n' +
        '/keno - Play Keno\n' +
        '/cancel - Cancel registration'
    );
});

bot.command('cancel', (ctx) => {
    if (sessions.delete(ctx.from.id)) ctx.reply('❌ Registration cancelled');
    else ctx.reply('No active session');
});

bot.command('invite', async (ctx) => {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (!registered.registered) return ctx.reply('❌ Register first with /register');
        const botUsername = ctx.botInfo ? ctx.botInfo.username : 'HABESHA_ALLGAME_BOT';
        const userData = await pool.query('SELECT referral_code FROM users WHERE phone = $1', [registered.phone]);
        const referralCode = userData.rows[0].referral_code;
        const inviteLink = `https://t.me/${botUsername}?start=${referralCode}`;
        const awarded = await pool.query('SELECT COUNT(*) FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE', [registered.phone]);
        const pending = await pool.query('SELECT COUNT(*) FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = FALSE', [registered.phone]);
        const bonus = await pool.query('SELECT COALESCE(SUM(bonus_amount),0) FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE', [registered.phone]);
        await ctx.reply(
            `👥 YOUR REFERRAL PROGRAM\n\n🔗 Share: ${inviteLink}\n\n📊 Awarded: ${awarded.rows[0].count}\n⏳ Pending: ${pending.rows[0].count}\n💰 Bonus: $${parseFloat(bonus.rows[0].total || 0).toFixed(2)}`,
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

bot.command('referrals', async (ctx) => await viewReferrals(ctx));
bot.action('view_referrals', async (ctx) => await viewReferrals(ctx));

async function viewReferrals(ctx) {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (!registered.registered) return ctx.reply('❌ Register first');
        const awarded = await pool.query('SELECT referred_phone FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE', [registered.phone]);
        const pending = await pool.query('SELECT referred_phone FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = FALSE', [registered.phone]);
        let message = `👥 YOUR REFERRALS\n\n✅ Awarded (${awarded.rows.length}):\n`;
        awarded.rows.forEach((r, i) => message += `  ${i+1}. ${r.referred_phone}\n`);
        message += `\n⏳ Pending (${pending.rows.length}):\n`;
        pending.rows.forEach((r, i) => message += `  ${i+1}. ${r.referred_phone}\n`);
        message += `\n💡 Pending referrals award $10 on first deposit!`;
        await ctx.reply(message);
    } catch (err) {
        console.error('View referrals error:', err);
        ctx.reply('❌ Error loading referrals');
    }
}

bot.command('keno', async (ctx) => {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        if (!registered.registered) return ctx.reply('❌ Register first with /register');
        const kenoUrl = `${BASE_URL}/select.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
        await ctx.reply(
            `🎲 KENO GAME\n\n💰 Balance: $${parseFloat(registered.user.wallet_balance).toFixed(2)}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🎲 Play Keno Now', web_app: { url: kenoUrl } }]
                    ]
                }
            }
        );
    } catch (err) {
        console.error('Keno error:', err);
        ctx.reply('❌ Error. Please try again.');
    }
});

bot.command('register', async (ctx) => {
    const userId = ctx.from.id;
    let referralCode = sessions.get(userId)?.referral_code;
    const parts = ctx.message.text.split(' ');
    if (parts.length > 1) referralCode = parts[1];
    try {
        const registered = await isUserRegistered(userId);
        if (registered.registered) {
            const autoLoginUrl = `${BASE_URL}/select.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            return ctx.reply(`✅ Already registered!\n💰 Balance: $${registered.user.wallet_balance}`, { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', web_app: { url: autoLoginUrl } }]] } });
        }
        sessions.set(userId, { step: 'phone', telegram_id: userId, telegram_username: ctx.from.username || 'telegram_user', referral_code: referralCode });
        await ctx.reply('📱 Share your phone number:', { reply_markup: { keyboard: [[{ text: '📱 Share Phone Number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
    } catch (err) {
        console.error('Register error:', err);
        ctx.reply('❌ Database error. Try again later.');
    }
});

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
            return ctx.reply(`Play now:`, { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', web_app: { url: autoLoginUrl } }]] } });
        }
        const check = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        if (check.rows.length > 0) {
            await pool.query('INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1,$2,$3)', [userId, telegramUsername, phone]);
            await ctx.reply('✅ Phone linked!', { reply_markup: { remove_keyboard: true } });
            const autoLoginUrl = `${BASE_URL}/select.html?phone=${encodeURIComponent(phone)}&auto=1`;
            return ctx.reply(`Play now:`, { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', web_app: { url: autoLoginUrl } }]] } });
        }
        const userReferralCode = generateReferralCode(userId, phone);
        await pool.query('INSERT INTO users (phone, password, wallet_balance, referral_code) VALUES ($1,$2,$3,$4)', [phone, 'telegram123', 0.00, userReferralCode]);
        await pool.query('INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1,$2,$3)', [userId, telegramUsername, phone]);
        if (session?.referral_code) {
            const referrer = await pool.query('SELECT phone FROM users WHERE referral_code = $1', [session.referral_code]);
            if (referrer.rows.length > 0) {
                await pool.query('INSERT INTO referrals (referrer_phone, referred_phone, bonus_amount, bonus_awarded) VALUES ($1,$2,$3,false)', [referrer.rows[0].phone, phone, 10.00]);
            }
        }
        await ctx.reply('✅ Registration successful!', { reply_markup: { remove_keyboard: true } });
        const autoLoginUrl = `${BASE_URL}/select.html?phone=${encodeURIComponent(phone)}&auto=1`;
        await ctx.reply(`Your account is ready!please deposite at least 200$\n💰 Balance: $0.00\n🔗 Referral Code: ${userReferralCode}`, { reply_markup: { inline_keyboard: [[{ text: '🎮 Start Playing', web_app: { url: autoLoginUrl } }]] } });
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
        return ctx.reply(`Play now:`, { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', web_app: { url: autoLoginUrl } }]] } });
    }
    ctx.reply('❌ Not registered. Use /register');
});

bot.command('balance', async (ctx) => {
    const registered = await isUserRegistered(ctx.from.id);
    if (registered.registered) return ctx.reply(`💰 Balance: $${registered.user.wallet_balance}`);
    ctx.reply('❌ Not registered');
});

bot.catch((err, ctx) => console.error('❌ Bot error:', err));

if (process.env.NODE_ENV !== 'production') {
    bot.launch().then(() => console.log(`${colors.green}✅ Telegram bot started!${colors.reset}`)).catch(err => console.log(`${colors.red}❌ Bot failed:${colors.reset}`, err.message));
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));




// DELETE ALL USERS ON SERVER START
(async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM bets');
        await client.query('DELETE FROM deposits');
        await client.query('DELETE FROM withdrawals');
        await client.query('DELETE FROM referrals');
        await client.query('DELETE FROM telegram_links');
        await client.query('DELETE FROM users');
        await client.query('ALTER SEQUENCE users_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE bets_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE deposits_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE withdrawals_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE referrals_id_seq RESTART WITH 1');
        await client.query('ALTER SEQUENCE telegram_links_id_seq RESTART WITH 1');
        await client.query('COMMIT');
        console.log(`${colors.green}✅ ALL USERS DELETED${colors.reset}`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.log(`${colors.red}❌ DELETE FAILED:${colors.reset}`, error.message);
    } finally {
        client.release();
        process.exit(0);
    }
})();
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
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
});