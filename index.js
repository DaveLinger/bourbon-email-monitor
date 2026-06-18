'use strict';
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./config');
const { getDb, isProcessed, insertEmail, getKnownEvent, upsertKnownEvent } = require('./db');
const { authenticate, getEmailAddress, fetchUnreadIds, getMessage, markAsRead } = require('./gmail');
const { renderEmailToScreenshot } = require('./screenshot');
const { analyzeEmail } = require('./classify');
const { postToDiscord, postAlert } = require('./notify');

const config = loadConfig();
const db = getDb(config.db_path);
fs.mkdirSync(config.screenshot_dir, { recursive: true });

async function processEmail(auth, messageId) {
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
    await renderEmailToScreenshot(emailData.html || null, screenshotPath);
    console.log(`[${messageId}] Screenshot saved`);
  } catch (err) {
    console.warn(`[${messageId}] Screenshot failed: ${err.message}`);
  }

  // Check if we've seen this event before (for smart dedup context)
  // We won't know the event_key until after classification, so we classify first,
  // then re-classify with context if needed.
  let analysis = await analyzeEmail(
    config.anthropic_api_key,
    config.model,
    emailData,
    screenshotPath
  );

  console.log(`[${messageId}] Category: ${analysis.category} | Event key: ${analysis.event_key}`);

  let discordPosted = false;
  let discordMessageId = null;
  let isUpdate = false;

  if (analysis.category === 1) {
    // Discard — just log it
    console.log(`[${messageId}] Category 1 (ad), discarding`);
  } else if (analysis.category === 5) {
    // Action required — ping the alerts channel
    console.log(`[${messageId}] Category 5 (action required), posting to alerts`);
    await postAlert(
      config.discord_alerts_webhook_url,
      `📬 **Action required:** ${emailData.subject}\nFrom: ${emailData.from}`
    ).catch(err => console.error(`[${messageId}] Alert post failed: ${err.message}`));
  } else if (analysis.category === 6) {
    // Uncategorized — post screenshot to alerts for human triage
    console.log(`[${messageId}] Category 6 (uncategorized), posting to alerts for triage`);
    try {
      const triageAnalysis = { ...analysis, discord_title: `⚠️ Triage needed: ${analysis.discord_title}` };
      await postToDiscord(config.discord_alerts_webhook_url, emailData, triageAnalysis, screenshotPath, false);
      discordPosted = true;
    } catch (err) {
      console.error(`[${messageId}] Triage alert post failed: ${err.message}`);
    }
  } else if (analysis.category === 3) {
    // Immediate release — always post, no dedup
    console.log(`[${messageId}] Category 3 (immediate release), posting to Discord`);
    try {
      discordMessageId = await postToDiscord(config.discord_releases_webhook_url, emailData, analysis, screenshotPath, false);
      discordPosted = true;
      console.log(`[${messageId}] Posted to Discord (message ${discordMessageId})`);
      if (analysis.event_key) {
        upsertKnownEvent(db, analysis.event_key, messageId, discordMessageId, analysis);
      }
    } catch (err) {
      console.error(`[${messageId}] Discord post failed: ${err.message}`);
      await postAlert(config.discord_alerts_webhook_url, `Failed to post release alert for "${emailData.subject}": ${err.message}`);
    }
  } else if (analysis.category === 2 || analysis.category === 4) {
    const knownEvent = analysis.event_key ? getKnownEvent(db, analysis.event_key, config.dedup_window_days) : null;

    if (!knownEvent) {
      // New event — post it
      console.log(`[${messageId}] New event, posting to Discord`);
      try {
        discordMessageId = await postToDiscord(config.discord_releases_webhook_url, emailData, analysis, screenshotPath, false);
        discordPosted = true;
        console.log(`[${messageId}] Posted to Discord (message ${discordMessageId})`);
        if (analysis.event_key) {
          upsertKnownEvent(db, analysis.event_key, messageId, discordMessageId, analysis);
        }
      } catch (err) {
        console.error(`[${messageId}] Discord post failed: ${err.message}`);
        await postAlert(config.discord_alerts_webhook_url, `Failed to post announcement for "${emailData.subject}": ${err.message}`);
      }
    } else {
      // Known event — re-classify with previous details to check for meaningful update
      console.log(`[${messageId}] Known event, checking for meaningful update...`);
      const previousDetails = knownEvent.posted_details ? JSON.parse(knownEvent.posted_details) : null;

      const updateAnalysis = await analyzeEmail(
        config.anthropic_api_key,
        config.model,
        emailData,
        screenshotPath,
        previousDetails
      );

      if (updateAnalysis.is_meaningful_update) {
        isUpdate = true;
        analysis = updateAnalysis;
        console.log(`[${messageId}] Meaningful update found: ${updateAnalysis.update_summary}`);
        try {
          discordMessageId = await postToDiscord(config.discord_releases_webhook_url, emailData, analysis, screenshotPath, true);
          discordPosted = true;
          console.log(`[${messageId}] Update posted to Discord (message ${discordMessageId})`);
          upsertKnownEvent(db, analysis.event_key, messageId, discordMessageId, analysis);
        } catch (err) {
          console.error(`[${messageId}] Discord post failed: ${err.message}`);
          await postAlert(config.discord_alerts_webhook_url, `Failed to post update alert for "${emailData.subject}": ${err.message}`);
        }
      } else {
        console.log(`[${messageId}] Duplicate with no new info, skipping Discord`);
      }
    }
  }

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
    category: analysis.category,
    event_key: analysis.event_key || null,
    summary: analysis.summary,
    structured_fields: JSON.stringify({
      product_name: analysis.product_name,
      release_date: analysis.release_date,
      price: analysis.price,
      region_availability: analysis.region_availability,
      lottery_deadline: analysis.lottery_deadline,
    }),
    desirability_score: analysis.desirability_score,
    screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : null,
    discord_posted: discordPosted ? 1 : 0,
    discord_message_id: discordMessageId,
    llm_response: JSON.stringify(analysis),
  });

  console.log(`[${messageId}] Done (category=${analysis.category}, posted=${discordPosted})`);
}

async function poll(auth) {
  console.log(`[${new Date().toISOString()}] Polling for new emails...`);
  try {
    const ids = await fetchUnreadIds(auth);
    console.log(`Found ${ids.length} unread message(s)`);
    for (const id of ids) {
      try {
        await processEmail(auth, id);
      } catch (err) {
        console.error(`Error processing message ${id}:`, err.message);
        // Continue to next email even if one fails
      }
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
