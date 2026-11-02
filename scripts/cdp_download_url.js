require('./load_env');
const fs = require('fs');
const { chromium } = require('playwright');

const url = process.argv[2];
const out = process.argv[3];

if (!url || !out) {
  console.error('Usage: node cdp_download_url.js <url> <out>');
  process.exit(2);
}

(async () => {
  const browser = await chromium.connectOverCDP(process.env.SKOOL_CDP_URL || 'http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
  if (!response || !response.ok()) {
    throw new Error(`Bad response: ${response && response.status()}`);
  }
  const body = await response.body();
  fs.writeFileSync(out, body);
  console.log(`${out} ${body.length}`);
  await page.close();
  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
