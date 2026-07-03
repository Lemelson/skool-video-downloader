const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const collectionName = process.env.SKOOL_COLLECTION_NAME || 'Skool Community';
const communityUrl = (process.env.SKOOL_COMMUNITY_URL || '').replace(/\/+$/, '');
if (!communityUrl) {
  console.error('Usage: node capture_skool_feed_from_chrome_clipboard.js [pagesToCheck] [outPath]');
  console.error('  set SKOOL_COMMUNITY_URL, e.g. https://www.skool.com/<community>');
  process.exit(2);
}
const postsRoot = path.join(rootDir, collectionName, 'Community Posts');
const pagesToCheck = Number(process.argv[2] || 10);
const outPath = process.argv[3] || path.join(postsRoot, `incremental-check-${new Date().toISOString().slice(0, 10)}.json`);

function osa(script) {
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function slugName(name) {
  return String(name || 'post')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'post';
}

function captureClipboardSource(url, pageNum) {
  execFileSync('/usr/bin/pbcopy', { input: '' });
  osa(`tell application "Google Chrome"
activate
if (count windows) = 0 then make new window
tell window 1
  set URL of active tab to "${quote(`view-source:${url}`)}"
end tell
end tell`);
  execFileSync('/bin/sleep', [pageNum === 1 ? '6' : '4']);
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
  if (markerIndex === -1) {
    throw new Error(`Could not find __NEXT_DATA__ in ${url}; source length ${source.length}`);
  }
  const openEnd = source.indexOf('>', markerIndex);
  const close = source.indexOf('</script>', openEnd);
  if (openEnd === -1 || close === -1) {
    throw new Error(`Could not read __NEXT_DATA__ script in ${url}; source length ${source.length}`);
  }
  return JSON.parse(htmlUnescape(source.slice(openEnd + 1, close)));
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

function loadLocalById() {
  const feedPath = path.join(postsRoot, 'community-feed.json');
  const feed = fs.existsSync(feedPath) ? JSON.parse(fs.readFileSync(feedPath, 'utf8')) : { posts: [] };
  const byId = new Map();
  for (const post of feed.posts || []) byId.set(post.id, post);
  for (const entry of fs.readdirSync(postsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(postsRoot, entry.name, 'post.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const archive = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (!byId.has(archive.id)) {
        byId.set(archive.id, {
          id: archive.id,
          name: entry.name,
          metadata: { comments: archive.commentCount || archive.comments?.length || 0, title: archive.title || entry.name },
        });
      }
    } catch {
      // Ignore malformed archive entries during comparison.
    }
  }
  return byId;
}

(async () => {
  const localById = loadLocalById();
  const postsById = new Map();
  const reports = [];
  let buildId = '';
  let total = 0;
  const rawDir = path.join(postsRoot, `_source-capture-${new Date().toISOString().slice(0, 10)}`);
  fs.mkdirSync(rawDir, { recursive: true });

  for (let page = 1; page <= pagesToCheck; page += 1) {
    const url = `${communityUrl}${page > 1 ? `?p=${page}` : ''}`;
    let source = captureClipboardSource(url, page);
    fs.writeFileSync(path.join(rawDir, `page-${String(page).padStart(2, '0')}.html`), source);
    let nextData;
    try {
      nextData = parseNextData(source, url);
    } catch (err) {
      if (!source.includes('__NEXT_DATA__') && source.includes('AwsWafIntegration')) {
        console.log(`page ${page}: WAF/check page copied; opening normal page and retrying`);
        openNormalPage(url);
        source = captureClipboardSource(url, page);
        fs.writeFileSync(path.join(rawDir, `page-${String(page).padStart(2, '0')}.html`), source);
        nextData = parseNextData(source, url);
      } else {
        throw err;
      }
    }
    buildId = nextData.buildId || buildId;
    const pageProps = nextData.props?.pageProps || {};
    total = pageProps.total || total;
    const rows = [];

    for (const tree of pageProps.postTrees || []) {
      const post = tree.post || tree;
      if (!post?.id || postsById.has(post.id)) continue;
      postsById.set(post.id, post);
      const local = localById.get(post.id);
      const liveComments = Number(post.metadata?.comments || 0);
      const localComments = Number(local?.metadata?.comments || 0);
      if (!local || liveComments !== localComments) {
        rows.push({
          page,
          id: post.id,
          slug: post.name || slugName(post.metadata?.title || post.id),
          title: post.metadata?.title || post.name,
          liveComments,
          localComments,
          delta: liveComments - localComments,
          isNew: !local,
          url: `${communityUrl}/${post.name}`,
          post,
        });
      }
    }

    reports.push({
      page,
      posts: (pageProps.postTrees || []).length,
      uniqueSeen: postsById.size,
      newPosts: rows.filter(row => row.isNew).length,
      changedPosts: rows.length,
      newComments: rows.reduce((sum, row) => sum + Math.max(0, row.delta || 0), 0),
      rows,
    });
    console.log(`page ${page}/${pagesToCheck}: ${rows.filter(row => row.isNew).length} new, ${rows.length} changed, ${postsById.size}/${total || '?'}`);
  }

  const changed = reports.flatMap(report => report.rows);
  const result = {
    checkedAt: new Date().toISOString(),
    buildId,
    group: communityUrl.split('/').filter(Boolean).pop() || '',
    total,
    checkedPages: pagesToCheck,
    reports,
    changed,
    livePostsFirstPages: Array.from(postsById.values()),
    livePostsFirstFive: Array.from(postsById.values()),
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    outPath,
    total,
    checkedPages: pagesToCheck,
    capturedPosts: postsById.size,
    newPosts: changed.filter(row => row.isNew).length,
    changedPosts: changed.filter(row => !row.isNew).length,
    positiveCommentDelta: changed.reduce((sum, row) => sum + Math.max(0, row.delta || 0), 0),
  }, null, 2));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
