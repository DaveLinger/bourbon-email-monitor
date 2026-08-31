'use strict';

// Interactive triage. Categories 5 (action required) and 6 (uncategorized) go to
// the alerts channel for a human to look at; this module puts CONFIRM buttons on
// that post so the email can be promoted into the real releases/regional channel
// with one click.
//
// Why a gateway bot: webhook messages can't carry components unless the webhook
// is application-owned, and nothing receives the click either. So the triage post
// is sent by the bot (the same bot that already creates scheduled events) over a
// discord.js gateway connection, which is also how the button click comes back.
// No inbound HTTP / public endpoint needed.
//
// Everything is best-effort: if the bot can't log in or can't post to the alerts
// channel (missing permissions), we fall back to the plain webhook triage post
// that existed before — a triage email is never silently dropped.

const path = require('path');
const fs = require('fs');
const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');

const { postToDiscord, editDiscordMessage, buildMessageText } = require('./notify');
const { getEmail, setTriageOutcome, getKnownEvent, upsertKnownEvent } = require('./db');
const { syncCalendarEvent } = require('./events');

const CUSTOM_ID_PREFIX = 'emtri';
const DISCORD_CONTENT_LIMIT = 2000;

const state = {
  client: null,
  ready: false,
  alertsChannelId: null,
  config: null,
  db: null,
};

// Clicks currently being processed, so a double-click can't double-post.
const inFlight = new Set();

// --- Startup -------------------------------------------------------------

// The alerts channel id isn't in config — derive it from the alerts webhook
// (a webhook object carries its channel_id) so there's nothing new to configure.
async function resolveAlertsChannelId(config) {
  if (config.discord_alerts_channel_id) return config.discord_alerts_channel_id;
  const res = await fetch(config.discord_alerts_webhook_url);
  if (!res.ok) throw new Error(`Could not read alerts webhook (${res.status})`);
  const hook = await res.json();
  if (!hook.channel_id) throw new Error('Alerts webhook has no channel_id');
  return hook.channel_id;
}

// Log in and wire up the button handler. Returns true if interactive triage is
// live. Never throws — a failure just means we keep using the webhook path.
async function initTriageBot(config, db) {
  if (config.interactive_triage === false) {
    console.log('Interactive triage disabled by config');
    return false;
  }
  if (!config.discord_bot_token) {
    console.log('Interactive triage off: no discord_bot_token');
    return false;
  }

  state.config = config;
  state.db = db;

  try {
    state.alertsChannelId = await resolveAlertsChannelId(config);

    const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Message] });
    client.on('interactionCreate', interaction => {
      handleInteraction(interaction).catch(err =>
        console.error(`Triage interaction failed: ${err.message}`));
    });
    client.on('error', err => console.error(`Triage gateway error: ${err.message}`));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway login timed out')), 30000);
      client.once('clientReady', () => { clearTimeout(timer); resolve(); });
      client.login(config.discord_bot_token).catch(err => { clearTimeout(timer); reject(err); });
    });

    state.client = client;
    state.ready = true;
    console.log(`Interactive triage ready as ${client.user.tag} (alerts channel ${state.alertsChannelId})`);
    return true;
  } catch (err) {
    console.warn(`Interactive triage unavailable (${err.message}) — falling back to webhook triage posts`);
    state.ready = false;
    return false;
  }
}

function isTriageInteractive() {
  return state.ready && !!state.client;
}

// --- Posting the triage message -----------------------------------------

function buildButtons(gmailId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:national:${gmailId}`)
      .setLabel('Confirm → National')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:regional:${gmailId}`)
      .setLabel('Confirm → Regional')
      .setEmoji('📍')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:dismiss:${gmailId}`)
      .setLabel('Dismiss')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Secondary),
  );
}

// Post the triage message as the bot, with confirm buttons attached. Deliberately
// plain REST rather than the gateway client: posting needs no gateway, so one-off
// tools (retriage.js) can post buttons without opening a second gateway session on
// the same token — which would make every click get handled twice.
// Throws on failure so the caller can fall back to the webhook post.
async function postTriageForReview(config, gmailId, emailData, analysis, screenshotPath) {
  const channelId = state.alertsChannelId || await resolveAlertsChannelId(config);
  const content = buildMessageText(emailData, analysis, false, false, null).slice(0, DISCORD_CONTENT_LIMIT);
  const payload = {
    content,
    components: [buildButtons(gmailId).toJSON()],
    allowed_mentions: { parse: [] },
  };

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const headers = { Authorization: `Bot ${config.discord_bot_token}` };
  let res;
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', new Blob([fs.readFileSync(screenshotPath)], { type: 'image/png' }), path.basename(screenshotPath));
    res = await fetch(url, { method: 'POST', headers, body: form });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  if (!res.ok) throw new Error(`Triage post failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).id;
}

// --- Handling the click --------------------------------------------------

function isTriageButton(interaction) {
  return interaction.isButton() && interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
}

// Categories the alerts channel parks for a human decision. Confirming one turns
// it into a plain announcement (category 2 unlocks dedup + the calendar).
const REVIEW_CATEGORIES = [5, 6];

// Prefixes postForReview (index.js) puts on the alerts-channel title, stripped
// back off when the email is promoted into a real channel.
const REVIEW_TITLE_PREFIX = /^(?:⚠️\s*Triage needed|📬\s*Action required):\s*/;

