'use strict';
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./config');
const { getDb, isProcessed, insertEmail, getKnownEvent, upsertKnownEvent, getLlmStats } = require('./db');
const { authenticate, getEmailAddress, fetchUnreadIds, getMessage, markAsRead } = require('./gmail');
const { launchBrowser, renderEmailToScreenshot } = require('./screenshot');
const { analyzeEmail } = require('./classify');
const { postToDiscord, postAlert, postHeartbeat } = require('./notify');

const config = loadConfig();
const db = getDb(config.db_path);
fs.mkdirSync(config.screenshot_dir, { recursive: true });

let lastDailyDate = null;

async function runDailyMaintenance() {
  // Clean up screenshots older than 30 days
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  try {
    for (const file of fs.readdirSync(config.screenshot_dir)) {
      if (!file.endsWith('.png')) continue;
      const filePath = path.join(config.screenshot_dir, file);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) console.log(`Cleaned up ${cleaned} old screenshot(s)`);
  } catch (err) {
    console.warn(`Screenshot cleanup failed: ${err.message}`);
  }

  // Post heartbeat with email counts and LLM cost over a trailing 24h window
  try {
    const stats = getLlmStats(db);
    await postHeartbeat(config.discord_alerts_webhook_url, stats, config);
    console.log('Heartbeat posted');
  } catch (err) {
    console.error(`Heartbeat failed: ${err.message}`);
  }
}

// --- Category handlers ---------------------------------------------------
//
// Each handler takes a context object and returns a result describing what to
// store. Recognized result fields:
//   discordPosted     {boolean}  a Discord post succeeded
//   discordMessageId  {string}   the posted message id
//   postHardFailed    {boolean}  an intended post failed after retries; the
//                                caller leaves the email unread + unstored so
//                                the next poll reprocesses it
//   analysis          {object}   an analysis to store in place of the original
//                                (used when a known-event update is re-analyzed)
//   tokens            {object}   {input, output} extra LLM tokens to account

async function handleAd(ctx) {
  console.log(`[${ctx.messageId}] Category 1 (ad), discarding`);
  return {};
}

async function handleActionRequired(ctx) {
  const { config, messageId, emailData, analysis, screenshotPath } = ctx;
  console.log(`[${messageId}] Category 5 (action required), posting to alerts`);
  try {
    const actionAnalysis = { ...analysis, discord_title: `📬 Action required: ${analysis.discord_title}` };
    await postToDiscord(config.discord_alerts_webhook_url, emailData, actionAnalysis, screenshotPath, false);
    return { discordPosted: true };
  } catch (err) {
    console.error(`[${messageId}] Action required post failed: ${err.message}`);
    return { postHardFailed: true };
  }
}

async function handleTriage(ctx) {
  const { config, messageId, emailData, analysis, screenshotPath } = ctx;
  console.log(`[${messageId}] Category 6 (uncategorized), posting to alerts for triage`);
  try {
    const triageAnalysis = { ...analysis, discord_title: `⚠️ Triage needed: ${analysis.discord_title}` };
    await postToDiscord(config.discord_alerts_webhook_url, emailData, triageAnalysis, screenshotPath, false);
    return { discordPosted: true };
  } catch (err) {
    console.error(`[${messageId}] Triage alert post failed: ${err.message}`);
    return { postHardFailed: true };
  }
}

async function handleImmediateRelease(ctx) {
  const { db, config, messageId, emailData, analysis, screenshotPath } = ctx;
  const webhook = analysis.is_regional ? config.discord_regional_webhook_url : config.discord_releases_webhook_url;
  console.log(`[${messageId}] Category 3 (immediate release), posting to Discord (${analysis.is_regional ? 'regional' : 'releases'})`);
  try {
    const discordMessageId = await postToDiscord(webhook, emailData, analysis, screenshotPath, false);
    console.log(`[${messageId}] Posted to Discord (message ${discordMessageId})`);
    if (analysis.event_key) upsertKnownEvent(db, analysis.event_key, messageId, discordMessageId, analysis);
    return { discordPosted: true, discordMessageId };
  } catch (err) {
    console.error(`[${messageId}] Discord post failed: ${err.message}`);
    await postAlert(config.discord_alerts_webhook_url, `Failed to post release alert for "${emailData.subject}": ${err.message} — will retry next poll`);
    return { postHardFailed: true };
  }
}

