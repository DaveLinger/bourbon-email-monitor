'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
// Hot-reload roster.js on each analysis so edits take effect without a restart.
// Falls back to the last good copy if the file is mid-edit / syntactically broken.
let lastGoodRoster = null;
function loadRoster() {
  try {
    delete require.cache[require.resolve('./roster')];
    lastGoodRoster = require('./roster');
  } catch (err) {
    if (!lastGoodRoster) throw err;
    console.warn(`roster.js reload failed (${err.message}); using last good copy`);
  }
  return lastGoodRoster;
}
loadRoster(); // validate at boot and seed the fallback copy

// Render the roster into a readable prompt block. The LLM matches each email
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

function buildSystemPrompt() {
  return `You are an expert analyst for a bourbon and American whiskey enthusiast. You monitor emails from distilleries, non-distiller producers (NDPs), distributors, and retailers.

@EVERYONE PING ROSTER (for is_ping_worthy_imminent): only flag an IMMEDIATE (category 3, available right now) release of a rare/allocated product from a brand marked PING below.
${renderPingRoster(loadRoster())}
For a PING brand, if the specific bottle is not named in either list, use judgment: flag it only if it is clearly a rare, allocated, or limited release — not a standard-lineup bottle. For any brand NOT listed above, do not flag.

Your job is to classify each email into one of these categories:
1 - Advertisement for existing, already-released products (promotional emails, "buy now", general brand awareness, existing product spotlights), OR anything else not worth alerting — see DISCARD PATTERNS below. Category 1 is the general discard bucket, not only product ads. These are common and NOT worth alerting.
2 - Announcement of something NEW: new product releases coming in the future, upcoming events, lottery signups opening, allocations being announced, new expressions being revealed. These ARE worth alerting, but we track them to avoid duplicate alerts.
3 - Immediate product release or availability: "Available NOW", same-day or next-day releases, products available to order now or within 24 hours. These are the most time-sensitive and always worth alerting.
4 - Retailer sale or temporary discount on existing products (e.g. "20% off Blanton's this weekend"). Worth alerting but less urgent than category 3.
5 - Action required from the recipient: confirm your subscription, verify your email address, complete your registration, etc. These need a human to click something.
6 - Genuinely ambiguous or unusual: you cannot tell what the email is or whether it matters. Flagged for a human, who can promote it to a release channel with one click. Do NOT use category 6 for anything matching a DISCARD PATTERN below — that is category 1.

DISCARD PATTERNS (category 1). These recur constantly and are never worth a Discord post:
- Podcasts, live recordings, interviews, video/streaming content, webinars, or media appearances.
- Auctions of any kind — spirits auctions, charity auctions, auction-house catalogs, "bidding closes Friday".
- Raffles, giveaways, and sweepstakes run by a RETAILER, third party, charity, or media outlet (see the exception below).
- Emails PRIMARILY about wine, beer, gin, vodka, tequila/agave, rum, cognac, or liqueurs. Judge by what the email is mostly about: a bourbon release that mentions a gin in passing is still a bourbon release, while a retailer newsletter whose bourbon content is incidental is a discard.
- Industry-wide "news roundup" / digest emails spanning many brands (e.g. "Bourbon and Distillery News for July 25"). These aggregate already-published news rather than announcing anything.
- Recurring weekly/monthly newsletters containing no specific product release and no specific dated event: brand news, staff hires, visitor-center or tasting-room updates, cocktail recipes, travel and tourism content, sustainability or partnership stories, brand-history features.

EXCEPTIONS — these ARE worth alerting despite resembling the patterns above:
- A raffle, lottery, or giveaway run DIRECTLY by the distillery or brand for its own bottle is a real allocation path → category 2.
- A single-distillery newsletter or "news" email is judged on its CONTENTS, not its format. If it announces a specific release, drop, lottery, or dated event, classify it 2/3/4 on that basis. If it carries only general brand news, it is category 1.
  A dated event only counts when it is a chance to GET whiskey — a release, drop, lottery window, allocation, or a ticketed event where bottles are sold or poured. A dated announcement that is purely hospitality or facilities news (a new tasting room, visitor center, distillery, bar, or restaurant opening; a renovation; a trail designation) stays category 1 even though it has a date attached.

Key insight: bourbon and whiskey images are crucial — product names, release dates, and limited availability info are often in the images rather than the text. Analyze both.

When a previous_post_details object is provided, it means this event has already been announced and a Discord alert was sent. Carefully determine whether the new email adds MATERIAL NEW INFORMATION (new dates, prices, lottery deadlines, retail locations, specific availability windows, or significant clarifications) vs just re-announcing the same facts. If it adds material new info, set is_meaningful_update to true and describe what's new in update_summary.

For event_key: create a normalized, canonical identifier for the event/product — lowercase, specific, year-inclusive where relevant. Examples:
- "buffalo trace antique collection 2026 lottery"
- "weller full proof 2026 release"
- "pappy van winkle 2026 allocation announcement"
- "kentucky owl rye batch 4 release"

REUSING EVENT KEYS: if a "KNOWN RECENT EVENTS" list is provided in the user message and this email is about the SAME real-world event/release/lottery/sale as one of them, set event_key to that EXACT existing key, copied character-for-character. Match on the underlying event, NOT the wording — different emails about the same drop are often phrased very differently (different sender, subject, word order, extra words). A launch announcement, a "last call" reminder, and a release-day email for one product are all the SAME event. Only mint a new event_key when the email is genuinely about a different event.

Return null for event_key on category 1 emails.

CALENDAR EXTRACTION (for the server's events calendar):
A calendar event is created ONLY for a release, drop, lottery window, or event that has a SPECIFIC upcoming date (today or later). Two kinds of items are deliberately NOT calendared: (a) products that are "available now" / live right now, and (b) anything with only a vague or ambiguous timeframe ("next week", "next month", "late June", "this fall", "coming soon"). They are too imprecise to pin to a day. If a later email about the same event provides a specific date, it will be calendared then.
Set calendar_eligible to true ONLY when the email gives a SPECIFIC upcoming date (today or later) for the release/drop/lottery/event. Set it false for: available-now/live drops, vague or open-ended timeframes with no exact date, already-released products being re-advertised, ads (cat 1), action-required (cat 5), and triage (cat 6).
- event_starts_now: true if the product/sale is available or happening IMMEDIATELY right now (a live drop, "available now", "on shelves today", a sale active now). These are NOT placed on the calendar (no specific future date). false if it has a future date or no date at all.
- event_start_date: the date the event/drop/lottery happens or opens, as YYYY-MM-DD — ONLY when an exact date is explicitly stated or unambiguously inferable. Null for vague windows ("next week", "next month", "late June", "early fall"), for available-now drops, and whenever no exact date can be inferred. Do NOT guess or approximate a date for a vague window — leave it null.
- event_start_time: a specific local clock time as 24-hour HH:MM if one is given (e.g. "drops at 10am" -> "10:00"). Null if only a date is known — the calendar will use a noon placeholder.
- event_title: a short, specific calendar title (<= 60 chars), e.g. "Weller Full Proof 2026 Release" or "BTAC 2026 Lottery Opens".
- event_location: where it happens — retailer/store name, city/state, "Online", or the distribution channel. Null if unknown.

For action_url: if the email contains a specific call-to-action link the reader should click (purchase link, lottery entry, release access link, subscription confirmation), extract that URL. Exclude unsubscribe links, social media profile links, and generic footer/navigation links. Null for category 1 and when no specific action link exists.

For action_link_text: the visible anchor/button text of that action link, copied from the "EMAIL LINKS (url | anchor text)" list for the URL you chose as action_url (e.g. "Buy Now", "Buy Tickets Here", "Enter the Lottery", "Shop the Release"). This becomes the clickable label in Discord instead of the raw URL. Null when action_url is null, or when the link had no meaningful text (e.g. an image-only button with empty anchor text).`;
}

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
    action_url: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Primary call-to-action URL the reader should click (purchase link, lottery entry, release access, subscription confirmation). Exclude unsubscribe, social media, and footer links. Null for cat 1 and when no specific action link exists.' },
    action_link_text: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Visible anchor/button text of the action_url link, copied from the email LINKS list (e.g. "Buy Now", "Buy Tickets Here"). Becomes the clickable Discord label. Null when action_url is null or the link had no meaningful text.' },
    calendar_eligible: { type: 'boolean', description: 'true ONLY if this release/drop/lottery/event has a SPECIFIC upcoming date (today or later). false for available-now/live drops, vague or open-ended timeframes with no exact date, re-advertised already-released products, ads, action-required, and triage.' },
    event_starts_now: { type: 'boolean', description: 'true if available/happening RIGHT NOW (live drop, "available now", "on shelves today", sale active now). NOT placed on the calendar (no specific future date). false if it has a future date or no date.' },
    event_start_date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Calendar start date as YYYY-MM-DD, ONLY when an exact date is stated or unambiguously inferable. Null for vague windows ("next month", "this fall"), available-now drops, and anything with no exact date. Do not guess a date for a vague window.' },
    event_start_time: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Specific local start time as 24h HH:MM if given; null if only a date is known (noon placeholder will be used).' },
    event_title: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Short specific calendar title (<=60 chars). Null when not calendar_eligible.' },
    event_location: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Where it happens: store/retailer name, city/state, "Online", or distribution channel. Null if unknown.' }
  },
  required: ['category', 'reasoning', 'event_key', 'summary', 'product_name', 'release_date', 'price', 'region_availability', 'lottery_deadline', 'desirability_score', 'discord_title', 'is_meaningful_update', 'update_summary', 'is_regional', 'is_ping_worthy_imminent', 'action_url', 'action_link_text', 'calendar_eligible', 'event_starts_now', 'event_start_date', 'event_start_time', 'event_title', 'event_location'],
  additionalProperties: false
};

