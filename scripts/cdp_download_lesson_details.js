require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const collectionName = process.env.SKOOL_COLLECTION_NAME || 'Skool Community';
const academyDir = path.join(rootDir, collectionName);
const cdpUrl = process.env.CDP_URL || process.env.SKOOL_CDP_URL || 'http://127.0.0.1:9222';
const courseUrl = process.argv[2] || process.env.SKOOL_CLASSROOM_URL || process.env.SKOOL_COURSE_URL;
if (!courseUrl) {
  console.error('Usage: node cdp_download_lesson_details.js <classroom-url>');
  console.error('  or set SKOOL_CLASSROOM_URL, e.g. https://www.skool.com/<community>/classroom/<courseId>?md=<moduleId>');
  process.exit(2);
}
const classroomBaseUrl = courseUrl.split('?')[0];

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

function parseDesc(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const value = raw.startsWith('[v2]') ? raw.slice(4) : raw;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripDuration(title) {
  return (title || '').replace(/\s+\((?:\d+[:\-])?\d{1,2}[:\-]\d{2}\)\s*$/, '').trim();
}

function stripExt(name) {
  return String(name || 'Resource')
    .replace(/\s*\(\s*\.[a-z0-9]+\s*\)\s*$/i, '')
    .replace(/\s*\.[a-z0-9]+\s*$/i, '')
    .trim();
}

function extensionFor(resource) {
  const fileName = resource.file_name || resource.title || '';
  const ext = path.extname(fileName);
  if (ext) return ext;
  const type = (resource.file_content_type || '').toLowerCase();
  if (type.includes('pdf')) return '.pdf';
  if (type.includes('png')) return '.png';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('plain')) return '.txt';
  if (type.includes('zip')) return '.zip';
  return '';
}

function extensionFromLink(resource) {
  const title = resource.title || '';
  if (/\.zip\)?$/i.test(title) || /\bzip\b/i.test(title)) return '.zip';
  const linkPath = (() => {
    try {
      return new URL(resource.link || '').pathname;
    } catch {
      return '';
    }
  })();
  return path.extname(linkPath) || '';
}

function comparableTitle(name) {
  return (name || '')
    .replace(/^\(\$\)\s*/, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function safeName(name) {
  return String(name || 'Untitled')
    .replace(/[/:]/g, '-')
    .replace(/[?*"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
      desc: meta.desc || '',
      resources: parseResources(meta.resources),
    });
  }
  for (const child of node.children || []) walkCourse(child, section, rows);
}

function buildVideoIndex() {
  const index = new Map();
  if (!fs.existsSync(academyDir)) return index;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.mp4$/i.test(entry.name)) {
        const match = entry.name.match(/^(\d+)\s+-\s+(.+)\.mp4$/i);
        if (!match) continue;
        const number = match[1];
        const title = stripDuration(match[2]);
        const sectionName = path.basename(dir);
        index.set(`${sectionName}\n${comparableTitle(title)}`, { number, title, dir });
        index.set(`${comparableTitle(title)}`, { number, title, dir });
      }
    }
  }
  walk(academyDir);
  return index;
}

function moduleLocation(row, fallbackNumber, videoIndex, courseTitle) {
  const cTitle = safeName(courseTitle || 'Course Material');
  const courseDir = path.join(academyDir, cTitle);
  const resourcesDir = path.join(courseDir, 'resources');
  const sectionName = row.section ? safeName(row.section) : '';
  const dir = (sectionName && sectionName !== cTitle) ? path.join(resourcesDir, sectionName) : resourcesDir;
  const lessonTitle = stripDuration(row.title);
  const hit = videoIndex.get(`${sectionName}\n${comparableTitle(lessonTitle)}`);
  const number = hit?.number || String(fallbackNumber).padStart(2, '0');
  fs.mkdirSync(dir, { recursive: true });
  return { number, dir, lessonTitle };
}

function resourceDestination(row, resource, fallbackNumber, videoIndex, courseTitle) {
  const { number, dir, lessonTitle } = moduleLocation(row, fallbackNumber, videoIndex, courseTitle);
  const ext = resource.file_id ? extensionFor(resource) : extensionFromLink(resource);
  const resourceStem = stripExt(resource.title || resource.file_name || 'Resource');
  const sameAsLesson = comparableTitle(resourceStem) === comparableTitle(lessonTitle);
  const stem = sameAsLesson ? lessonTitle : `${lessonTitle} - ${resourceStem}`;
  return path.join(dir, `${number} - ${safeName(stem)}${ext}`);
}

