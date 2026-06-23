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

    -- Tracks emails that THREW during processing (classification/screenshot/etc.)
    -- and were left unread + unstored to retry next poll. Lets us alert once a
    -- failure streak crosses a threshold instead of retrying silently forever.
    -- Rows are deleted as soon as the email processes cleanly.
    CREATE TABLE IF NOT EXISTS processing_failures (
      message_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_failed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_failed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      alerted INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Migrations: add columns if they don't exist yet
  for (const stmt of [
    'ALTER TABLE emails ADD COLUMN input_tokens INTEGER DEFAULT 0',
    'ALTER TABLE emails ADD COLUMN output_tokens INTEGER DEFAULT 0',
    'ALTER TABLE known_events ADD COLUMN discord_event_id TEXT',
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
  // Rolling trailing 24h window — same span regardless of when the heartbeat
  // fires (day rollover vs. a restart mid-day). Stored timestamps and
  // datetime('now') are both UTC, so the comparison is internally consistent.
  const recent = db.prepare(`
    SELECT COUNT(*) as emails, COALESCE(SUM(discord_posted), 0) as posted,
           COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM emails WHERE processed_at >= datetime('now', '-1 day')
  `).get();
  const month = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
           COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM emails WHERE processed_at >= date('now', 'start of month')
  `).get();
  const categories = db.prepare(`
    SELECT category, COUNT(*) as cnt FROM emails
    WHERE processed_at >= datetime('now', '-1 day') GROUP BY category ORDER BY category
  `).all();
  return { recent, month, categories };
}

// Canonical form for matching: lowercase, punctuation/separators collapsed to a
// single hyphen. Catches pure separator/case drift ("a_b_c" vs "a b c") with no
// risk of merging semantically different keys. Semantic drift (different words
// for the same event) is handled upstream by LLM key-reuse, not here.
function canonicalizeKey(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function getKnownEvent(db, eventKey, windowDays = 30) {
  const target = canonicalizeKey(eventKey);
  if (!target) return undefined;
  const rows = db.prepare(
    `SELECT * FROM known_events WHERE last_updated_at >= datetime('now', '-' || ? || ' days')`
  ).all(windowDays);
  return rows.find(r => canonicalizeKey(r.event_key) === target);
}

// Recent events offered to the classifier as reuse candidates, newest first.
function getRecentEvents(db, windowDays = 30, limit = 40) {
  return db.prepare(
    `SELECT event_key, posted_details FROM known_events
     WHERE last_updated_at >= datetime('now', '-' || ? || ' days')
     ORDER BY last_updated_at DESC LIMIT ?`
  ).all(windowDays, limit);
}

// discordEventId is the Discord scheduled-event id. Pass null to leave any
// existing value untouched (COALESCE) — calendar sync is best-effort and must
// never wipe a previously stored event id when it's skipped or fails.
function upsertKnownEvent(db, eventKey, emailId, discordMessageId, postedDetails, discordEventId = null) {
  // Match across all ages (not just the dedup window) so a re-seen old event
  // updates its row rather than INSERTing a duplicate / colliding on UNIQUE.
  const existing = getKnownEvent(db, eventKey, 36500);
  if (existing) {
    db.prepare(`
      UPDATE known_events
      SET last_updated_at = CURRENT_TIMESTAMP,
          source_email_id = ?,
          discord_message_id = ?,
          discord_event_id = COALESCE(?, discord_event_id),
          posted_details = ?
      WHERE id = ?
    `).run(emailId, discordMessageId, discordEventId, JSON.stringify(postedDetails), existing.id);
  } else {
    db.prepare(`
      INSERT INTO known_events (event_key, source_email_id, discord_message_id, discord_event_id, posted_details)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventKey, emailId, discordMessageId, discordEventId, JSON.stringify(postedDetails));
  }
}

// Record one failed processing attempt for an email, returning the updated row
// ({ attempts, alerted, first_failed_at }) so the caller can decide whether to
// alert. Increments on each consecutive failed poll.
function recordProcessingFailure(db, messageId, errMsg) {
  db.prepare(`
    INSERT INTO processing_failures (message_id, attempts, last_error)
    VALUES (?, 1, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      attempts = attempts + 1,
      last_failed_at = CURRENT_TIMESTAMP,
      last_error = excluded.last_error
  `).run(messageId, errMsg);
  return db.prepare('SELECT attempts, alerted, first_failed_at FROM processing_failures WHERE message_id = ?').get(messageId);
}

function markFailureAlerted(db, messageId) {
  db.prepare('UPDATE processing_failures SET alerted = 1 WHERE message_id = ?').run(messageId);
}

// Called when an email processes cleanly — clears any prior failure streak so a
// later, unrelated failure starts counting fresh (and re-alerts if needed).
function clearProcessingFailure(db, messageId) {
  db.prepare('DELETE FROM processing_failures WHERE message_id = ?').run(messageId);
}

module.exports = { getDb, isProcessed, insertEmail, getKnownEvent, getRecentEvents, upsertKnownEvent, getLlmStats, canonicalizeKey, recordProcessingFailure, markFailureAlerted, clearProcessingFailure };
