import Database from 'better-sqlite3';

const db = new Database('./pixbot.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_code TEXT UNIQUE NOT NULL,
  discord_user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 500,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  provider_txid TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
`);

export const createPayment = (p) => {
  const stmt = db.prepare(`
    INSERT INTO payments (reference_code, discord_user_id, nickname, amount_cents, status, created_at)
    VALUES (@reference_code, @discord_user_id, @nickname, @amount_cents, 'pending', @created_at)
  `);
  const info = stmt.run(p);
  return { ...p, id: info.lastInsertRowid };
};

export const getPaymentByReference = (ref) => {
  return db.prepare(`SELECT * FROM payments WHERE reference_code = ?`).get(ref);
};

export const markPaid = (ref, provider_txid) => {
  return db.prepare(`
    UPDATE payments SET status='paid', paid_at=datetime('now'), provider_txid=? WHERE reference_code=?
  `).run(provider_txid, ref);
};