async function handleAnnouncement(ctx) {
  const { db, config, messageId, emailData, analysis, screenshotPath } = ctx;

  // Skip low-desirability category 4 (generic retailer sales)
  if (analysis.category === 4 && analysis.desirability_score < config.min_desirability_cat4) {
    console.log(`[${messageId}] Category 4 with desirability ${analysis.desirability_score} < threshold (${config.min_desirability_cat4}), skipping`);
    return {};
  }

  const webhook = analysis.is_regional ? config.discord_regional_webhook_url : config.discord_releases_webhook_url;
  const knownEvent = analysis.event_key ? getKnownEvent(db, analysis.event_key, config.dedup_window_days) : null;

  if (!knownEvent) {
    // New event — post it
    console.log(`[${messageId}] New event, posting to Discord (${analysis.is_regional ? 'regional' : 'releases'})`);
    try {
      const discordMessageId = await postToDiscord(webhook, emailData, analysis, screenshotPath, false);
      console.log(`[${messageId}] Posted to Discord (message ${discordMessageId})`);
      if (analysis.event_key) upsertKnownEvent(db, analysis.event_key, messageId, discordMessageId, analysis);
      return { discordPosted: true, discordMessageId };
    } catch (err) {
      console.error(`[${messageId}] Discord post failed: ${err.message}`);
      await postAlert(config.discord_alerts_webhook_url, `Failed to post announcement for "${emailData.subject}": ${err.message} — will retry next poll`);
      return { postHardFailed: true };
    }
  }

  // Known event — re-classify with previous details to check for a meaningful update
  console.log(`[${messageId}] Known event, checking for meaningful update...`);
  const previousDetails = knownEvent.posted_details ? JSON.parse(knownEvent.posted_details) : null;
  const updateAnalysis = await analyzeEmail(config.anthropic_api_key, config.model, emailData, screenshotPath, previousDetails);
  const tokens = { input: updateAnalysis._input_tokens || 0, output: updateAnalysis._output_tokens || 0 };

  if (!updateAnalysis.is_meaningful_update) {
    console.log(`[${messageId}] Duplicate with no new info, skipping Discord`);
    return { tokens };
  }

  console.log(`[${messageId}] Meaningful update found: ${updateAnalysis.update_summary}`);
  try {
    const discordMessageId = await postToDiscord(webhook, emailData, updateAnalysis, screenshotPath, true);
    console.log(`[${messageId}] Update posted to Discord (message ${discordMessageId})`);
    upsertKnownEvent(db, updateAnalysis.event_key, messageId, discordMessageId, updateAnalysis);
    return { discordPosted: true, discordMessageId, analysis: updateAnalysis, tokens };
  } catch (err) {
    console.error(`[${messageId}] Discord post failed: ${err.message}`);
    await postAlert(config.discord_alerts_webhook_url, `Failed to post update alert for "${emailData.subject}": ${err.message} — will retry next poll`);
    return { postHardFailed: true, tokens };
  }
}

const CATEGORY_HANDLERS = {
  1: handleAd,
  2: handleAnnouncement,
  3: handleImmediateRelease,
  4: handleAnnouncement,
  5: handleActionRequired,
  6: handleTriage,
};

