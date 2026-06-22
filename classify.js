'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const PING_ROSTER = require('./roster');

// Render roster.js into a readable prompt block. The LLM matches each email
// against this list to decide the is_ping_worthy_imminent flag.
function renderPingRoster(roster) {
  const lines = [];
  for (const [brand, policy] of Object.entries(roster)) {
    if (!policy.ping) {
      lines.push(`- ${brand}: never ping.`);
      continue;
    }
    let line = `- ${brand}: PING for rare/allocated releases.`;
    if (policy.triggers && policy.triggers.length) line += ` Examples that SHOULD ping: ${policy.triggers.join(', ')}.`;
    if (policy.excludes && policy.excludes.length) line += ` Do NOT ping for: ${policy.excludes.join(', ')}.`;
    lines.push(line);
  }
  return lines.join('\n');
}

function extractLinks(html) {
  if (!html) return [];
  const links = [];
  const hrefRe = /<a\s[^>]*href=["']([^"'#][^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = hrefRe.exec(html)) !== null) {
    const url = match[1].trim();
    const text = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!url.startsWith('mailto:') && !url.startsWith('javascript:') && url.length > 5) {
      links.push({ url, text: text.slice(0, 120) });
    }
  }
  const seen = new Set();
  return links.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  }).slice(0, 60);
}

const SYSTEM_PROMPT = `You are an expert analyst for a bourbon and American whiskey enthusiast. You monitor emails from distilleries, non-distiller producers (NDPs), distributors, and retailers.

@EVERYONE PING ROSTER (for is_ping_worthy_imminent): only flag an IMMEDIATE (category 3, available right now) release of a rare/allocated product from a brand marked PING below.
${renderPingRoster(PING_ROSTER)}
For a PING brand, if the specific bottle is not named in either list, use judgment: flag it only if it is clearly a rare, allocated, or limited release — not a standard-lineup bottle. For any brand NOT listed above, do not flag.

Your job is to classify each email into one of these categories:
1 - Advertisement for existing, already-released products (promotional emails, "buy now", general brand awareness, existing product spotlights). These are common and NOT worth alerting.
2 - Announcement of something NEW: new product releases coming in the future, upcoming events, lottery signups opening, allocations being announced, new expressions being revealed. These ARE worth alerting, but we track them to avoid duplicate alerts.
3 - Immediate product release or availability: "Available NOW", same-day or next-day releases, products available to order now or within 24 hours. These are the most time-sensitive and always worth alerting.
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

Return null for event_key on category 1 emails.

For action_url: if the email contains a specific call-to-action link the reader should click (purchase link, lottery entry, release access link, subscription confirmation), extract that URL. Exclude unsubscribe links, social media profile links, and generic footer/navigation links. Null for category 1 and when no specific action link exists.`;

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
    desirability_score: { type: 'integer', description: 'How much a serious bourbon collector should care. Scarcity and exclusivity of ACCESS matter most — a statewide public release is not exclusive even if it is state-only. 1=no real interest (generic ads, standard lineup products, multi-category retailer blowout sales); 2=mildly interesting (store picks or private barrel selections of mid-tier products, limited but widely obtainable releases, statewide public drops like OHLQ or FWGS exclusive barrels — these go to everyone in the state and are not truly scarce); 3=worth knowing about (single barrel picks with genuinely limited/private purchase access links, hard-to-find regionals not broadly distributed, sought-after but not trophy releases); 4=high interest — major annual allocated releases that collectors actively hunt: Russell\'s Reserve 13yr Barrel Proof, Eagle Rare 12, Old Forester Birthday Bourbon, Old Forester President\'s Choice, Elijah Craig 21; 5=trophy tier that collectors will drop everything for: BTAC (Buffalo Trace Antique Collection: George T. Stagg, William Larue Weller, Thomas H. Handy, Sazerac 18, Eagle Rare 17), Pappy Van Winkle, Russell\'s Reserve 15yr, Austin Nichols Archive (Gold Foil), Jack Daniel\'s 14yr, Heaven Hill 22yr. When in doubt between tiers, the deciding factor is: would a serious collector set an alarm for this?' },
    discord_title: { type: 'string', description: 'Short compelling title for the Discord alert with appropriate emoji. Be specific and exciting.' },
    is_meaningful_update: { type: 'boolean', description: 'True if this email has new info worth alerting. Always true for category 3. For cat 2/4 with previous_post_details, only true if material new information is present.' },
    update_summary: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'If is_meaningful_update and previous_post_details exist, what specifically is new vs before' },
    is_regional: { type: 'boolean', description: 'true ONLY if the release, event, or sale is EXCLUSIVELY regional or local with NO national availability component — requires physical presence OR is only available in specific states via state-controlled distribution (e.g. OHLQ, FWGS, PLCB) with no online/ship-to-home option. If a release has BOTH a local event AND nationwide online ordering, it is false. Examples: OHLQ barrel pick (Ohio only, no online order) → true; Buffalo Trace local tasting event where the product is also available to order online nationally → false; Buffalo Trace local tasting event for a product with no other purchase path → true; Pappy online ship-to-home → false; BTAC nationwide lottery → false.' },
    is_ping_worthy_imminent: { type: 'boolean', description: 'true ONLY if: (1) category is 3 (an immediate, available-right-now release), AND (2) the product is from a brand marked PING in the @everyone ping roster in the system prompt, AND (3) the specific bottle is a rare/allocated release per that roster — a named trigger example, or (if unnamed) clearly a rare/allocated/limited expression rather than a standard-lineup or excluded bottle. false for standard products, brands not marked PING, and non-category-3 emails.' },
    action_url: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Primary call-to-action URL the reader should click (purchase link, lottery entry, release access, subscription confirmation). Exclude unsubscribe, social media, and footer links. Null for cat 1 and when no specific action link exists.' }
  },
  required: ['category', 'reasoning', 'event_key', 'summary', 'product_name', 'release_date', 'price', 'region_availability', 'lottery_deadline', 'desirability_score', 'discord_title', 'is_meaningful_update', 'update_summary', 'is_regional', 'is_ping_worthy_imminent', 'action_url'],
  additionalProperties: false
};

async function analyzeEmail(apiKey, model, emailData, screenshotPath, previousEventDetails = null) {
  const client = new Anthropic({ apiKey });

  const links = extractLinks(emailData.html);

  const userTextParts = [
    `From: ${emailData.from}`,
    `Subject: ${emailData.subject}`,
    `Date: ${emailData.date}`,
    '',
    '--- EMAIL TEXT CONTENT ---',
    emailData.text || '(no plain text body)',
  ];

  if (links.length > 0) {
    userTextParts.push('');
    userTextParts.push('--- EMAIL LINKS (url | anchor text) ---');
    for (const l of links) {
      userTextParts.push(`${l.url} | ${l.text}`);
    }
    userTextParts.push('--- END LINKS ---');
  }

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
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content }],
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: ANALYSIS_SCHEMA,
      },
    },
  });

  const rawText = response.content.find(b => b.type === 'text')?.text || '{}';
  const parsed = JSON.parse(rawText);
  parsed._input_tokens = response.usage?.input_tokens || 0;
  parsed._output_tokens = response.usage?.output_tokens || 0;
  return parsed;
}

module.exports = { analyzeEmail };
