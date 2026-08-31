'use strict';

// One-shot: re-post a previously-processed email to the alerts channel WITH the
// triage confirm buttons. Useful for category 5/6 emails that landed in alerts
// before the buttons existed (or when the bot was missing channel permissions at
// the time), and as the way to test the button flow end to end.
//
//   node retriage.js                 # list unresolved alerts-channel emails
//   node retriage.js <gmail_id>      # re-post that one with buttons

const { loadConfig } = require('./config');
const { getDb, getEmail } = require('./db');
const { postTriageForReview, REVIEW_CATEGORIES } = require('./triage');

(async () => {
  const config = loadConfig();
  const db = getDb(config.db_path);
  const gmailId = process.argv[2];

  if (!gmailId) {
    const rows = db.prepare(`
      SELECT id, received_at, subject, category FROM emails
      WHERE category IN (${REVIEW_CATEGORIES.map(() => '?').join(',')}) AND triage_route IS NULL
      ORDER BY processed_at DESC LIMIT 20
    `).all(...REVIEW_CATEGORIES);
    if (!rows.length) return console.log('No unresolved alerts-channel emails.');
    console.log('Unresolved triage emails (newest first):\n');
    for (const r of rows) console.log(`  ${r.id}  [cat ${r.category}]  ${(r.subject || '').slice(0, 70)}`);
    console.log('\nRe-post one with: node retriage.js <id>');
    return;
  }

  const row = getEmail(db, gmailId);
  if (!row) throw new Error(`No stored email with id ${gmailId}`);
  if (row.triage_route) console.warn(`Note: already resolved as "${row.triage_route}" — re-posting anyway.`);

  const analysis = JSON.parse(row.llm_response);
  const emailData = { from: row.from_addr, subject: row.subject };
  const prefix = row.category === 5 ? '📬 Action required' : '⚠️ Triage needed';
  const triageAnalysis = { ...analysis, discord_title: `${prefix}: ${analysis.discord_title}` };
  // Posts over REST only — the running email-monitor daemon is what listens for
  // the click, so this script must not open its own gateway session (two sessions
  // on one bot token would each handle every click).
  const id = await postTriageForReview(config, row.id, emailData, triageAnalysis, row.screenshot_path);
  console.log(`Posted triage message ${id} for "${row.subject}"`);
  console.log('Clicks are handled by the running email-monitor daemon.');
})().catch(err => { console.error(err.message); process.exit(1); });