function notesDestination(row, fallbackNumber, videoIndex, ext, courseTitle) {
  const { number, dir, lessonTitle } = moduleLocation(row, fallbackNumber, videoIndex, courseTitle);
  return path.join(dir, `${number} - ${safeName(lessonTitle)} - Notes${ext}`);
}

function renderMarks(text, marks = []) {
  let value = escapeHtml(text || '');
  for (const mark of marks || []) {
    if (mark.type === 'link') {
      const href = escapeHtml(mark.attrs?.href || '#');
      value = `<a href="${href}" target="_blank" rel="noopener noreferrer">${value}</a>`;
    } else if (mark.type === 'bold') {
      value = `<strong>${value}</strong>`;
    } else if (mark.type === 'italic') {
      value = `<em>${value}</em>`;
    } else if (mark.type === 'strike') {
      value = `<s>${value}</s>`;
    }
  }
  return value;
}

function nodeToHtml(node) {
  if (!node) return '';
  if (node.type === 'text') return renderMarks(node.text, node.marks);
  const children = (node.content || []).map(nodeToHtml).join('');
  if (node.type === 'heading') {
    const level = Math.min(Math.max(Number(node.attrs?.level || 2), 1), 4);
    return `<h${level}>${children}</h${level}>`;
  }
  if (node.type === 'paragraph') return children.trim() ? `<p>${children}</p>` : '';
  if (node.type === 'unorderedList') return `<ul>${children}</ul>`;
  if (node.type === 'orderedList') return `<ol>${children}</ol>`;
  if (node.type === 'listItem') return `<li>${children}</li>`;
  if (node.type === 'blockquote') return `<blockquote>${children}</blockquote>`;
  if (node.type === 'codeBlock') return `<pre><code>${escapeHtml((node.content || []).map(child => child.text || '').join('\n'))}</code></pre>`;
  if (node.type === 'hardBreak') return '<br>';
  return children;
}

function nodeToMarkdown(node) {
  if (!node) return '';
  if (node.type === 'text') {
    const link = (node.marks || []).find((mark) => mark.type === 'link');
    let value = node.text || '';
    if ((node.marks || []).some((mark) => mark.type === 'bold')) value = `**${value}**`;
    if ((node.marks || []).some((mark) => mark.type === 'italic')) value = `_${value}_`;
    if (link?.attrs?.href) value = `[${value}](${link.attrs.href})`;
    return value;
  }
  const children = (node.content || []).map(nodeToMarkdown).join('');
  if (node.type === 'heading') return `${'#'.repeat(Number(node.attrs?.level || 2))} ${children}\n\n`;
  if (node.type === 'paragraph') return children.trim() ? `${children}\n\n` : '';
  if (node.type === 'unorderedList') return `${(node.content || []).map((item) => `- ${nodeToMarkdown(item).trim()}`).join('\n')}\n\n`;
  if (node.type === 'orderedList') return `${(node.content || []).map((item, index) => `${index + 1}. ${nodeToMarkdown(item).trim()}`).join('\n')}\n\n`;
  if (node.type === 'listItem') return children;
  if (node.type === 'blockquote') return `${children.trim().split('\n').map(line => line.trim() ? `> ${line}` : '>').join('\n')}\n\n`;
  if (node.type === 'codeBlock') return `\`\`\`\n${(node.content || []).map(child => child.text || '').join('\n')}\n\`\`\`\n\n`;
  if (node.type === 'hardBreak') return '\n';
  return children;
}

function descToHtml(desc) {
  const nodes = parseDesc(desc);
  if (!nodes) return '';
  return nodes.map(nodeToHtml).join('\n');
}

function descToMarkdown(desc) {
  const nodes = parseDesc(desc);
  if (!nodes) return '';
  const rendered = nodes.map(nodeToMarkdown).join('').replace(/\n{3,}/g, '\n\n').trim();
  return rendered ? `${rendered}\n` : '';
}