async function processEmail(auth, messageId, browser) {
  if (isProcessed(db, messageId)) {
    console.log(`[${messageId}] Already processed, skipping`);
    return;
  }

  console.log(`[${messageId}] Fetching...`);
  const emailData = await getMessage(auth, messageId);
  console.log(`[${messageId}] Subject: "${emailData.subject}" | From: ${emailData.from}`);

  // Screenshot
  const screenshotPath = path.join(config.screenshot_dir, `${messageId}.png`);
  try {
    await renderEmailToScreenshot(emailData.html || null, screenshotPath, browser);
    console.log(`[${messageId}] Screenshot saved`);
  } catch (err) {
    console.warn(`[${messageId}] Screenshot failed: ${err.message}`);
  }

  const analysis = await analyzeEmail(config.anthropic_api_key, config.model, emailData, screenshotPath);
  let totalInputTokens = analysis._input_tokens || 0;
  let totalOutputTokens = analysis._output_tokens || 0;
  console.log(`[${messageId}] Category: ${analysis.category} | Event key: ${analysis.event_key}`);

  const handler = CATEGORY_HANDLERS[analysis.category];
  let result = {};
  if (handler) {
    result = await handler({ db, config, messageId, emailData, analysis, screenshotPath });
  } else {
    console.warn(`[${messageId}] Unexpected category ${analysis.category}, no handler — discarding`);
  }

  if (result.tokens) {
    totalInputTokens += result.tokens.input;
    totalOutputTokens += result.tokens.output;
  }

  // Hard Discord failure on a postable email: leave it unread and unstored so
  // the next poll reprocesses it rather than silently dropping the release.
  if (result.postHardFailed) {
    console.warn(`[${messageId}] Discord post failed after retries — leaving unread for retry on next poll`);
    return;
  }

  const finalAnalysis = result.analysis || analysis;
  const discordPosted = !!result.discordPosted;
  const discordMessageId = result.discordMessageId || null;

  // Mark as read in Gmail
  try {
    await markAsRead(auth, messageId);
  } catch (err) {
    console.warn(`[${messageId}] Failed to mark as read: ${err.message}`);
  }

  // Store in DB
  insertEmail(db, {
    id: messageId,
    received_at: emailData.date,
    from_addr: emailData.from,
    subject: emailData.subject,
    category: finalAnalysis.category,
    event_key: finalAnalysis.event_key || null,
    summary: finalAnalysis.summary,
    structured_fields: JSON.stringify({
      product_name: finalAnalysis.product_name,
      release_date: finalAnalysis.release_date,
      price: finalAnalysis.price,
      region_availability: finalAnalysis.region_availability,
      lottery_deadline: finalAnalysis.lottery_deadline,
    }),
    desirability_score: finalAnalysis.desirability_score,
    screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : null,
    discord_posted: discordPosted ? 1 : 0,
    discord_message_id: discordMessageId,
    llm_response: JSON.stringify(finalAnalysis),
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
  });

  console.log(`[${messageId}] Done (category=${finalAnalysis.category}, posted=${discordPosted})`);
}

async function poll(auth) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (today !== lastDailyDate) {
    lastDailyDate = today;
    await runDailyMaintenance();
  }

  console.log(`[${new Date().toISOString()}] Polling for new emails...`);
  try {
    const ids = await fetchUnreadIds(auth);
    console.log(`Found ${ids.length} unread message(s)`);
    if (ids.length === 0) return;

    const browser = await launchBrowser();
    try {
      for (const id of ids) {
        try {
          await processEmail(auth, id, browser);
        } catch (err) {
          console.error(`Error processing message ${id}:`, err.message);
        }
      }
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error('Poll error:', err.message);
    await postAlert(config.discord_alerts_webhook_url, `Poll error: ${err.message}`).catch(() => {});
  }
}

async function run() {
  console.log('Email monitor starting...');
  const auth = await authenticate(config.gmail_credentials_path, config.gmail_token_path);
  const emailAddress = await getEmailAddress(auth);
  console.log(`Monitoring inbox: ${emailAddress}`);

  const intervalMs = config.poll_interval_minutes * 60 * 1000;
  console.log(`Polling every ${config.poll_interval_minutes} minutes`);

  // Initial poll immediately on startup
  await poll(auth);

  setInterval(() => poll(auth), intervalMs);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
