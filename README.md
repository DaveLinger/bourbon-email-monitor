# bourbon-email-monitor

Monitors a dedicated Gmail inbox for bourbon and whiskey distillery newsletters. Analyzes each email with Claude (text + rendered screenshot) and posts release alerts to Discord.

## How it works

- Polls Gmail every minute for unread messages
- Renders each email to a screenshot via Playwright Chromium
- Sends both the text body and screenshot to Claude for multimodal analysis
- Routes the result based on category:

| Category | Description | Action |
|---|---|---|
| 1 | Advertisement for existing products | Log and discard |
| 2 | New product / event / lottery announcement | Post to releases channel (with dedup) |
| 3 | Immediate product release | Post to releases channel |
| 4 | Retailer sale on existing product | Post to releases channel (with dedup) |
| 5 | Action required (confirm subscription, etc.) | Post to alerts channel |

**Smart deduplication:** follow-up emails about a known event are re-analyzed against the previous post's details. Only re-fires if material new information is present (added dates, prices, lottery deadlines, etc.).

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
  "model": "claude-sonnet-4-6"
}
```

- **`discord_alerts_webhook_url`** — operational alerts: errors, action-required emails
- **`discord_releases_webhook_url`** — bourbon release announcements

### 4. Authorize Gmail

```bash
node auth.js
```

Opens a browser, authorize with the Gmail account being monitored, paste the code back. Saves `token.json`.

### 5. Run

```bash
pm2 start index.js --name bourbon-email-monitor
pm2 save
```

## Files

```
index.js        # polling loop and main pipeline
gmail.js        # Gmail API auth, fetch, MIME parsing
screenshot.js   # Playwright email renderer
classify.js     # Claude multimodal analysis → structured JSON
notify.js       # Discord webhook posts
db.js           # SQLite schema and queries
config.js       # config loader
auth.js         # one-time Gmail OAuth flow
```

## Database

SQLite at `emails.db`:
- `emails` — every processed email with classification, summary, and Discord post status
- `known_events` — dedup table tracking announced events and what was previously posted
