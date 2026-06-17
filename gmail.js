'use strict';
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function loadCredentials(credentialsPath) {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Gmail credentials not found at ${credentialsPath}. Download from Google Cloud Console.`);
  }
  return JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
}

async function authenticate(credentialsPath, tokenPath) {
  const creds = loadCredentials(credentialsPath);
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    oAuth2Client.setCredentials(token);
    oAuth2Client.on('tokens', (tokens) => {
      const current = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      fs.writeFileSync(tokenPath, JSON.stringify({ ...current, ...tokens }));
    });
    return oAuth2Client;
  }

  throw new Error(`No token found at ${tokenPath}. Run: node auth.js`);
}

async function fetchUnreadIds(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX', 'UNREAD'],
    maxResults: 50,
  });
  return (res.data.messages || []).map(m => m.id);
}

// Recursively walk MIME parts to extract text, html, and images
async function extractParts(gmail, messageId, part, result) {
  const mimeType = part.mimeType || '';
  const headers = part.headers || [];
  const getHeader = (name) => {
    const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : null;
  };

  if (mimeType.startsWith('multipart/')) {
    for (const sub of (part.parts || [])) {
      await extractParts(gmail, messageId, sub, result);
    }
    return;
  }

  // Get raw data — either inline or via attachment fetch
  let rawData = part.body?.data || null;
  if (!rawData && part.body?.attachmentId) {
    try {
      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: part.body.attachmentId,
      });
      rawData = att.data.data;
    } catch (e) {
      console.warn(`Failed to fetch attachment ${part.body.attachmentId}:`, e.message);
    }
  }
  if (!rawData) return;

  if (mimeType === 'text/plain' && !result.text) {
    result.text = Buffer.from(rawData, 'base64url').toString('utf-8');
  } else if (mimeType === 'text/html' && !result.html) {
    result.html = Buffer.from(rawData, 'base64url').toString('utf-8');
  } else if (mimeType.startsWith('image/')) {
    const contentId = getHeader('Content-ID');
    const b64 = Buffer.from(rawData, 'base64url').toString('base64');
    if (contentId) {
      result.inlineImages.push({ cid: contentId.replace(/[<>]/g, ''), mimeType, data: b64 });
    } else {
      result.attachmentImages.push({ mimeType, data: b64 });
    }
  }
}

async function getMessage(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const msg = res.data;
  const headers = msg.payload.headers || [];
  const getHeader = (name) => {
    const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : null;
  };

  const result = { text: '', html: '', inlineImages: [], attachmentImages: [] };
  await extractParts(gmail, messageId, msg.payload, result);

  // Substitute cid: references in HTML with data URIs
  if (result.html && result.inlineImages.length > 0) {
    for (const img of result.inlineImages) {
      const cidPattern = new RegExp(`cid:${img.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
      result.html = result.html.replace(cidPattern, `data:${img.mimeType};base64,${img.data}`);
    }
  }

  return {
    id: messageId,
    from: getHeader('From') || '',
    subject: getHeader('Subject') || '(no subject)',
    date: getHeader('Date') || new Date().toISOString(),
    text: result.text,
    html: result.html,
    attachmentImages: result.attachmentImages,
  };
}

async function markAsRead(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

module.exports = { authenticate, fetchUnreadIds, getMessage, markAsRead };
