require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { generatePixLink, buildWhatsAppLink, HANDLE } = require('./infinitepay');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'ls_autotruck_secret_2026';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

app.use(cors({ origin: [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173'], credentials: true }));
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
};

const fmt = (v) => Number(v || 0);
const today = () => new Date().toISOString().slice(0, 10);
const padNum = (n) => String(n).padStart(3, '0');

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  const token = jwt.sign({ id: user.id, username: user.username, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

app.get('/api/dashboard', auth, (req, res) => {
  const charges = db.prepare('SELECT * FROM charges').all();
  const total = charges.reduce((a, c) => a + fmt(c.value), 0);
  const received = charges.filter(c => c.status === 'pago').reduce((a, c) => a + fmt(c.value), 0);
  const pending = charges.filter(c => ['enviada', 'aprovada'].includes(c.status)).reduce((a, c) => a + fmt(c.value), 0);
  const overdue = charges.filter(c => c.status === 'vencido').reduce((a, c) => a + fmt(c.value), 0);
  const pendingApproval = charges.filter(c => c.status === 'aguard_aprovacao').length;
  const goal = fmt(db.prepare("SELECT value FROM settings WHERE key = 'monthly_goal'").get()?.value || 50000);
  const unfacturedOrders = db.prepare("SELECT COUNT(*) as c FROM service_orders WHERE status = 'finalizada' AND charged = 0").get().c;
  res.json({ total, received, pending, overdue, pendingApproval, goal, unfacturedOrders, chargesCount: charges.length });
});

app.get('/api/clients', auth, (req, res) => res.json(db.prepare('SELECT * FROM clients ORDER BY name').all()));

app.post('/api/clients', auth, (req, res) => {
  const { name, doc, email, phone, wapp, city, status, notes } = req.body;
  const r = db.prepare('INSERT INTO clients (name, doc, email, phone, wapp, city, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, doc, email, phone, wapp, city, status || 'ativo', notes || '');
  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/clients/:id', auth, (req, res) => {
  const { name, doc, email, phone, wapp, city, status, notes } = req.body;
  db.prepare('UPDATE clients SET name=?, doc=?, email=?, phone=?, wapp=?, city=?, status=?, notes=?, updated_at=datetime("now") WHERE id=?').run(name, doc, email, phone, wapp, city, status, notes || '', req.params.id);
  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id));
});

app.delete('/api/clients/:id', auth, (req, res) => { db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/clients/:id/history', auth, (req, res) => {
  const orders = db.prepare('SELECT * FROM service_orders WHERE client_id = ? ORDER BY id DESC').all(req.params.id);
  const charges = db.prepare('SELECT * FROM charges WHERE client_id = ? ORDER BY id DESC').all(req.params.id);
  res.json({ orders, charges });
});

app.get('/api/orders', auth, (req, res) => {
  const orders = db.prepare('SELECT o.*, c.name as client_name FROM service_orders o LEFT JOIN clients c ON o.client_id = c.id ORDER BY o.id DESC').all();
  res.json(orders.map(o => ({ ...o, services: JSON.parse(o.services || '[]') })));
});

app.post('/api/orders', auth, (req, res) => {
  const { client_id, description, services, total, notes, status } = req.body;
  const count = db.prepare('SELECT COUNT(*) as c FROM service_orders').get().c;
  const num = `OS-${new Date().getFullYear()}/${padNum(count + 1)}`;
  const r = db.prepare('INSERT INTO service_orders (num, client_id, description, services, total, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(num, client_id, description, JSON.stringify(services || []), total, status || 'aberta', notes || '');
  res.json(db.prepare('SELECT * FROM service_orders WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/orders/:id', auth, (req, res) => {
  const { description, services, total, status, notes, charged } = req.body;
  db.prepare('UPDATE service_orders SET description=?, services=?, total=?, status=?, notes=?, charged=?, updated_at=datetime("now") WHERE id=?').run(description, JSON.stringify(services || []), total, status, notes || '', charged ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT * FROM service_orders WHERE id = ?').get(req.params.id));
});

app.post('/api/orders/:id/to-charge', auth, (req, res) => {
  const order = db.prepare('SELECT * FROM service_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'OS não encontrada' });
  const count = db.prepare('SELECT COUNT(*) as c FROM charges').get().c;
  const num = `COB-${padNum(count + 1)}`;
  const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const r = db.prepare('INSERT INTO charges (num, client_id, order_id, description, value, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(num, order.client_id, order.id, `${order.num} - ${order.description}`, order.total, dueDate, 'rascunho');
  db.prepare("UPDATE service_orders SET charged=1, status='faturada', updated_at=datetime('now') WHERE id=?").run(order.id);
  res.json({ charge_id: r.lastInsertRowid, num });
});

app.get('/api/charges', auth, (req, res) => {
  res.json(db.prepare('SELECT ch.*, c.name as client_name, c.email as client_email, c.wapp as client_wapp FROM charges ch LEFT JOIN clients c ON ch.client_id = c.id ORDER BY ch.id DESC').all());
});

app.post('/api/charges', auth, (req, res) => {
  const { client_id, description, value, due_date, installments, notes, order_id } = req.body;
  const count = db.prepare('SELECT COUNT(*) as c FROM charges').get().c;
  if (installments > 1) {
    const created = [];
    const baseVal = Math.round((value / installments) * 100) / 100;
    for (let i = 0; i < installments; i++) {
      const num = `COB-${padNum(count + i + 1)}`;
      const due = new Date(due_date + 'T12:00:00');
      due.setMonth(due.getMonth() + i);
      const r = db.prepare('INSERT INTO charges (num, client_id, order_id, description, value, due_date, status, installments, current_installment, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(num, client_id, order_id || null, installments > 1 ? `${description} ${i+1}/${installments}` : description, baseVal, due.toISOString().slice(0,10), 'rascunho', installments, i+1, notes || '');
      created.push(r.lastInsertRowid);
    }
    return res.json({ created, count: installments });
  }
  const num = `COB-${padNum(count + 1)}`;
  const r = db.prepare('INSERT INTO charges (num, client_id, order_id, description, value, due_date, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(num, client_id, order_id || null, description, value, due_date, 'rascunho', notes || '');
  res.json(db.prepare('SELECT * FROM charges WHERE id = ?').get(r.lastInsertRowid));
});

app.post('/api/charges/:id/approve', auth, (req, res) => {
  db.prepare("UPDATE charges SET status='aprovada', approved_by=?, approved_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(req.user.name, req.params.id);
  res.json({ ok: true });
});

app.post('/api/charges/:id/reject', auth, (req, res) => {
  db.prepare("UPDATE charges SET status='rascunho', approved_by=NULL, approved_at=NULL, updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/charges/:id/generate-pix', auth, async (req, res) => {
  const charge = db.prepare('SELECT ch.*, c.name as client_name, c.email as client_email, c.phone as client_phone FROM charges ch LEFT JOIN clients c ON ch.client_id = c.id WHERE ch.id = ?').get(req.params.id);
  if (!charge) return res.status(404).json({ error: 'Cobrança não encontrada' });
  const result = await generatePixLink({ chargeId: charge.id, description: charge.description, valueReais: charge.value, dueDate: charge.due_date, clientName: charge.client_name, clientEmail: charge.client_email, clientPhone: charge.client_phone });
  if (result.url) db.prepare("UPDATE charges SET pix_link=?, pix_invoice_slug=?, status='aprovada', updated_at=datetime('now') WHERE id=?").run(result.url, result.invoice_slug, charge.id);
  res.json({ ...result, chargeId: charge.id });
});

app.post('/api/charges/:id/send-whatsapp', auth, (req, res) => {
  const charge = db.prepare('SELECT ch.*, c.name as client_name, c.wapp as client_wapp FROM charges ch LEFT JOIN clients c ON ch.client_id = c.id WHERE ch.id = ?').get(req.params.id);
  if (!charge || !charge.pix_link) return res.status(400).json({ error: 'Gere o link PIX antes de enviar' });
  if (!charge.client_wapp) return res.status(400).json({ error: 'Cliente sem WhatsApp cadastrado' });
  const waLink = buildWhatsAppLink(charge.client_wapp, charge, { name: charge.client_name }, charge.pix_link);
  db.prepare("UPDATE charges SET sent_wapp=1, sent_at=datetime('now'), status='enviada', updated_at=datetime('now') WHERE id=?").run(charge.id);
  res.json({ ok: true, wa_link: waLink });
});

app.post('/api/charges/:id/mark-paid', auth, (req, res) => {
  db.prepare("UPDATE charges SET status='pago', paid_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/charges/:id', auth, (req, res) => { db.prepare('DELETE FROM charges WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

app.post('/api/webhook/infinitepay', (req, res) => {
  const payload = req.body;
  db.prepare('INSERT INTO webhook_logs (invoice_slug, order_nsu, amount, capture_method, raw_payload) VALUES (?, ?, ?, ?, ?)').run(payload.invoice_slug || null, payload.order_nsu || null, payload.amount || null, payload.capture_method || null, JSON.stringify(payload));
  if (payload.paid === true || payload.paid === 'true') {
    const chargeId = payload.order_nsu?.split('-')[1];
    let charge = chargeId ? db.prepare('SELECT * FROM charges WHERE id = ?').get(chargeId) : null;
    if (!charge && payload.invoice_slug) charge = db.prepare('SELECT * FROM charges WHERE pix_invoice_slug = ?').get(payload.invoice_slug);
    if (charge) db.prepare("UPDATE charges SET status='pago', paid_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(charge.id);
  }
  res.status(200).json({ received: true });
});

app.get('/api/nfse', auth, (req, res) => res.json(db.prepare('SELECT n.*, c.name as client_name FROM nfse n LEFT JOIN clients c ON n.client_id = c.id ORDER BY n.id DESC').all()));

app.post('/api/nfse', auth, (req, res) => {
  const { charge_id } = req.body;
  const charge = db.prepare('SELECT * FROM charges WHERE id = ?').get(charge_id);
  if (!charge) return res.status(404).json({ error: 'Cobrança não encontrada' });
  const counter = parseInt(db.prepare("SELECT value FROM settings WHERE key='nfse_counter'").get()?.value || '1');
  const num = `${new Date().getFullYear()}/${padNum(counter)}`;
  const iss = Math.round(charge.value * 0.05 * 100) / 100;
  const r = db.prepare('INSERT INTO nfse (charge_id, client_id, num, value, iss, aliquota, description) VALUES (?, ?, ?, ?, ?, ?, ?)').run(charge_id, charge.client_id, num, charge.value, iss, 5, charge.description);
  db.prepare("UPDATE charges SET nfse=1 WHERE id=?").run(charge_id);
  db.prepare("UPDATE settings SET value=?, updated_at=datetime('now') WHERE key='nfse_counter'").run(String(counter + 1));
  res.json({ id: r.lastInsertRowid, num, value: charge.value, iss, aliquota: 5 });
});

app.get('/api/subscriptions', auth, (req, res) => res.json(db.prepare('SELECT s.*, c.name as client_name FROM subscriptions s LEFT JOIN clients c ON s.client_id = c.id ORDER BY s.id DESC').all()));

app.post('/api/subscriptions', auth, (req, res) => {
  const { client_id, description, value, cycle, next_date, status } = req.body;
  const r = db.prepare('INSERT INTO subscriptions (client_id, description, value, cycle, next_date, status) VALUES (?, ?, ?, ?, ?, ?)').run(client_id, description, value, cycle || 'mensal', next_date, status || 'ativo');
  res.json(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/subscriptions/:id', auth, (req, res) => {
  const { description, value, cycle, next_date, status } = req.body;
  db.prepare('UPDATE subscriptions SET description=?, value=?, cycle=?, next_date=?, status=? WHERE id=?').run(description, value, cycle, next_date, status, req.params.id);
  res.json(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id));
});

app.delete('/api/subscriptions/:id', auth, (req, res) => { db.prepare('DELETE FROM subscriptions WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/ruler', auth, (req, res) => res.json(db.prepare('SELECT * FROM ruler_steps ORDER BY days_offset').all()));

app.post('/api/ruler', auth, (req, res) => {
  const { steps } = req.body;
  db.prepare('DELETE FROM ruler_steps').run();
  const insert = db.prepare('INSERT INTO ruler_steps (days_offset, channel, active, message) VALUES (?, ?, ?, ?)');
  steps.forEach(s => insert.run(s.days_offset, s.channel, s.active ? 1 : 0, s.message || ''));
  res.json({ ok: true });
});

app.get('/api/extract', auth, (req, res) => res.json(db.prepare('SELECT ch.*, c.name as client_name FROM charges ch LEFT JOIN clients c ON ch.client_id = c.id ORDER BY COALESCE(ch.paid_at, ch.due_date) DESC').all()));

app.get('/api/settings', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.post('/api/settings', auth, (req, res) => {
  const { key, value } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, handle: HANDLE, time: new Date().toISOString() }));

app.get('/pagamento/obrigado', (req, res) => res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Pago!</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f4f8;margin:0}.box{background:#fff;border-radius:16px;padding:2rem;text-align:center;max-width:400px}h1{color:#15803d}p{color:#475569}</style></head><body><div class="box"><h1>✅ Pago!</h1><p>Pagamento via PIX confirmado.<br>Obrigado, <strong>LS Auto Truck</strong>!</p></div></body></html>`));

app.listen(PORT, () => { console.log(`🚛 LS Auto Truck Backend rodando na porta ${PORT}`); console.log(`💰 InfinitePay Handle: ${HANDLE}`); });
