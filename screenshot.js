'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function renderEmailToScreenshot(html, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // If no HTML, wrap plain text
  const content = html || '<pre style="font-family:sans-serif;padding:16px;white-space:pre-wrap;">(no HTML body)</pre>';

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1000, height: 900 });

    // Block external resources that would delay rendering or fail silently
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      // Allow stylesheets and fonts; block tracking pixels and third-party scripts
      if (['document', 'stylesheet', 'font', 'image'].includes(resourceType)) {
        route.continue();
      } else {
        route.abort();
      }
    });

    await page.setContent(content, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Brief pause for CSS/web fonts to settle
    await page.waitForTimeout(500);

    await page.screenshot({ path: outputPath, fullPage: true });
  } finally {
    await browser.close();
  }

  return outputPath;
}

module.exports = { renderEmailToScreenshot };
