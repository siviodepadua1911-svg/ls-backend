// db.js — Banco de dados SQLite com todas as tabelas do sistema LS Auto Truck
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ls_autotruck.db');
const db = new Database(DB_PATH);

// Ativar WAL mode para performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==========================================
// CRIAR TABELAS
// ==========================================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    doc TEXT,
    email TEXT,
    phone TEXT,
    wapp TEXT,
    city TEXT,
    status TEXT DEFAULT 'ativo',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS service_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    num TEXT UNIQUE NOT NULL,
    client_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    services TEXT NOT NULL,
    total REAL NOT NULL,
    status TEXT DEFAULT 'aberta',
    notes TEXT,
    charged INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    num TEXT UNIQUE NOT NULL,
    client_id INTEGER NOT NULL,
    order_id INTEGER,
    description TEXT NOT NULL,
    value REAL NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT DEFAULT 'rascunho',
    pix_link TEXT,
    pix_invoice_slug TEXT,
    paid_at TEXT,
    approved_by TEXT,
    approved_at TEXT,
    sent_at TEXT,
    sent_wapp INTEGER DEFAULT 0,
    sent_email INTEGER DEFAULT 0,
    nfse INTEGER DEFAULT 0,
    installments INTEGER DEFAULT 1,
    current_installment INTEGER DEFAULT 1,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (order_id) REFERENCES service_orders(id)
  );

  CREATE TABLE IF NOT EXISTS nfse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    charge_id INTEGER NOT NULL,
    client_id INTEGER NOT NULL,
    num TEXT NOT NULL,
    value REAL NOT NULL,
    iss REAL,
    aliquota REAL DEFAULT 5,
    description TEXT,
    serie TEXT DEFAULT 'A',
    issued_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (charge_id) REFERENCES charges(id),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    value REAL NOT NULL,
    cycle TEXT DEFAULT 'mensal',
    next_date TEXT,
    status TEXT DEFAULT 'ativo',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS ruler_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    days_offset INTEGER NOT NULL,
    channel TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_slug TEXT,
    order_nsu TEXT,
    amount INTEGER,
    capture_method TEXT,
    raw_payload TEXT,
    processed INTEGER DEFAULT 0,
    received_at TEXT DEFAULT (datetime('now'))
  );
`);

// ==========================================
// SEEDS — Dados iniciais
// ==========================================
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  const adminPass = bcrypt.hashSync('ls2024', 10);
  const finPass = bcrypt.hashSync('ls2024', 10);

  db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run('admin', adminPass, 'Administrador', 'admin');
  db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run('financeiro', finPass, 'Financeiro', 'user');

  // Clientes de exemplo
  const insertClient = db.prepare('INSERT INTO clients (name, doc, email, phone, wapp, city) VALUES (?, ?, ?, ?, ?, ?)');
  insertClient.run('Transportadora Silva Ltda', '12.345.678/0001-90', 'fin@tsilva.com.br', '(16) 99901-1111', '16999011111', 'Ribeirão Preto - SP');
  insertClient.run('Logística Fernandes ME', '98.765.432/0001-10', 'fin@lfernandes.com.br', '(16) 99802-2222', '16998022222', 'Ribeirão Preto - SP');
  insertClient.run('Frete Rápido Ltda', '45.678.901/0001-23', 'admin@freterap.com.br', '(16) 99703-3333', '16997033333', 'São Paulo - SP');

  // Régua padrão
  const insertStep = db.prepare('INSERT INTO ruler_steps (days_offset, channel, active, message) VALUES (?, ?, ?, ?)');
  insertStep.run(-5, 'email', 1, 'Sua cobrança vence em 5 dias');
  insertStep.run(-1, 'whatsapp', 1, 'Seu pagamento vence amanhã!');
  insertStep.run(0,  'whatsapp', 1, 'Hoje é o dia do vencimento!');
  insertStep.run(3,  'email', 1, 'Cobrança em atraso há 3 dias');
  insertStep.run(7,  'whatsapp', 1, 'Pagamento com 7 dias de atraso');

  // Settings padrão
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('monthly_goal', '50000');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('company_name', 'LS Auto Truck');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('nfse_counter', '1');

  console.log('✅ Banco de dados criado com dados iniciais');
}

module.exports = db;
