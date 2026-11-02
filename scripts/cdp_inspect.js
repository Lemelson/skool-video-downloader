require('./load_env');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const outPath = path.join(root, 'cdp-inspect.json');

(async () => {
  const browser = await chromium.connectOverCDP(process.env.SKOOL_CDP_URL || 'http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();
  const summary = [];
  for (const page of pages) {
    summary.push({ title: await page.title().catch(() => ''), url: page.url() });
  }
  fs.writeFileSync(outPath, JSON.stringify({ summary }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
