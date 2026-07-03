const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const userDataDir = path.join(root, 'Служебные файлы - можно не трогать', '03 Технические зависимости', '.chrome-playwright-profile');
const url = process.argv[2] || process.env.SKOOL_CLASSROOM_URL;
if (!url) {
  console.error('Usage: node inspect_skool_playwright.js <classroom-url>');
  console.error('  or set SKOOL_CLASSROOM_URL, e.g. https://www.skool.com/<community>/classroom/<courseId>');
  process.exit(2);
}
const outPath = path.join(root, 'playwright-skool-inspect.json');

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const seen = [];
  page.on('request', req => {
    const u = req.url();
    if (/youtube|googlevideo|wistia|skool|player|videoplayback|m3u8|mpd/.test(u)) {
      seen.push({ type: 'request', method: req.method(), url: u });
    }
  });
  page.on('response', res => {
    const u = res.url();
    if (/youtube|googlevideo|wistia|skool|player|videoplayback|m3u8|mpd/.test(u)) {
      seen.push({ type: 'response', status: res.status(), url: u, contentType: res.headers()['content-type'] || '' });
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);

  const info = await page.evaluate(() => {
    const next = document.querySelector('script#__NEXT_DATA__')?.textContent || null;
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src);
    const videos = Array.from(document.querySelectorAll('video')).map(v => ({
      src: v.currentSrc || v.src || '',
      readyState: v.readyState,
      duration: Number.isFinite(v.duration) ? v.duration : null,
    }));
    return {
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.slice(0, 5000) || '',
      nextData: next,
      iframes,
      videos,
    };
  });

  fs.writeFileSync(outPath, JSON.stringify({ info, seen }, null, 2));
  console.log(outPath);
  console.log(JSON.stringify({
    title: info.title,
    url: info.url,
    hasNextData: Boolean(info.nextData),
    iframes: info.iframes,
    videos: info.videos,
    networkCount: seen.length,
  }, null, 2));

  await context.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
