'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let _db = null;

function getDb(dbPath) {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      received_at DATETIME,
      from_addr TEXT,
      subject TEXT,
      category INTEGER,
      event_key TEXT,
      summary TEXT,
      structured_fields TEXT,
      desirability_score INTEGER,
      screenshot_path TEXT,
      discord_posted INTEGER DEFAULT 0,
      discord_message_id TEXT,
      llm_response TEXT,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS known_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT UNIQUE,
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      source_email_id TEXT,
      discord_message_id TEXT,
      posted_details TEXT
    );
  `);
  // Migrations: add token columns if they don't exist yet
  for (const stmt of [
    'ALTER TABLE emails ADD COLUMN input_tokens INTEGER DEFAULT 0',
    'ALTER TABLE emails ADD COLUMN output_tokens INTEGER DEFAULT 0',
  ]) {
    try { _db.exec(stmt); } catch {}
  }
  return _db;
}

function isProcessed(db, gmailId) {
  const row = db.prepare('SELECT id FROM emails WHERE id = ?').get(gmailId);
  return !!row;
}

function insertEmail(db, data) {
  db.prepare(`
    INSERT OR REPLACE INTO emails
      (id, received_at, from_addr, subject, category, event_key, summary,
       structured_fields, desirability_score, screenshot_path,
       discord_posted, discord_message_id, llm_response,
       input_tokens, output_tokens)
    VALUES
      (@id, @received_at, @from_addr, @subject, @category, @event_key, @summary,
       @structured_fields, @desirability_score, @screenshot_path,
       @discord_posted, @discord_message_id, @llm_response,
       @input_tokens, @output_tokens)
  `).run(data);
}

function getLlmStats(db) {
  const todayStr = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC
  const today = db.prepare(`
    SELECT COUNT(*) as emails, COALESCE(SUM(discord_posted), 0) as posted,
           COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM emails WHERE processed_at >= ?
  `).get(todayStr);
  const month = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM emails WHERE processed_at >= date('now', 'start of month')
  `).get();
  const categories = db.prepare(`
    SELECT category, COUNT(*) as cnt FROM emails
    WHERE processed_at >= ? GROUP BY category ORDER BY category
  `).all(todayStr);
  return { today, month, categories };
}

function getKnownEvent(db, eventKey, windowDays = 30) {
  return db.prepare(
    `SELECT * FROM known_events WHERE event_key = ? AND last_updated_at >= datetime('now', '-' || ? || ' days')`
  ).get(eventKey, windowDays);
}

function upsertKnownEvent(db, eventKey, emailId, discordMessageId, postedDetails) {
  const existing = getKnownEvent(db, eventKey);
  if (existing) {
    db.prepare(`
      UPDATE known_events
      SET last_updated_at = CURRENT_TIMESTAMP,
          source_email_id = ?,
          discord_message_id = ?,
          posted_details = ?
      WHERE event_key = ?
    `).run(emailId, discordMessageId, JSON.stringify(postedDetails), eventKey);
  } else {
    db.prepare(`
      INSERT INTO known_events (event_key, source_email_id, discord_message_id, posted_details)
      VALUES (?, ?, ?, ?)
    `).run(eventKey, emailId, discordMessageId, JSON.stringify(postedDetails));
  }
}

module.exports = { getDb, isProcessed, insertEmail, getKnownEvent, upsertKnownEvent, getLlmStats };
