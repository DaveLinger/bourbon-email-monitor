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
       discord_posted, discord_message_id, llm_response)
    VALUES
      (@id, @received_at, @from_addr, @subject, @category, @event_key, @summary,
       @structured_fields, @desirability_score, @screenshot_path,
       @discord_posted, @discord_message_id, @llm_response)
  `).run(data);
}

function getKnownEvent(db, eventKey) {
  return db.prepare('SELECT * FROM known_events WHERE event_key = ?').get(eventKey);
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

module.exports = { getDb, isProcessed, insertEmail, getKnownEvent, upsertKnownEvent };
