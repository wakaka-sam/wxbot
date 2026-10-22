import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(join(dir, 'clawbot.sqlite'));
    chmodSync(join(dir, 'clawbot.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS send_receipts (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS codex_jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        scope TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);`);
  }
  get(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
  }
  key(accountId, message) {
    const identifier = message.message_id ?? message.client_id ??
      createHash('sha256').update(JSON.stringify(message)).digest('hex');
    return `${accountId}:${message.from_user_id}:${identifier}`;
  }
  has(id) { return Boolean(this.db.prepare('SELECT 1 FROM seen WHERE id=?').get(id)); }
  ingest(messages, cursorKey, cursor, settings = [], jobs = []) {
    this.db.exec('BEGIN IMMEDIATE');
    const added = [];
    try {
      for (const message of messages) {
        const result = this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?)').run(message.id);
        if (result.changes) {
          this.db.prepare('INSERT INTO messages (id,payload) VALUES (?,?)').run(message.id, JSON.stringify(message));
          added.push(message);
          const job = jobs.find(j => j.id === message.id);
          if (job) this.addCodexJob(job);
        }
      }
      if (typeof cursor === 'string') this.set(cursorKey, cursor);
      for (const [key, value] of settings) this.set(key, value);
      this.db.exec('COMMIT');
      return added;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addCodexJob(job) {
    this.db.prepare('INSERT OR IGNORE INTO codex_jobs (id,scope,status,payload) VALUES (?,?,?,?)')
      .run(job.id, job.scope, job.status, JSON.stringify(job));
  }
  codexJob(id) {
    const row = this.db.prepare('SELECT seq,payload FROM codex_jobs WHERE id=?').get(id);
    return row ? { ...JSON.parse(row.payload), seq: row.seq } : null;
  }
  codexJobs(scope, limit = 20) {
    return this.db.prepare('SELECT seq,payload FROM codex_jobs WHERE scope=? ORDER BY seq DESC LIMIT ?')
      .all(scope, limit).reverse().map(row => ({ ...JSON.parse(row.payload), seq: row.seq }));
  }
  updateCodexJob(id, patch) {
    const current = this.codexJob(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE codex_jobs SET status=?,payload=? WHERE id=?').run(next.status, JSON.stringify(next), id);
    return next;
  }
  recoverCodexJobs() {
    for (const row of this.db.prepare("SELECT id FROM codex_jobs WHERE status='running'").all()) {
      this.updateCodexJob(row.id, { status: 'replying', outcome: 'interrupted',
        reply: '上一次 Codex 执行因服务重启而中断。上下文已保留；请发送下一条指令继续。未自动重跑原任务。',
        activity: '上轮中断，等待下一条指令' });
    }
  }
  receipt(id) { return this.db.prepare('SELECT * FROM send_receipts WHERE id=?').get(id); }
  beginSend(message, hash) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO send_receipts (id,hash,status) VALUES (?,?,?)').run(message.id, hash, 'sending');
      this.db.prepare('INSERT INTO messages (id,payload) VALUES (?,?)').run(message.id, JSON.stringify(message));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setSendAttachments(id, attachments) {
    const row = this.db.prepare('SELECT payload FROM messages WHERE id=?').get(id);
    if (row) this.db.prepare('UPDATE messages SET payload=? WHERE id=?')
      .run(JSON.stringify({ ...JSON.parse(row.payload), attachments }), id);
  }
  finishSend(id, status, error = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE send_receipts SET status=?, error=? WHERE id=?').run(status, error, id);
      const row = this.db.prepare('SELECT payload FROM messages WHERE id=?').get(id);
      if (row) {
        const message = { ...JSON.parse(row.payload), status, error };
        this.db.prepare('UPDATE messages SET payload=? WHERE id=?').run(JSON.stringify(message), id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recoverSends() {
    for (const row of this.db.prepare("SELECT id FROM send_receipts WHERE status='sending'").all()) {
      this.finishSend(row.id, 'unknown', '服务在发送期间重启，结果未知，请先在微信确认是否收到');
    }
  }
  messages(limit = 500) {
    return this.db.prepare('SELECT payload FROM messages ORDER BY seq DESC LIMIT ?')
      .all(limit).reverse().map(row => JSON.parse(row.payload));
  }
  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n; }
  clear() {
    // Keep deduplication receipts so a replay cannot resurrect cleared messages.
    this.db.exec('DELETE FROM messages; DELETE FROM codex_jobs;');
  }
  close() { this.db.close(); }
}
