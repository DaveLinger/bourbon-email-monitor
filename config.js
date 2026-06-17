'use strict';
const fs = require('fs');
const path = require('path');

let _config = null;

function loadConfig() {
  if (_config) return _config;
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  _config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const required = ['gmail_credentials_path', 'gmail_token_path', 'discord_alerts_webhook_url', 'discord_releases_webhook_url', 'anthropic_api_key'];
  for (const key of required) {
    if (!_config[key]) throw new Error(`config.json missing required field: ${key}`);
  }
  _config.poll_interval_minutes = _config.poll_interval_minutes || 5;
  _config.screenshot_dir = path.resolve(__dirname, _config.screenshot_dir || './screenshots');
  _config.db_path = path.resolve(__dirname, _config.db_path || './emails.db');
  _config.dedup_window_days = _config.dedup_window_days || 30;
  _config.model = _config.model || 'claude-sonnet-4-6';
  return _config;
}

module.exports = { loadConfig };
