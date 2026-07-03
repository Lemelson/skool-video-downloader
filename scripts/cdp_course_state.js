const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const outPath = path.join(rootDir, 'course-state.json');
const classroomUrl = process.argv[2] || process.env.SKOOL_CLASSROOM_URL;
if (!classroomUrl) {
  console.error('Usage: node cdp_course_state.js <classroom-url>');
  console.error('  or set SKOOL_CLASSROOM_URL, e.g. https://www.skool.com/<community>/classroom/<courseId>?md=<moduleId>');
  process.exit(2);
}

function walkCourse(node, section, rows) {
  const course = node.course || {};
  const meta = course.metadata || {};
  if (course.unitType === 'set') section = meta.title || section;
  if (course.unitType === 'module') {
    rows.push({
      section,
      id: course.id,
      title: meta.title || '',
      hasAccess: meta.hasAccess ?? null,
      dripDays: meta.dripDays ?? null,
      videoLink: meta.videoLink || null,
      videoLenMs: meta.videoLenMs ?? null,
    });
  }
  for (const child of node.children || []) walkCourse(child, section, rows);
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('skool.com/') && p.url().includes('/classroom'));
  if (!page) page = await context.newPage();
  await page.goto(classroomUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const raw = await page.evaluate(() => document.querySelector('script#__NEXT_DATA__')?.textContent || null);
  if (!raw) {
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) || '');
    throw new Error(`No __NEXT_DATA__. Body starts with: ${text}`);
  }
  const data = JSON.parse(raw);
  const root = data.props.pageProps.course || data.props.pageProps.renderData?.course;
  const rows = [];
  walkCourse(root, null, rows);

  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  for (const row of rows) console.log(JSON.stringify(row));
  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
