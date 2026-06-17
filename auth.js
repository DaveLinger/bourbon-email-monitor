'use strict';
// Run once to authorize Gmail access: node auth.js
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');
const { loadConfig } = require('./config');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

async function main() {
  const config = loadConfig();
  const credsPath = config.gmail_credentials_path;
  const tokenPath = config.gmail_token_path;

  if (!fs.existsSync(credsPath)) {
    console.error(`credentials.json not found at ${credsPath}`);
    console.error('Download it from: https://console.cloud.google.com/');
    console.error('  1. Create a project and enable Gmail API');
    console.error('  2. Create OAuth2 credentials (Desktop app type)');
    console.error('  3. Download and save as credentials.json');
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\nAuthorize this app by visiting:\n');
  console.log(authUrl);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(resolve => rl.question('Enter the authorization code: ', resolve));
  rl.close();

  const { tokens } = await oAuth2Client.getToken(code.trim());
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`\nToken saved to ${tokenPath}`);
  console.log('You can now run: pm2 start index.js --name email-monitor');
}

main().catch(err => {
  console.error('Auth error:', err.message);
  process.exit(1);
});
