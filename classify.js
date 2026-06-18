'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const SYSTEM_PROMPT = `You are an expert analyst for a bourbon and American whiskey enthusiast. You monitor emails from distilleries, non-distiller producers (NDPs), distributors, and retailers.

Your job is to classify each email into one of these categories:
1 - Advertisement for existing, already-released products (promotional emails, "buy now", general brand awareness, existing product spotlights). These are common and NOT worth alerting.
2 - Announcement of something NEW: new product releases coming in the future, upcoming events, lottery signups opening, allocations being announced, new expressions being revealed. These ARE worth alerting, but we track them to avoid duplicate alerts.
3 - Immediate product release or availability: "Available NOW", same-day or next-day releases, products hitting shelves today. These are the most time-sensitive and always worth alerting.
4 - Retailer sale or temporary discount on existing products (e.g. "20% off Blanton's this weekend"). Worth alerting but less urgent than category 3.
5 - Action required from the recipient: confirm your subscription, verify your email address, complete your registration, etc. These need a human to click something.
6 - Does not fit any of the above: partnership announcements, industry news, non-bourbon newsletters, ambiguous or unusual emails that don't clearly belong elsewhere. Flagged for human triage.

Key insight: bourbon and whiskey images are crucial — product names, release dates, and limited availability info are often in the images rather than the text. Analyze both.

When a previous_post_details object is provided, it means this event has already been announced and a Discord alert was sent. Carefully determine whether the new email adds MATERIAL NEW INFORMATION (new dates, prices, lottery deadlines, retail locations, specific availability windows, or significant clarifications) vs just re-announcing the same facts. If it adds material new info, set is_meaningful_update to true and describe what's new in update_summary.

For event_key: create a normalized, canonical identifier for the event/product — lowercase, specific, year-inclusive where relevant. Examples:
- "buffalo trace antique collection 2026 lottery"
- "weller full proof 2026 release"
- "pappy van winkle 2026 allocation announcement"
- "kentucky owl rye batch 4 release"

Return null for event_key on category 1 emails.`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'integer', description: '1=existing ad, 2=new announcement, 3=immediate release, 4=retailer sale, 5=action required (confirm subscription, verify email, etc.), 6=does not fit any category (human triage needed)' },
    reasoning: { type: 'string', description: 'One sentence explaining the classification' },
    event_key: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Normalized canonical event name for dedup; null for category 1' },
    summary: { type: 'string', description: '2-3 sentence human-readable summary of what this email is about' },
    product_name: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Specific product or product line name' },
    release_date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Release, event, or availability date if mentioned' },
    price: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Price or MSRP if mentioned' },
    region_availability: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Where available (nationwide, specific states, lottery, etc.)' },
    lottery_deadline: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Lottery entry deadline if applicable' },
    desirability_score: { type: 'integer', description: '1=low interest to 5=extremely rare and exciting (BTAC/Pappy level)' },
    discord_title: { type: 'string', description: 'Short compelling title for the Discord alert with appropriate emoji. Be specific and exciting.' },
    is_meaningful_update: { type: 'boolean', description: 'True if this email has new info worth alerting. Always true for category 3. For cat 2/4 with previous_post_details, only true if material new information is present.' },
    update_summary: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'If is_meaningful_update and previous_post_details exist, what specifically is new vs before' }
  },
  required: ['category', 'reasoning', 'event_key', 'summary', 'product_name', 'release_date', 'price', 'region_availability', 'lottery_deadline', 'desirability_score', 'discord_title', 'is_meaningful_update', 'update_summary'],
  additionalProperties: false
};

async function analyzeEmail(apiKey, model, emailData, screenshotPath, previousEventDetails = null) {
  const client = new Anthropic({ apiKey });

  const userTextParts = [
    `From: ${emailData.from}`,
    `Subject: ${emailData.subject}`,
    `Date: ${emailData.date}`,
    '',
    '--- EMAIL TEXT CONTENT ---',
    emailData.text || '(no plain text body)',
  ];

  if (previousEventDetails) {
    userTextParts.push('');
    userTextParts.push('--- PREVIOUS ALERT ALREADY SENT FOR THIS EVENT ---');
    userTextParts.push(JSON.stringify(previousEventDetails, null, 2));
    userTextParts.push('--- END PREVIOUS ALERT ---');
    userTextParts.push('Assess whether this new email adds material new information vs what was already posted.');
  }

  const content = [
    { type: 'text', text: userTextParts.join('\n') },
  ];

  // Add screenshot
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    const screenshotB64 = fs.readFileSync(screenshotPath).toString('base64');
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenshotB64 },
    });
  }

  // Add any standalone attachment images (not inline — those are already in the screenshot)
  for (const img of (emailData.attachmentImages || [])) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data },
    });
  }

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: ANALYSIS_SCHEMA,
      },
    },
  });

  const rawText = response.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(rawText);
}

module.exports = { analyzeEmail };
