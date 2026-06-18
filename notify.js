'use strict';
const fs = require('fs');

const STAR_RATINGS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

function buildMessageText(emailData, analysis, isUpdate) {
  const titlePrefix = isUpdate ? '📢 **UPDATE:** ' : '';
  const lines = [];

  if (analysis.is_wild_turkey_allocated_imminent) {
    lines.push('@everyone');
  }

  lines.push(`${titlePrefix}**${analysis.discord_title}**`);

  if (isUpdate && analysis.update_summary) {
    lines.push('');
    lines.push(`**What's new:** ${analysis.update_summary}`);
  }

  lines.push('');
  lines.push(analysis.summary);

  const bullets = [];
  if (analysis.product_name)      bullets.push(`• **Product:** ${analysis.product_name}`);
  if (analysis.release_date)      bullets.push(`• **Date:** ${analysis.release_date}`);
  if (analysis.price)             bullets.push(`• **Price:** ${analysis.price}`);
  if (analysis.lottery_deadline)  bullets.push(`• **Lottery deadline:** ${analysis.lottery_deadline}`);
  if (analysis.region_availability) bullets.push(`• **Availability:** ${analysis.region_availability}`);

  if (bullets.length > 0) {
    lines.push('');
    lines.push(...bullets);
  }

  lines.push('');
  lines.push(`-# From: ${emailData.from}`);

  return lines.join('\n');
}

async function postToDiscord(webhookUrl, emailData, analysis, screenshotPath, isUpdate = false) {
  const content = buildMessageText(emailData, analysis, isUpdate);
  const hasScreenshot = screenshotPath && fs.existsSync(screenshotPath);
  const pingEveryone = !!analysis.is_wild_turkey_allocated_imminent;
  const payload = {
    content,
    ...(pingEveryone ? { allowed_mentions: { parse: ['everyone'] } } : {}),
  };

  let response;
  if (hasScreenshot) {
    const screenshotBuffer = fs.readFileSync(screenshotPath);
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify(payload));
    formData.append('files[0]', new Blob([screenshotBuffer], { type: 'image/png' }), 'screenshot.png');
    response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      body: formData,
    });
  } else {
    response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.id || null;
}

async function postAlert(webhookUrl, message) {
  const response = await fetch(`${webhookUrl}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `⚠️ **email-monitor:** ${message}` }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(`Failed to post alert to Discord (${response.status}): ${body}`);
  }
}

module.exports = { postToDiscord, postAlert };
