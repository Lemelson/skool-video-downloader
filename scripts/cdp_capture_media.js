require('./load_env');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const moduleId = process.argv[2];
const outPath = process.argv[3] || path.join(root, `capture-${moduleId}.json`);
const classroomUrl = process.env.SKOOL_CLASSROOM_URL;

if (!moduleId || !classroomUrl) {
  console.error('Usage: node cdp_capture_media.js <moduleId> [out.json]');
  console.error('  set SKOOL_CLASSROOM_URL to the classroom base, e.g. https://www.skool.com/<community>/classroom/<courseId>');
  process.exit(2);
}

(async () => {
  const browser = await chromium.connectOverCDP(process.env.SKOOL_CDP_URL || 'http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const events = [];

  const record = (kind, item) => {
    const u = item.url();
    if (/googlevideo|videoplayback|youtubei|youtube\.com\/embed|youtube\.com\/watch|manifest|m3u8|mpd|sabr|player/.test(u)) {
      events.push({
        kind,
        url: u,
        method: kind === 'request' ? item.method() : undefined,
        status: kind === 'response' ? item.status() : undefined,
        contentType: kind === 'response' ? (item.headers()['content-type'] || '') : undefined,
      });
    }
  };

  page.on('request', req => record('request', req));
  page.on('response', res => record('response', res));

  const url = `${classroomUrl.split('?')[0]}?md=${moduleId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  const before = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    frames: Array.from(document.querySelectorAll('iframe')).map(f => f.src),
    videos: Array.from(document.querySelectorAll('video')).map(v => v.currentSrc || v.src || ''),
    text: document.body.innerText.slice(0, 2000),
  }));

  await page.mouse.click(960, 520);
  await page.waitForTimeout(20000);
  await page.mouse.click(960, 520);
  await page.waitForTimeout(5000);

  const after = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    frames: Array.from(document.querySelectorAll('iframe')).map(f => f.src),
    videos: Array.from(document.querySelectorAll('video')).map(v => ({
      src: v.currentSrc || v.src || '',
      paused: v.paused,
      currentTime: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : null,
    })),
  }));

  fs.writeFileSync(outPath, JSON.stringify({ before, after, events }, null, 2));
  console.log(outPath);
  console.log(JSON.stringify({
    title: after.title,
    frames: after.frames,
    videos: after.videos,
    eventCount: events.length,
    mediaUrls: [...new Set(events.map(e => e.url).filter(u => /googlevideo|videoplayback|m3u8|mpd|sabr/.test(u)))].slice(0, 20),
  }, null, 2));
  await page.close();
  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
