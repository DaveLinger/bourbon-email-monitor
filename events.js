'use strict';

// Discord Scheduled Events transport. Unlike notify.js (webhooks), this talks to
// the Discord REST API as a real bot — webhooks cannot create/modify scheduled
// events. Requires a bot in the guild with Create Events + Manage Events.
//
// Model: a date-bearing release/announcement becomes an EXTERNAL scheduled event
// in the server's Events tab. Vague windows ("next week") are dated to the START
// of the window with a noon-local placeholder time; follow-up emails PATCH the
// same event in place (event id tracked on known_events.discord_event_id).

const DISCORD_API = 'https://discord.com/api/v10';

// --- Timezone helpers ----------------------------------------------------
// Node has no built-in "wall time in IANA zone -> UTC instant". Compute the
// zone's offset at the target instant via Intl, then subtract it.
function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUtc - utcMs;
}

// Given a wall-clock date/time in `timeZone`, return the corresponding UTC ISO.
function zonedWallToUtcIso(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = tzOffsetMs(guess, timeZone);
  return new Date(guess - offset).toISOString();
}

// Build the UTC start instant for the calendar entry, or null if undatable.
// event_start_date is "YYYY-MM-DD"; event_start_time is "HH:MM" or null (noon default).
function computeStartIso(analysis, config) {
  const dateStr = analysis.event_start_date;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    let h = 12, mi = 0;
    if (analysis.event_start_time && /^\d{1,2}:\d{2}$/.test(analysis.event_start_time)) {
      [h, mi] = analysis.event_start_time.split(':').map(Number);
    }
    return zonedWallToUtcIso(y, mo, d, h, mi, config.calendar_timezone);
  }
  // "Available now" drop with no specific date: start a couple minutes out
  // (Discord rejects past/now start times) and run for the default duration.
  if (analysis.event_starts_now) {
    return new Date(Date.now() + 2 * 60 * 1000).toISOString();
  }
  return null;
}

function isEligible(analysis, config, startIso) {
  if (!config.calendar_categories.includes(analysis.category)) return false;
  if (!analysis.calendar_eligible) return false;
  if (!startIso) return false;
  // Discord rejects start times in the past; "available now" drops aren't "upcoming".
  if (new Date(startIso).getTime() <= Date.now() + 60 * 1000) return false;
  return true;
}

function buildEventPayload(analysis, startIso, config) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + config.calendar_event_minutes * 60 * 1000);
  const name = (analysis.event_title || analysis.discord_title || analysis.product_name || 'Bourbon release').slice(0, 100);
  const location = (analysis.event_location || analysis.region_availability || 'See announcement').slice(0, 100);
  const description = (analysis.summary || '').slice(0, 1000);
  return {
    name,
    privacy_level: 2,                  // GUILD_ONLY
    entity_type: 3,                    // EXTERNAL
    scheduled_start_time: start.toISOString(),
    scheduled_end_time: end.toISOString(),
    entity_metadata: { location },
    description,
  };
}

async function discordRequest(config, method, pathPart, body) {
  const res = await fetch(`${DISCORD_API}${pathPart}`, {
    method,
    headers: {
      Authorization: `Bot ${config.discord_bot_token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Discord API ${method} ${pathPart} failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Create or update the scheduled event for this analysis.
// Returns { eventId, action } — action is one of created/updated/recreated/skipped.
// eventId is the id to persist (falls back to existingEventId when nothing changed).
async function syncCalendarEvent(config, analysis, existingEventId) {
  const startIso = computeStartIso(analysis, config);
  if (!isEligible(analysis, config, startIso)) {
    return { eventId: existingEventId || null, action: 'skipped' };
  }

  const payload = buildEventPayload(analysis, startIso, config);
  const base = `/guilds/${config.discord_guild_id}/scheduled-events`;

  if (existingEventId) {
    try {
      await discordRequest(config, 'PATCH', `${base}/${existingEventId}`, payload);
      return { eventId: existingEventId, action: 'updated' };
    } catch (err) {
      // 404 (deleted) or 400 (already started/completed, no longer editable):
      // recreate so the refreshed date still surfaces on the calendar.
      if (err.status !== 404 && err.status !== 400) throw err;
    }
  }
  const created = await discordRequest(config, 'POST', base, payload);
  return { eventId: created.id, action: existingEventId ? 'recreated' : 'created' };
}

module.exports = { syncCalendarEvent, computeStartIso, isEligible };