// The stored analysis, adjusted for a human-confirmed post: it's a real
// announcement now (category 2 unlocks dedup + the calendar), routed per the
// button that was clicked, and never pinging @everyone — a human promoting an
// email the classifier couldn't place shouldn't wake the whole server.
function confirmedAnalysis(stored, route) {
  return {
    ...stored,
    category: REVIEW_CATEGORIES.includes(stored.category) ? 2 : stored.category,
    is_regional: route === 'regional',
    is_ping_worthy_imminent: false,
    discord_title: String(stored.discord_title || '').replace(REVIEW_TITLE_PREFIX, ''),
  };
}

// Append a footer to the triage message and drop the buttons, so the message
// itself records what was decided and can't be acted on twice.
async function sealTriageMessage(interaction, footer) {
  const content = `${interaction.message.content}\n${footer}`.slice(0, DISCORD_CONTENT_LIMIT);
  await interaction.message.edit({ content, components: [], allowedMentions: { parse: [] } });
}

async function handleInteraction(interaction) {
  if (!isTriageButton(interaction)) return;
  const [, action, gmailId] = interaction.customId.split(':');
  const { config, db } = state;

  if (inFlight.has(gmailId)) {
    await interaction.reply({ content: 'That one is already being handled — hang on.', flags: MessageFlags.Ephemeral });
    return;
  }
  inFlight.add(gmailId);

  // Ack within Discord's 3s window; the repost itself takes longer than that.
  await interaction.deferUpdate();

  try {
    const row = getEmail(db, gmailId);
    if (!row) {
      await interaction.followUp({ content: `No stored record for email \`${gmailId}\` — can't repost it.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (row.triage_route) {
      await sealTriageMessage(interaction, `-# Already resolved: **${row.triage_route}**`);
      return;
    }

    if (action === 'dismiss') {
      setTriageOutcome(db, gmailId, { route: 'dismissed', discordMessageId: null });
      await sealTriageMessage(interaction, `-# 🗑️ Dismissed by ${interaction.user.username}`);
      console.log(`[${gmailId}] Triage dismissed by ${interaction.user.tag}`);
      return;
    }

    const route = action === 'regional' ? 'regional' : 'national';
    const stored = row.llm_response ? JSON.parse(row.llm_response) : null;
    if (!stored) {
      await interaction.followUp({ content: `Stored analysis for \`${gmailId}\` is missing — can't rebuild the post.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const analysis = confirmedAnalysis(stored, route);
    const emailData = { from: row.from_addr, subject: row.subject };
    const webhook = route === 'regional'
      ? config.discord_regional_webhook_url
      : config.discord_releases_webhook_url;
    const screenshotPath = row.screenshot_path && fs.existsSync(row.screenshot_path) ? row.screenshot_path : null;

    const postedId = await postToDiscord(webhook, emailData, analysis, screenshotPath, { pingEveryone: false });
    console.log(`[${gmailId}] Triage confirmed → ${route} by ${interaction.user.tag} (message ${postedId})`);

    // Calendar + dedup parity with the normal posting path, so a follow-up email
    // for this event dedupes against the confirmed post instead of re-triaging.
    let eventId = null;
    if (analysis.event_key) {
      const existing = getKnownEvent(db, analysis.event_key, config.dedup_window_days);
      eventId = existing?.discord_event_id || null;
      if (config.calendar_enabled) {
        try {
          const synced = await syncCalendarEvent(config, analysis, eventId);
          eventId = synced.eventId;
          if (synced.action !== 'skipped') console.log(`[${gmailId}] Calendar event ${synced.action} (${eventId})`);
        } catch (err) {
          console.error(`[${gmailId}] Calendar sync failed after triage confirm: ${err.message}`);
        }
      }
      if (eventId && postedId) {
        const eventUrl = `https://discord.com/events/${config.discord_guild_id}/${eventId}`;
        await editDiscordMessage(webhook, postedId, emailData, analysis, { eventUrl })
          .catch(err => console.warn(`[${gmailId}] Failed to add event link: ${err.message}`));
      }
      upsertKnownEvent(db, analysis.event_key, gmailId, postedId, analysis, eventId);
    }

    setTriageOutcome(db, gmailId, { route, discordMessageId: postedId });

    const label = route === 'regional' ? 'regional' : 'national releases';
    const jump = await jumpLink(config, webhook, postedId);
    await sealTriageMessage(
      interaction,
      `-# ✅ Confirmed by ${interaction.user.username} → posted to **${label}**${jump ? ` · ${jump}` : ''}`
    );
  } catch (err) {
    console.error(`[${gmailId}] Triage confirm failed: ${err.message}`);
    // Buttons are left in place so it can simply be clicked again.
    await interaction.followUp({ content: `❌ Repost failed: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  } finally {
    inFlight.delete(gmailId);
  }
}

// Jump link to the reposted message. The webhook object carries the channel id;
// cached per webhook since it never changes.
const channelIdCache = new Map();
async function jumpLink(config, webhookUrl, messageId) {
  if (!messageId || !config.discord_guild_id) return null;
  try {
    if (!channelIdCache.has(webhookUrl)) {
      const res = await fetch(webhookUrl);
      if (!res.ok) return null;
      channelIdCache.set(webhookUrl, (await res.json()).channel_id);
    }
    const channelId = channelIdCache.get(webhookUrl);
    return channelId ? `https://discord.com/channels/${config.discord_guild_id}/${channelId}/${messageId}` : null;
  } catch {
    return null;
  }
}

module.exports = { initTriageBot, isTriageInteractive, postTriageForReview, REVIEW_CATEGORIES };
