const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const collectionName = process.env.SKOOL_COLLECTION_NAME || 'Skool Community';
const finalRoot = path.join(rootDir, collectionName);
const courseUrl = process.argv[2] || process.env.SKOOL_CLASSROOM_URL;
const manifestPath = path.join(rootDir, 'pdf-resources.json');

if (!courseUrl) {
  console.error('Usage: node cdp_download_pdf_resources.js <classroom-url>');
  console.error('  or set SKOOL_CLASSROOM_URL, e.g. https://www.skool.com/<community>/classroom/<courseId>?md=<moduleId>');
  process.exit(2);
}

function parseResources(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stripDuration(title) {
  return (title || '').replace(/\s+\((?:\d+:)?\d{1,2}:\d{2}\)\s*$/, '').trim();
}

function stripPdfExt(name) {
  return (name || '').replace(/\.pdf\s*$/i, '').trim();
}

function comparableTitle(name) {
  return (name || '')
    .replace(/^\(\$\)\s*/, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function safeName(name) {
  return name
    .replace(/[/:]/g, '-')
    .replace(/[?*"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
      resources: parseResources(meta.resources),
    });
  }
  for (const child of node.children || []) walkCourse(child, section, rows);
}

function buildVideoIndex() {
  const index = new Map();
  if (!fs.existsSync(finalRoot)) return index;

  const sections = fs.readdirSync(finalRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  for (const section of sections) {
    const sectionDir = path.join(finalRoot, section);
    const files = fs.readdirSync(sectionDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !/\.mp4$/i.test(file.name)) continue;
      const match = file.name.match(/^(\d+)\s+-\s+(.+)\.mp4$/i);
      if (!match) continue;
      const number = match[1];
      const title = stripDuration(match[2]);
      index.set(`${section}\n${title.toLowerCase()}`, { number, title });
    }
  }
  return index;
}

function destinationFor(row, resource, fallbackNumber, videoIndex) {
  const section = row.section || 'Resources';
  const sectionDir = path.join(finalRoot, safeName(section));
  fs.mkdirSync(sectionDir, { recursive: true });

  const lessonTitle = stripDuration(row.title);
  const hit = videoIndex.get(`${section}\n${lessonTitle.toLowerCase()}`);
  const number = hit?.number || String(fallbackNumber).padStart(2, '0');

  const resourceTitle = stripPdfExt(resource.title || resource.file_name || 'Resource');
  const sameAsLesson = comparableTitle(resourceTitle) === comparableTitle(lessonTitle);
  const stem = sameAsLesson ? lessonTitle : `${lessonTitle} - ${resourceTitle}`;

  return path.join(sectionDir, `${number} - ${safeName(stem)}.pdf`);
}

async function getSignedUrl(page, fileId) {
  return await page.evaluate(async id => {
    const response = await fetch(`https://api2.skool.com/files/${id}/download-url?expire=28800`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error(`download-url ${response.status}`);
    }
    return await response.text();
  }, fileId);
}

async function downloadBody(url) {
  const response = await fetch(url.trim(), {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (!response.ok) {
    throw new Error(`file response ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('skool.com/') && p.url().includes('/classroom')) || await context.newPage();

  await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const raw = await page.evaluate(() => document.querySelector('script#__NEXT_DATA__')?.textContent || null);
  if (!raw) throw new Error('No __NEXT_DATA__ found on Skool classroom page');

  const data = JSON.parse(raw);
  const root = data.props.pageProps.course || data.props.pageProps.renderData?.course;
  const rows = [];
  walkCourse(root, null, rows);

  const videoIndex = buildVideoIndex();
  const pdfs = [];
  let fallbackNumber = 1;
  for (const row of rows) {
    const pdfResources = row.resources.filter(resource => {
      const name = `${resource.title || ''} ${resource.file_name || ''} ${resource.file_content_type || ''}`;
      return resource.file_id && (/application\/pdf/i.test(resource.file_content_type || '') || /\.pdf\b/i.test(name));
    });
    for (const resource of pdfResources) {
      const dest = destinationFor(row, resource, fallbackNumber, videoIndex);
      pdfs.push({
        section: row.section,
        moduleId: row.id,
        moduleTitle: row.title,
        title: resource.title || resource.file_name,
        fileId: resource.file_id,
        dest,
      });
    }
    fallbackNumber += 1;
  }

  fs.writeFileSync(manifestPath, JSON.stringify(pdfs, null, 2));
  console.log(`found ${pdfs.length} pdf resource(s)`);

  for (const item of pdfs) {
    if (fs.existsSync(item.dest) && fs.statSync(item.dest).size > 1024) {
      console.log(`skip ${item.dest}`);
      continue;
    }

    const tmp = `${item.dest}.part`;
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    console.log(`download ${item.title} -> ${item.dest}`);
    const signedUrl = await getSignedUrl(page, item.fileId);
    const body = await downloadBody(signedUrl);
    if (body.length < 1024 || body.slice(0, 4).toString() !== '%PDF') {
      throw new Error(`Downloaded body is not a valid PDF for ${item.title}`);
    }
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, item.dest);
    console.log(`saved ${body.length} bytes`);
  }

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
