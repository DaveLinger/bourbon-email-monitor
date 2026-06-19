'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function launchBrowser() {
  return chromium.launch();
}

async function renderEmailToScreenshot(html, outputPath, sharedBrowser = null) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const content = html || '<pre style="font-family:sans-serif;padding:16px;white-space:pre-wrap;">(no HTML body)</pre>';

  const browser = sharedBrowser || await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1000, height: 900 });

    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['document', 'stylesheet', 'font', 'image'].includes(resourceType)) {
        route.continue();
      } else {
        route.abort();
      }
    });

    await page.setContent(content, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: outputPath, fullPage: true });
    await page.close();
  } finally {
    if (!sharedBrowser) await browser.close();
  }

  return outputPath;
}

module.exports = { launchBrowser, renderEmailToScreenshot };
