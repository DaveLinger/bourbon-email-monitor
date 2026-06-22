'use strict';
const fs = require('fs');

const STAR_RATINGS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function offsetToAbbrev(sign, hours, month) {
  const dst = month >= 3 && month <= 11;
  const offset = sign === '-' ? -hours : hours;
  const map = dst
    ? { '-4': 'EDT', '-5': 'CDT', '-6': 'MDT', '-7': 'PDT' }
    : { '-5': 'EST', '-6': 'CST', '-7': 'MST', '-8': 'PST' };
  return map[String(offset)] || `UTC${sign}${hours}`;
}

function formatDate(dateStr) {
  if (!dateStr) return dateStr;
  const dtMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}:\d{2}|Z)?/);
  if (dtMatch) {
    const [, year, month, day, hour, min, tz] = dtMatch;
    const [y, mo, d, h, mi] = [year, month, day, hour, min].map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const fmt12 = h % 12 || 12;
    const m = String(mi).padStart(2, '0');
    let tzLabel = '';
    if (tz === 'Z') {
      tzLabel = ' UTC';
    } else if (tz) {
      const offMatch = tz.match(/([+-])(\d{2}):\d{2}/);
      if (offMatch) tzLabel = ` ${offsetToAbbrev(offMatch[1], parseInt(offMatch[2]), mo)}`;
    }
    return `${MONTHS[mo - 1]} ${d}, ${y} at ${fmt12}:${m} ${ampm}${tzLabel}`;
  }
  const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, year, month, day] = dateMatch.map(Number);
    return `${MONTHS[month - 1]} ${day}, ${year}`;
  }
  return dateStr;
}

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelayMs * attempt;
      console.warn(`Discord post attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

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
  if (analysis.release_date)      bullets.push(`• **Date:** ${formatDate(analysis.release_date)}`);
  if (analysis.price)             bullets.push(`• **Price:** ${analysis.price}`);
  if (analysis.lottery_deadline)  bullets.push(`• **Lottery deadline:** ${analysis.lottery_deadline}`);
  if (analysis.region_availability) bullets.push(`• **Availability:** ${analysis.region_availability}`);
  if (analysis.action_url)        bullets.push(`• **Link:** ${analysis.action_url}`);

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
  const pingEveryone = !!analysis.is_wild_turkey_allocated_imminent && !analysis.is_regional;
  const payload = {
    content,
    ...(pingEveryone ? { allowed_mentions: { parse: ['everyone'] } } : {}),
  };

  return withRetry(async () => {
    let response;
    if (hasScreenshot) {
      const screenshotBuffer = fs.readFileSync(screenshotPath);
      const formData = new FormData();
      formData.append('payload_json', JSON.stringify(payload));
      formData.append('files[0]', new Blob([screenshotBuffer], { type: 'image/png' }), 'screenshot.png');
      response = await fetch(`${webhookUrl}?wait=true`, { method: 'POST', body: formData });
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
  });
}

async function postAlert(webhookUrl, message) {
  return withRetry(async () => {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `⚠️ **email-monitor:** ${message}` }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord alert failed (${response.status}): ${body}`);
    }
  }).catch(err => console.error(`Failed to post alert to Discord: ${err.message}`));
}

const CAT_LABELS = { 1: 'ad', 2: 'announcement', 3: 'release', 4: 'sale', 5: 'action', 6: 'triage' };

async function postHeartbeat(webhookUrl, stats, config) {
  const { today, month, categories } = stats;
  const inRate = config.llm_input_cost_per_million / 1_000_000;
  const outRate = config.llm_output_cost_per_million / 1_000_000;
  const todayCost = (today.input_tokens * inRate + today.output_tokens * outRate).toFixed(4);
  const monthCost = (month.input_tokens * inRate + month.output_tokens * outRate).toFixed(2);

  const catStr = categories.length
    ? categories.map(c => `${c.cnt}×${CAT_LABELS[c.category] || c.category}`).join(', ')
    : 'none';

  const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  const lines = [
    `✅ **email-monitor** alive — ${(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })()}`,
    ``,
    `📧 **Yesterday:** ${today.emails} processed (${catStr}) · ${today.posted} posted to Discord`,
    `🤖 **LLM yesterday:** ~$${todayCost} (${fmt(today.input_tokens)} in / ${fmt(today.output_tokens)} out tokens)`,
    `💰 **LLM this month:** ~$${monthCost} (${fmt(month.input_tokens)} in / ${fmt(month.output_tokens)} out tokens)`,
  ];

  return withRetry(async () => {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Heartbeat post failed (${response.status}): ${body}`);
    }
  });
}

module.exports = { postToDiscord, postAlert, postHeartbeat };