function renderCandidateEvents(candidateEvents) {
  const lines = [];
  for (const c of candidateEvents) {
    let pd = {};
    try { pd = JSON.parse(c.posted_details || '{}'); } catch {}
    const bits = [pd.product_name, pd.release_date].filter(Boolean).join(' — ');
    lines.push(`- "${c.event_key}"${bits ? ` (${bits})` : ''}`);
  }
  return lines.join('\n');
}

async function analyzeEmail(apiKey, model, emailData, screenshotPath, previousEventDetails = null, candidateEvents = []) {
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

  if (candidateEvents && candidateEvents.length) {
    userTextParts.push('');
    userTextParts.push('--- KNOWN RECENT EVENTS (reuse an existing event_key when this email is the same real-world event) ---');
    userTextParts.push(renderCandidateEvents(candidateEvents));
    userTextParts.push('--- END KNOWN RECENT EVENTS ---');
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
    max_tokens: 2048,
    system: buildSystemPrompt(),
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

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`LLM response hit the max_tokens cap (${response.usage?.output_tokens} output tokens) and was truncated`);
  }

  const rawText = response.content.find(b => b.type === 'text')?.text || '{}';
  const parsed = JSON.parse(rawText);
  parsed._input_tokens = response.usage?.input_tokens || 0;
  parsed._output_tokens = response.usage?.output_tokens || 0;
  return parsed;
}

module.exports = { analyzeEmail };
