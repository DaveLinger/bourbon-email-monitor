'use strict';

// One-shot backlog backfill: walk the emails table and create Discord scheduled
// events for already-processed cat 2/3/4 items whose date is still in the future.
//
// These rows predate the calendar feature, so their stored llm_response has no
// calendar fields and we don't keep full email bodies — instead we run a small
// LLM pass over each row's stored analysis to extract a date/title/location.
//
// Dry-run by default (prints a plan). Pass --commit to actually create events.
//
//   node backfill-calendar.js            # preview
//   node backfill-calendar.js --commit   # create

const Anthropic = require('@anthropic-ai/sdk');
const { loadConfig } = require('./config');
const { getDb, getKnownEvent } = require('./db');
const { syncCalendarEvent, computeStartIso, isEligible } = require('./events');

const COMMIT = process.argv.includes('--commit');
const config = loadConfig();
const db = getDb(config.db_path);

const CAL_SCHEMA = {
  type: 'object',
  properties: {
    calendar_eligible: { type: 'boolean', description: 'true if this is a release/drop/lottery/event with a real date (today or future). false for undated/open-ended or already-past items.' },
    event_starts_now: { type: 'boolean', description: 'true if the ORIGINAL email described something available right now with no specific future date. (Backfill discards these as stale.)' },
    event_start_date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Calendar start date YYYY-MM-DD. For a vague window/range, use the START of the window. Null if none inferable.' },
    event_start_time: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Local 24h HH:MM if a specific time is given; null otherwise.' },
    event_title: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Short specific calendar title (<=60 chars).' },
    event_location: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Store/retailer name, city/state, "Online", or distribution channel. Null if unknown.' },
  },
  required: ['calendar_eligible', 'event_starts_now', 'event_start_date', 'event_start_time', 'event_title', 'event_location'],
  additionalProperties: false,
};

const today = new Date().toISOString().slice(0, 10);

async function extractCalendar(client, row) {
  const stored = row.llm_response ? JSON.parse(row.llm_response) : {};
  const sf = row.structured_fields ? JSON.parse(row.structured_fields) : {};
  const userText = [
    `Today's date is ${today} (timezone ${config.calendar_timezone}).`,
    `This is an already-classified bourbon email. From its stored details, extract calendar fields for the server's events calendar. Resolve relative dates against today. For date RANGES or vague windows, use the START of the window.`,
    '',
    `Subject: ${row.subject}`,
    `Received: ${row.received_at}`,
    `Category: ${row.category}`,
    '',
    '--- STORED ANALYSIS ---',
    JSON.stringify({ ...stored, ...sf }, null, 2),
  ].join('\n');

  const resp = await client.messages.create({
    model: config.model,
    max_tokens: 512,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CAL_SCHEMA } },
  });
  return JSON.parse(resp.content.find(b => b.type === 'text')?.text || '{}');
}

// Pick the latest row per event_key (dedups format-drift duplicates).
function latestRowsByKey() {
  const rows = db.prepare(`
    SELECT * FROM emails
    WHERE category IN (${config.calendar_categories.join(',')}) AND event_key IS NOT NULL
    ORDER BY processed_at ASC
  `).all();
  const byKey = new Map();
  for (const r of rows) byKey.set(r.event_key, r); // later rows overwrite -> latest wins
  return [...byKey.values()];
}

function setEventId(eventKey, sourceEmailId, eventId) {
  const upd = db.prepare('UPDATE known_events SET discord_event_id = ? WHERE event_key = ?').run(eventId, eventKey);
  if (upd.changes === 0) {
    db.prepare('INSERT INTO known_events (event_key, source_email_id, discord_event_id, posted_details) VALUES (?, ?, ?, ?)')
      .run(eventKey, sourceEmailId, eventId, '{}');
  }
}

(async () => {
  if (!config.calendar_enabled) { console.error('calendar_enabled is false — aborting.'); process.exit(1); }
  const client = new Anthropic({ apiKey: config.anthropic_api_key });
  const rows = latestRowsByKey();
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'} | ${rows.length} unique event_key(s) in cat ${JSON.stringify(config.calendar_categories)}\n`);

  // Cross-key dedup: format-drift event_keys can describe the same real-world
  // event (e.g. two keys for one launch party). Collapse plans that land on the
  // same date and share >=2 significant title words.
  const accepted = [];
  const sigWords = t => new Set((t || '').toLowerCase().match(/[a-z]{4,}/g) || []);
  const isDupOf = (date, words) => accepted.some(a =>
    a.date === date && [...words].filter(w => a.words.has(w)).length >= 2);

  let created = 0, skipped = 0;
  for (const row of rows) {
    const existing = getKnownEvent(db, row.event_key, 3650);
    if (existing && existing.discord_event_id) {
      console.log(`SKIP  already has event   | ${row.event_key}`);
      skipped++; continue;
    }

    let cal;
    try { cal = await extractCalendar(client, row); }
    catch (e) { console.log(`SKIP  extract failed (${e.message}) | ${row.event_key}`); skipped++; continue; }

    const analysis = { ...cal, category: row.category, event_key: row.event_key,
      summary: (row.summary || ''), discord_title: row.subject, region_availability: null, product_name: null };

    if (cal.event_starts_now) { console.log(`SKIP  stale "available now" | ${row.event_key}`); skipped++; continue; }

    const startIso = computeStartIso(analysis, config);
    if (!isEligible(analysis, config, startIso)) {
      console.log(`SKIP  no future date (${cal.event_start_date || 'none'}) | ${row.event_key}`);
      skipped++; continue;
    }

    const title = cal.event_title || row.subject;
    const words = sigWords(title);
    if (isDupOf(cal.event_start_date, words)) {
      console.log(`SKIP  duplicate of an accepted event | ${row.event_key}`);
      skipped++; continue;
    }
    accepted.push({ date: cal.event_start_date, words });

    const when = new Date(startIso).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    if (!COMMIT) {
      console.log(`PLAN  ${when} | "${cal.event_title || row.subject}" @ ${cal.event_location || '—'} | ${row.event_key}`);
      created++; continue;
    }
    try {
      const res = await syncCalendarEvent(config, analysis, existing?.discord_event_id || null);
      if (res.eventId && res.action !== 'skipped') {
        setEventId(row.event_key, row.id, res.eventId);
        console.log(`DONE  ${when} | ${res.action} ${res.eventId} | ${row.event_key}`);
        created++;
      } else {
        console.log(`SKIP  sync skipped | ${row.event_key}`); skipped++;
      }
    } catch (e) {
      console.log(`FAIL  ${e.message} | ${row.event_key}`); skipped++;
    }
  }
  console.log(`\n${COMMIT ? 'Created' : 'Would create'}: ${created} | Skipped: ${skipped}`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
