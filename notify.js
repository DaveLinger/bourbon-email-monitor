'use strict';
const fs = require('fs');

const CATEGORY_COLORS = {
  2: 0x3498db, // blue — announcement
  3: 0xe74c3c, // red — immediate release
  4: 0x2ecc71, // green — sale
};

const STAR_RATINGS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

function buildEmbedFields(analysis) {
  const fields = [];
  if (analysis.product_name) {
    fields.push({ name: 'Product', value: analysis.product_name, inline: true });
  }
  if (analysis.release_date) {
    fields.push({ name: 'Date', value: analysis.release_date, inline: true });
  }
  if (analysis.price) {
    fields.push({ name: 'Price', value: analysis.price, inline: true });
  }
  if (analysis.lottery_deadline) {
    fields.push({ name: 'Lottery Deadline', value: analysis.lottery_deadline, inline: true });
  }
  if (analysis.region_availability) {
    fields.push({ name: 'Availability', value: analysis.region_availability, inline: true });
  }
  if (analysis.desirability_score) {
    fields.push({ name: 'Desirability', value: STAR_RATINGS[analysis.desirability_score] || String(analysis.desirability_score), inline: true });
  }
  return fields;
}

async function postToDiscord(webhookUrl, emailData, analysis, screenshotPath, isUpdate = false) {
  const titlePrefix = isUpdate ? '📢 UPDATE: ' : '';
  const title = titlePrefix + analysis.discord_title;

  let description = analysis.summary;
  if (isUpdate && analysis.update_summary) {
    description = `**What's new:** ${analysis.update_summary}\n\n${analysis.summary}`;
  }

  const embed = {
    title,
    description,
    color: CATEGORY_COLORS[analysis.category] || 0x95a5a6,
    fields: buildEmbedFields(analysis),
    footer: { text: `From: ${emailData.from}` },
    timestamp: new Date().toISOString(),
  };

  const hasScreenshot = screenshotPath && fs.existsSync(screenshotPath);
  if (hasScreenshot) {
    embed.image = { url: 'attachment://screenshot.png' };
  }

  const payload = { embeds: [embed] };

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

module.exports = { postToDiscord };
