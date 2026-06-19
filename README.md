# bourbon-email-monitor

Monitors a dedicated Gmail inbox for bourbon and whiskey distillery newsletters. Analyzes each email with Claude (text + rendered screenshot) and posts release alerts to Discord.

## How it works

- Polls Gmail every minute for unread messages
- Renders each email to a screenshot via Playwright Chromium (browser instance shared across all emails in a poll cycle)
- Sends both the text body and screenshot to Claude for multimodal analysis
- Routes the result based on category:

| Category | Description | Action |
|---|---|---|
| 1 | Advertisement for existing products | Log and discard |
| 2 | New product / event / lottery announcement | Post to releases channel (with dedup) |
| 3 | Immediate product release | Post to releases channel |
| 4 | Retailer sale on existing product | Post to releases channel (with dedup, desirability filter) |
| 5 | Action required (confirm subscription, etc.) | Post to alerts channel |
| 6 | Doesn't fit any category | Post to alerts channel for human triage |

**Smart deduplication:** follow-up emails about a known event are re-analyzed against the previous post's details. Only re-fires if material new information is present (added dates, prices, lottery deadlines, etc.).

**Desirability filter:** category 4 (retailer sales) are only posted if `desirability_score >= min_desirability_cat4` (default 2). Scores rank scarcity and exclusivity over brand fame — a private barrel pick with a limited access link outranks a wide public release of a more famous label.

**Retry:** all Discord posts retry up to 3 times with exponential backoff (2s / 4s / 6s) before failing.

**Daily heartbeat:** on the first poll of each UTC day, posts a status message to the alerts channel with email counts by category, Discord post count, and LLM token usage + estimated cost for the day and current month.

**Screenshot cleanup:** screenshots older than 30 days are deleted during daily maintenance.

## Setup

### 1. Google Cloud

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Gmail API**
3. Configure the OAuth consent screen (External, add your monitor inbox as a test user)
4. Create an **OAuth 2.0 Client ID** (Desktop app type), download as `credentials.json`

### 2. Install

```bash
npm install
npx playwright install chromium
```

### 3. Configure

Copy and fill in `config.json`:

```json
{
  "gmail_credentials_path": "./credentials.json",
  "gmail_token_path": "./token.json",
  "discord_alerts_webhook_url": "https://discord.com/api/webhooks/...",
  "discord_releases_webhook_url": "https://discord.com/api/webhooks/...",
  "anthropic_api_key": "sk-ant-...",
  "poll_interval_minutes": 1,
  "screenshot_dir": "./screenshots",
  "db_path": "./emails.db",
  "dedup_window_days": 30,
  "model": "claude-sonnet-4-6",
  "min_desirability_cat4": 2,
  "llm_input_cost_per_million": 3.00,
  "llm_output_cost_per_million": 15.00
}
```

| Field | Default | Description |
|---|---|---|
| `discord_alerts_webhook_url` | required | Operational alerts: errors, cat 5 action-required, cat 6 triage, daily heartbeat |
| `discord_releases_webhook_url` | required | Bourbon release announcements |
| `poll_interval_minutes` | `5` | How often to check Gmail |
| `dedup_window_days` | `30` | How long to remember an event for dedup purposes |
| `model` | `claude-sonnet-4-6` | Anthropic model to use for classification |
| `min_desirability_cat4` | `2` | Minimum desirability score (1–5) to post a category 4 retailer sale |
| `llm_input_cost_per_million` | `3.00` | Input token cost for heartbeat cost estimates |
| `llm_output_cost_per_million` | `15.00` | Output token cost for heartbeat cost estimates |

### 4. Authorize Gmail

```bash
node auth.js
```

Opens a browser, authorize with the Gmail account being monitored, paste the code back. Saves `token.json`.

### 5. Run

```bash
pm2 start index.js --name email-monitor
pm2 save
```

## Files

```
index.js        # polling loop and main pipeline
gmail.js        # Gmail API auth, fetch, MIME parsing
screenshot.js   # Playwright email renderer
classify.js     # Claude multimodal analysis → structured JSON
notify.js       # Discord webhook posts and heartbeat
db.js           # SQLite schema and queries
config.js       # config loader
auth.js         # one-time Gmail OAuth flow
```

## Database

SQLite at `emails.db`:
- `emails` — every processed email with classification, summary, Discord post status, and LLM token counts
- `known_events` — dedup table tracking announced events and what was previously posted

## Desirability scores

Scores rank 1–5. Exclusivity of **access** matters most — a statewide public drop (OHLQ, FWGS) is not truly scarce even if it's state-only.

| Score | Examples |
|---|---|
| 1 | Generic ads, standard lineup products, multi-category retailer blowout sales |
| 2 | Mid-tier store picks, widely obtainable limited releases, statewide public drops (OHLQ/FWGS exclusive barrels) |
| 3 | Single barrel picks with genuinely private/limited purchase links, hard-to-find regionals |
| 4 | Major annual allocated hunts: Russell's Reserve 13yr Barrel Proof, Eagle Rare 12, Old Forester Birthday Bourbon, Old Forester President's Choice, Elijah Craig 21 |
| 5 | Trophy tier: BTAC (Stagg, WLW, Handy, Sazerac 18, Eagle Rare 17), Pappy Van Winkle, Russell's Reserve 15yr, Austin Nichols Archive (Gold Foil), Jack Daniel's 14yr, Heaven Hill 22yr |
