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

    // Anthropic rejects images with any dimension > 8000px. Long newsletter
    // digests render taller than that, so clip the capture to stay under it.
    // (Clips the bottom of very long emails; key release info is near the top.)
    const MAX_DIM = 7800;
    const dims = await page.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    }));
    if (dims.width > MAX_DIM || dims.height > MAX_DIM) {
      console.warn(`Email renders to ${dims.width}x${dims.height}px; clipping to ${MAX_DIM}px`);
      await page.screenshot({
        path: outputPath,
        clip: { x: 0, y: 0, width: Math.min(dims.width, MAX_DIM), height: Math.min(dims.height, MAX_DIM) },
      });
    } else {
      await page.screenshot({ path: outputPath, fullPage: true });
    }
    await page.close();
  } finally {
    if (!sharedBrowser) await browser.close();
  }

  return outputPath;
}

module.exports = { launchBrowser, renderEmailToScreenshot };
