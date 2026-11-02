require('./load_env');
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

function safeName(name) {
  return String(name || 'Course Material')
    .replace(/[/:]/g, '-')
    .replace(/[?*"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function walkCourse(node, section, rows, courseTitle = '') {
  if (!node) return;
  const course = node.course || node;
  const meta = course.metadata || {};
  let currentCourseTitle = courseTitle;
  if (course.unitType === 'course') {
    currentCourseTitle = meta.title || course.name || currentCourseTitle;
  }
  if (course.unitType === 'set') section = meta.title || section;
  if (course.unitType === 'module') {
    rows.push({
      type: 'module',
      courseTitle: currentCourseTitle || 'Course Material',
      section,
      id: course.id,
      title: meta.title || '',
      hasAccess: meta.hasAccess ?? null,
      dripDays: meta.dripDays ?? null,
      videoLink: meta.videoLink || null,
      videoLenMs: meta.videoLenMs ?? null,
    });
  } else if (course.unitType === 'course') {
    rows.push({
      type: 'course',
      id: course.id,
      title: meta.title || course.name || '',
      hasAccess: meta.hasAccess ?? null,
      numModules: meta.numModules ?? 0,
      description: meta.desc || '',
    });
  }
  for (const child of node.children || []) walkCourse(child, section || meta.title, rows, currentCourseTitle);
}

(async () => {
  const browser = await chromium.connectOverCDP(process.env.SKOOL_CDP_URL || 'http://127.0.0.1:9222');
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
  const pp = data.props?.pageProps || {};
  const root = pp.course || pp.renderData?.course;
  const rows = [];

  let mainCourseTitle = 'Course Material';
  if (root) {
    mainCourseTitle = safeName(root?.course?.metadata?.title || root?.metadata?.title || root?.name || 'Course Material');
    walkCourse(root, null, rows, mainCourseTitle);
  } else if (pp.allCourses && Array.isArray(pp.allCourses)) {
    for (const c of pp.allCourses) {
      const cTitle = safeName(c.metadata?.title || c.name || 'Course Material');
      if (c.children && c.children.length > 0) {
        walkCourse(c, null, rows, cTitle);
      } else {
        const meta = c.metadata || {};
        rows.push({
          type: 'course',
          id: c.id,
          title: meta.title || c.name || '',
          hasAccess: meta.hasAccess ?? null,
          numModules: meta.numModules ?? 0,
          description: meta.desc || '',
          url: `${classroomUrl.replace(/\/$/, '')}/${c.id}`
        });
      }
    }
  }

  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));

  // For a single course, keep a copy next to its videos. A classroom-level listing
  // (allCourses) has no course of its own, so it only goes to course-state.json above.
  const collectionName = process.env.SKOOL_COLLECTION_NAME || 'Skool Community';
  const academyDir = path.join(rootDir, collectionName);
  const firstModuleCourseTitle = rows.find(r => r.type === 'module' && r.courseTitle)?.courseTitle || (root && mainCourseTitle);
  if (firstModuleCourseTitle) {
    const courseDir = path.join(academyDir, safeName(firstModuleCourseTitle));
    fs.mkdirSync(courseDir, { recursive: true });
    fs.writeFileSync(path.join(courseDir, 'course-state.json'), JSON.stringify(rows, null, 2));
  }
  for (const row of rows) console.log(JSON.stringify(row));
  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