function findSelectedModule(root, moduleId) {
  let found = null;
  function walk(node, section) {
    if (!node || found) return;
    const course = node.course || {};
    const meta = course.metadata || {};
    if (course.unitType === 'set') section = meta.title || section;
    if (course.unitType === 'module' && course.id === moduleId) {
      found = {
        section,
        id: course.id,
        title: meta.title || '',
        hasAccess: meta.hasAccess ?? null,
        dripDays: meta.dripDays ?? null,
        desc: meta.desc || '',
        resources: parseResources(meta.resources),
      };
      return;
    }
    for (const child of node.children || []) walk(child, section);
  }
  walk(root, null);
  return found;
}

async function getSignedUrl(page, fileId) {
  return await page.evaluate(async id => {
    const response = await fetch(`https://api2.skool.com/files/${id}/download-url?expire=28800`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`download-url ${response.status}`);
    return await response.text();
  }, fileId);
}

async function downloadBody(url) {
  const response = await fetch(url.trim(), {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!response.ok) throw new Error(`file response ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function googleDriveFileId(link) {
  try {
    const url = new URL(link);
    if (!/drive\.google\.com$/i.test(url.hostname)) return null;
    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    if (fileMatch) return fileMatch[1];
    return url.searchParams.get('id');
  } catch {
    return null;
  }
}

function cookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function downloadGoogleDrive(link) {
  const id = googleDriveFileId(link);
  if (!id) throw new Error(`Not a Google Drive file link: ${link}`);

  let url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  const cookies = [];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        ...(cookies.length ? { Cookie: cookieHeader(cookies) } : {}),
      },
    });

    for (const rawCookie of response.headers.getSetCookie?.() || []) {
      const [pair] = rawCookie.split(';');
      const [name, value] = pair.split('=');
      if (name && value) {
        const existing = cookies.find((cookie) => cookie.name === name);
        if (existing) existing.value = value;
        else cookies.push({ name, value });
      }
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Google Drive redirect without Location for ${link}`);
      url = new URL(location, url).toString();
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.slice(0, Math.min(buffer.length, 200000)).toString('utf8');

    if (/text\/html/i.test(contentType) && /confirm=|download-form/.test(text)) {
      const formAction =
        text.match(/<form[^>]+id="download-form"[^>]+action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&') ||
        'https://drive.usercontent.google.com/download';
      const inputs = [...text.matchAll(/<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g)];
      if (inputs.length) {
        const next = new URL(formAction);
        for (const [, name, value] of inputs) next.searchParams.set(name, value.replaceAll('&amp;', '&'));
        url = next.toString();
        continue;
      }
    }

    if (!response.ok) throw new Error(`Google Drive response ${response.status} for ${link}`);
    if (/text\/html/i.test(contentType)) throw new Error(`Google Drive returned HTML instead of file for ${link}`);
    return buffer;
  }

  throw new Error(`Could not resolve Google Drive download for ${link}`);
}

(async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('skool.com/') && p.url().includes('/classroom')) || await context.newPage();

  await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const raw = await page.evaluate(() => document.querySelector('script#__NEXT_DATA__')?.textContent || null);
  if (!raw) throw new Error('No __NEXT_DATA__ found on Skool classroom page');

  const data = JSON.parse(raw);
  const root = data.props.pageProps.course || data.props.pageProps.renderData?.course;
  let rows = [];
  walkCourse(root, null, rows);

  const enrichedRows = [];
  for (const row of rows) {
    if (row.hasAccess !== 1) {
      enrichedRows.push(row);
      continue;
    }

    await page.goto(`${classroomBaseUrl}?md=${row.id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(1200);
    const selected = await page.evaluate((moduleId) => {
      const raw = document.querySelector('script#__NEXT_DATA__')?.textContent || null;
      if (!raw) return null;
      const data = JSON.parse(raw);
      function parseResources(rawResources) {
        if (!rawResources) return [];
        if (Array.isArray(rawResources)) return rawResources;
        if (typeof rawResources !== 'string') return [];
        try {
          const parsed = JSON.parse(rawResources);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      function find(rootNode, section) {
        const course = rootNode?.course || {};
        const meta = course.metadata || {};
        if (course.unitType === 'set') section = meta.title || section;
        if (course.unitType === 'module' && course.id === moduleId) {
          return {
            section,
            id: course.id,
            title: meta.title || '',
            hasAccess: meta.hasAccess ?? null,
            dripDays: meta.dripDays ?? null,
            desc: meta.desc || '',
            resources: parseResources(meta.resources),
          };
        }
        for (const child of rootNode?.children || []) {
          const hit = find(child, section);
          if (hit) return hit;
        }
        return null;
      }
      return find(data.props.pageProps.course || data.props.pageProps.renderData?.course, null);
    }, row.id);
    enrichedRows.push(selected || row);
    console.log(`read ${row.title}`);
  }
  rows = enrichedRows;

  const mainCourseTitle = safeName(root?.course?.metadata?.title || root?.metadata?.title || 'Course Material');
  const courseDir = path.join(academyDir, mainCourseTitle);
  fs.mkdirSync(courseDir, { recursive: true });

  const videoIndex = buildVideoIndex();
  const details = [];
  let fallbackNumber = 1;

  for (const row of rows) {
    const descHtml = descToHtml(row.desc);
    const descMarkdown = descToMarkdown(row.desc);
    const noteHtmlPath = descHtml ? notesDestination(row, fallbackNumber, videoIndex, '.html', mainCourseTitle) : null;
    const noteMdPath = descMarkdown ? notesDestination(row, fallbackNumber, videoIndex, '.md', mainCourseTitle) : null;

    if (descHtml && noteHtmlPath) {
      fs.writeFileSync(noteHtmlPath, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(row.title)} - Notes</title>
<style>
body { margin: 32px auto; max-width: 820px; padding: 0 20px; font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #202124; }
a { color: #3b73ff; text-decoration: none; }
h1 { font-size: 30px; }
h2 { font-size: 24px; margin-top: 30px; }
li { margin: 7px 0; }
</style>
</head>
<body>
${descHtml}
</body>
</html>`);
    }
    if (descMarkdown && noteMdPath) fs.writeFileSync(noteMdPath, descMarkdown);

    const resources = [];
    for (const resource of row.resources) {
      const record = {
        title: resource.title || resource.file_name || resource.link || 'Resource',
        contentType: resource.file_content_type || null,
        fileId: resource.file_id || null,
        link: resource.link || null,
        localPath: null,
      };

      if (resource.file_id) {
        const dest = resourceDestination(row, resource, fallbackNumber, videoIndex, mainCourseTitle);
        record.localPath = dest;
        if (!fs.existsSync(dest) || fs.statSync(dest).size < 128) {
          const signedUrl = await getSignedUrl(page, resource.file_id);
          const body = await downloadBody(signedUrl);
          fs.writeFileSync(`${dest}.part`, body);
          fs.renameSync(`${dest}.part`, dest);
          console.log(`saved ${dest}`);
        } else {
          console.log(`skip ${dest}`);
        }
      } else if (resource.link && googleDriveFileId(resource.link)) {
        const dest = resourceDestination(row, resource, fallbackNumber, videoIndex, mainCourseTitle);
        record.localPath = dest;
        if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
          const body = await downloadGoogleDrive(resource.link);
          fs.writeFileSync(`${dest}.part`, body);
          fs.renameSync(`${dest}.part`, dest);
          console.log(`saved ${dest}`);
        } else {
          console.log(`skip ${dest}`);
        }
      }
      resources.push(record);
    }

    details.push({
      courseTitle: mainCourseTitle,
      section: row.section,
      moduleId: row.id,
      moduleTitle: row.title,
      hasAccess: row.hasAccess,
      dripDays: row.dripDays,
      noteHtmlPath,
      noteMdPath,
      descHtml,
      descMarkdown,
      resources,
    });
    fallbackNumber += 1;
  }

  const courseDetailsPath = path.join(courseDir, 'lesson-details.json');
  fs.writeFileSync(courseDetailsPath, JSON.stringify(details, null, 2));
  console.log(`wrote ${courseDetailsPath}`);

  // Also save a top-level copy for convenience
  const rootDetailsPath = path.join(rootDir, 'lesson-details.json');
  fs.writeFileSync(rootDetailsPath, JSON.stringify(details, null, 2));

  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
