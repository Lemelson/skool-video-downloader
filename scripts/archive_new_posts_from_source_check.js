require('./load_env');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const collectionName = process.env.SKOOL_COLLECTION_NAME || 'Skool Community';
const postsRoot = path.join(rootDir, collectionName, 'Community Posts');
const postArchiver = path.join(__dirname, 'cdp_archive_skool_post.js');
const checkPath = process.argv[2] || path.join(postsRoot, `incremental-check-${new Date().toISOString().slice(0, 10)}.json`);
const checkName = path.basename(checkPath).replace(/^incremental-check-/, '').replace(/\.json$/, '') || new Date().toISOString().slice(0, 10);
const prefetchDir = path.join(postsRoot, `_prefetch-${checkName}`);

function osa(script) {
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
}

function quote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function htmlUnescape(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function captureSource(url) {
  execFileSync('/usr/bin/pbcopy', { input: '' });
  osa(`tell application "Google Chrome"
activate
if (count windows) = 0 then make new window
tell window 1
  set URL of active tab to "${quote(`view-source:${url}`)}"
end tell
end tell`);
  execFileSync('/bin/sleep', ['5']);
  let lastSource = '';
  for (let copyAttempt = 0; copyAttempt < 5; copyAttempt += 1) {
    execFileSync('/usr/bin/pbcopy', { input: '' });
    osa(`tell application "System Events"
keystroke "a" using command down
delay 0.35
keystroke "c" using command down
end tell`);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      execFileSync('/bin/sleep', ['1']);
      const source = execFileSync('/usr/bin/pbpaste', { encoding: 'utf8', maxBuffer: 70 * 1024 * 1024 });
      lastSource = source;
      const nextIndex = source.indexOf('id="__NEXT_DATA__"');
      if (nextIndex !== -1 && source.indexOf('</script>', nextIndex) !== -1) return source;
      if (nextIndex === -1 && source.includes('AwsWafIntegration')) return source;
    }
  }
  return lastSource || execFileSync('/usr/bin/pbpaste', { encoding: 'utf8', maxBuffer: 70 * 1024 * 1024 });
}

function parseNextData(source, url) {
  const markerIndex = source.indexOf('id="__NEXT_DATA__"');
  if (markerIndex === -1) throw new Error(`No __NEXT_DATA__ for ${url}`);
  const openEnd = source.indexOf('>', markerIndex);
  const close = source.indexOf('</script>', openEnd);
  if (openEnd === -1 || close === -1) throw new Error(`Broken __NEXT_DATA__ for ${url}`);
  return JSON.parse(htmlUnescape(source.slice(openEnd + 1, close)));
}

function pagePostTree(nextData) {
  return nextData?.props?.pageProps?.postTree || nextData?.props?.pageProps?.renderData?.postTree;
}

function openNormalPage(url, seconds = 45) {
  osa(`tell application "Google Chrome"
activate
if (count windows) = 0 then make new window
tell window 1
  set URL of active tab to "${quote(url)}"
end tell
end tell`);
  execFileSync('/bin/sleep', [String(seconds)]);
}

function countAttachments(post) {
  const value = post.metadata?.attachmentsData || post.metadata?.attachments_data;
  if (!value) return 0;
  if (Array.isArray(value)) return value.length;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

fs.mkdirSync(prefetchDir, { recursive: true });
const check = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
const rows = check.changed.filter(row => row.isNew);
const results = [];

for (const row of rows) {
  const started = Date.now();
  try {
    let source = captureSource(row.url);
    fs.writeFileSync(path.join(prefetchDir, `${row.slug}.source.html`), source);
    let nextData;
    try {
      nextData = parseNextData(source, row.url);
    } catch (err) {
      if (!source.includes('__NEXT_DATA__') && source.includes('AwsWafIntegration')) {
        console.log(`${row.slug}: WAF/check page copied; opening normal page and retrying`);
        openNormalPage(row.url);
        source = captureSource(row.url);
        fs.writeFileSync(path.join(prefetchDir, `${row.slug}.source.html`), source);
        nextData = parseNextData(source, row.url);
      } else {
        throw err;
      }
    }
    const post = pagePostTree(nextData).post;
    if (post.name && post.name !== row.slug) {
      throw new Error(`Copied source for "${post.name}" while archiving "${row.slug}". Retrying later is safer than saving a mismatched post.`);
    }
    const prefetchPath = path.join(prefetchDir, `${row.slug}.json`);
    fs.writeFileSync(prefetchPath, JSON.stringify({
      nextData,
      comments: { post_tree: { post, children: [] }, pages: [] },
    }, null, 2));

    const run = spawnSync(process.execPath, [postArchiver, row.url, postsRoot], {
      cwd: rootDir,
      env: {
        ...process.env,
        SKOOL_PREFETCH_PATH: prefetchPath,
        SKOOL_DOWNLOAD_MEDIA: '1',
        SKOOL_FETCH_COMMENTS: '1',
        SKOOL_CDP_URL: process.env.SKOOL_CDP_URL || 'http://127.0.0.1:9222',
        MAX_ATTACHMENT_MB: '30',
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    let parsed = null;
    try {
      const match = run.stdout.match(/\{[\s\S]*\}\s*$/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {
      parsed = null;
    }
    results.push({
      slug: row.slug,
      ok: run.status === 0,
      comments: post.metadata?.comments || 0,
      attachmentsInSource: countAttachments(post),
      archiver: parsed,
      stderr: run.status === 0 ? '' : run.stderr.slice(-1200),
      ms: Date.now() - started,
    });
    console.log(`${row.slug}: ${run.status === 0 ? 'ok' : 'failed'}; attachments=${countAttachments(post)}; comments=${post.metadata?.comments || 0}`);
  } catch (err) {
    results.push({ slug: row.slug, ok: false, error: String(err.message || err), ms: Date.now() - started });
    console.log(`${row.slug}: failed ${String(err.message || err)}`);
  }
}

const outPath = path.join(prefetchDir, '_archive-new-posts-results.json');
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify({
  outPath,
  total: results.length,
  ok: results.filter(item => item.ok).length,
  failed: results.filter(item => !item.ok).length,
  attachmentsInSource: results.reduce((sum, item) => sum + (item.attachmentsInSource || 0), 0),
}, null, 2));
