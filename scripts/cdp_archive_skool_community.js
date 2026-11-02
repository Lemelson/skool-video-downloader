require('./load_env');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const collectionName = process.env.SKOOL_COLLECTION_NAME || 'Skool Community';
const defaultOutRoot = path.join(rootDir, collectionName, 'Community Posts');
const postArchiver = path.join(__dirname, 'cdp_archive_skool_post.js');

const args = process.argv.slice(2);
const groupUrl = args.find(arg => /^https?:\/\//.test(arg)) || process.env.SKOOL_COMMUNITY_URL;
if (!groupUrl) {
  console.error('Usage: node cdp_archive_skool_community.js <community-url> [outRoot] [--options]');
  console.error('  or set SKOOL_COMMUNITY_URL, e.g. https://www.skool.com/<community>');
  process.exit(2);
}
const outRootArg = args.find(arg => !arg.startsWith('--') && !/^https?:\/\//.test(arg));
const outRoot = outRootArg || defaultOutRoot;
const limit = Number((args.find(arg => arg.startsWith('--limit=')) || '').split('=')[1] || 0) || null;
const force = args.includes('--force');
const listOnly = args.includes('--list-only');
const textOnly = args.includes('--text-only') || process.env.SKOOL_TEXT_ONLY === '1';
const feedAssets = !textOnly && !args.includes('--no-feed-assets');
const maxAttachmentMb = Number((args.find(arg => arg.startsWith('--max-mb=')) || '').split('=')[1] || process.env.MAX_ATTACHMENT_MB || 30);
const concurrency = Math.max(1, Number((args.find(arg => arg.startsWith('--concurrency=')) || '').split('=')[1] || (textOnly ? 6 : 1)));

function safeName(name, fallback = 'item') {
  const cleaned = String(name || fallback)
    .replace(/[/:]/g, '-')
    .replace(/[?*"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function slugName(name) {
  return safeName(String(name || 'post').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, ''), 'post');
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function authorName(user) {
  return [user?.first_name || user?.firstName, user?.last_name || user?.lastName]
    .filter(Boolean)
    .join(' ')
    .trim() || user?.name || 'Unknown';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanContent(text) {
  return String(text || '')
    .replace(/\\([()[\]])/g, '$1')
    .replace(/\[ul\]/g, '')
    .replace(/\[li\]/g, '\n- ')
    .replace(/\[([^\]]+)\]\(obj:\/\/user\/([^)]+)\)/g, (_m, label) => label.startsWith('@') ? label : `@${label}`)
    .replace(/\[([^\]]+)\]\(obj:\/\/[^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .trim();
}

function rel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function postDirFor(post) {
  return path.join(outRoot, slugName(post.name || post.metadata?.title || post.id));
}

async function downloadSmall(context, url, dest, maxBytes) {
  if (!url) return false;
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const response = await context.request.get(url, { timeout: 120000, headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok()) return false;
  const body = await response.body();
  if (body.length > maxBytes) return false;
  fs.writeFileSync(dest, body);
  return true;
}

function optimizeImage(filePath, maxPx) {
  try {
    if (!fs.existsSync(filePath)) return;
    execFileSync('/usr/bin/sips', ['-Z', String(maxPx), filePath], { stdio: 'ignore' });
  } catch {
    // Keep the original asset if local optimization fails.
  }
}

function labelIndex(labels) {
  const out = new Map();
  const defaults = new Map([
    ['4eb96d7e11a145f6b4fe0ef4a87e77ca', 'General discussion'],
    ['e95057b131af4d42a676ca1226e3a874', 'Introduction'],
    ['d2b13f37148f4bc6aee0718ccf699b6f', 'Q&A'],
    ['d25da396c3c14c8ab4a4514b6999a442', 'Wins'],
    ['078ce2c74dc84b308608e1113c914c59', 'Announcements'],
  ]);
  for (const label of labels || []) {
    const metadata = label.metadata || {};
    out.set(label.id, metadata.name || metadata.title || metadata.label || label.name || defaults.get(label.id) || '');
  }
  for (const [id, name] of defaults) if (!out.has(id)) out.set(id, name);
  return out;
}

function firstPreviewUrl(post) {
  const metadata = post.metadata || {};
  if (metadata.imagePreviewSmall || metadata.image_preview_small) return metadata.imagePreviewSmall || metadata.image_preview_small;
  if (metadata.imagePreview || metadata.image_preview) return metadata.imagePreview || metadata.image_preview;
  const videos = parseJson(metadata.video_links_data || metadata.videoLinksData, []);
  if (Array.isArray(videos) && videos[0]?.thumbnail) return videos[0].thumbnail;
  const attachments = parseJson(metadata.attachments_data || metadata.attachmentsData, []);
  const image = Array.isArray(attachments) ? attachments.find(item => (item.metadata?.content_type || '').startsWith('image/')) : null;
  return image?.metadata?.read_url || image?.metadata?.src_read_url || '';
}

function shouldSkipExisting(post) {
  if (force) return false;
  const jsonPath = path.join(postDirFor(post), 'post.json');
  if (!fs.existsSync(jsonPath)) return false;
  try {
    const archive = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const expected = post.metadata?.comments || 0;
    const attachments = [
      ...(archive.localAttachments || []),
      ...((archive.comments || []).flatMap(comment => comment.localAttachments || [])),
    ];
    if (!textOnly && attachments.some(item => item.error || item.deferred || (!item.skipped && item.url && !item.path))) {
      return false;
    }
    if (!textOnly && archive.comments?.some(comment => comment.avatarUrl && !comment.localAvatar)) {
      return false;
    }
    return archive.id === post.id
      && Number(archive.comments?.length || 0) === Number(expected || archive.comments?.length || 0)
      && Array.isArray(archive.localAttachments)
      && Array.isArray(archive.comments);
  } catch {
    return false;
  }
}

function loadArchiveSummary(post) {
  const dir = postDirFor(post);
  const jsonPath = path.join(dir, 'post.json');
  if (!fs.existsSync(jsonPath)) return null;
  const archive = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const attachments = [
    ...(archive.localAttachments || []),
    ...((archive.comments || []).flatMap(comment => comment.localAttachments || [])),
  ];
  return {
    dir,
    href: rel(outRoot, path.join(dir, 'index.html')),
    comments: archive.comments?.length || 0,
    attachments: attachments.length,
    skipped: attachments.filter(item => item.skipped).length,
    failed: attachments.filter(item => item.error).length,
  };
}

function timestampToMs(value) {
  if (!value) return 0;
  if (typeof value === 'string' && Number.isNaN(Number(value))) return Date.parse(value) || 0;
  try {
    const big = BigInt(value);
    if (big > 1000000000000000n) return Number(big / 1000000n);
    if (big > 1000000000000n) return Number(big);
    return Number(big) * 1000;
  } catch {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    if (number > 1000000000000000) return Math.round(number / 1000000);
    if (number > 1000000000000) return number;
    return number * 1000;
  }
}

function previewIsVideo(post) {
  const metadata = post.metadata || {};
  const videos = [
    ...parseJson(metadata.video_links_data || metadata.videoLinksData, []),
  ];
  return videos.length > 0 || Boolean(metadata.videoLinks || metadata.video_links || metadata.videoIds || metadata.video_ids);
}

function contributorRows(post) {
  const contributors = parseJson(post.metadata?.contributors, []);
  if (!Array.isArray(contributors)) return [];
  const seen = new Set();
  return contributors.filter(user => {
    const key = user?.id || user?.name || authorName(user);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contributorAvatarUrl(user) {
  const metadata = user?.metadata || {};
  return metadata.picture_bubble || metadata.pictureBubble || metadata.picture_profile || metadata.pictureProfile || '';
}

function icon(name) {
  if (name === 'comment') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z"/></svg>';
  }
  if (name === 'like') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m0 11V11m0 11h10.3a2 2 0 0 0 2-1.7l1.2-7A2 2 0 0 0 18.5 11H15V6a3 3 0 0 0-3-3l-5 8"/></svg>';
  }
  if (name === 'pin') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-4 1-4 6-2-2-5 5 5-5-2-2 6-4 1-4Z"/></svg>';
  }
  return '';
}

function runPostArchiver(url, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [postArchiver, url, outRoot], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.on('error', err => resolve({ status: 1, stdout, stderr: String(err.message || err) }));
  });
}

function renderCommunityIndex({ group, posts, labels, generatedAt, processed, assetsDir }) {
  const cards = posts.map(item => {
    const post = item.post;
    const metadata = post.metadata || {};
    const label = labels.get(post.labelId || post.label_id) || '';
    const summary = item.archive || {};
    const comments = Number(metadata.comments || summary.comments || 0);
    const preview = item.localPreview ? `<div class="preview-wrap ${item.previewIsVideo ? 'is-video' : ''}">
      <img class="preview" src="${escapeHtml(item.localPreview)}" alt="">
      ${item.previewIsVideo ? '<span class="play" aria-hidden="true"></span>' : ''}
    </div>` : '';
    const pinned = item.pinned ? `<span class="pin">${icon('pin')}Pinned</span>` : '';
    const avatars = (item.localContributorAvatars || []).slice(0, 5).map(avatar => `<img class="mini-avatar" src="${escapeHtml(avatar)}" alt="">`).join('');
    const lastTs = item.lastCommentMs || Date.parse(post.updatedAt || '') || 0;
    const lastComment = comments ? `<span class="last-comment" data-ts="${lastTs}">Last comment</span>` : '';
    return `<article class="card ${item.pinned ? 'pinned' : ''}" data-id="${escapeHtml(post.id)}" data-label="${escapeHtml(label)}" data-title="${escapeHtml((metadata.title || post.name || '').toLowerCase())}" data-author="${escapeHtml(item.author.toLowerCase())}">
      <a class="card-link" href="${escapeHtml(summary.href || '#')}">
        <div class="row">
          ${item.localAvatar ? `<img class="avatar" src="${escapeHtml(item.localAvatar)}" alt="">` : '<div class="avatar fallback"></div>'}
          <div><strong>${escapeHtml(item.author)}</strong><div class="muted"><span class="relative-time" data-ts="${Date.parse(post.createdAt || '') || ''}">${escapeHtml(item.age || '')}</span>${label ? ` · ${escapeHtml(label)}` : ''}</div></div>
          ${pinned}
        </div>
        <div class="body-row">
          <div class="body-main">
            <h2><span class="unread-dot" aria-hidden="true"></span>${escapeHtml(metadata.title || post.name)}</h2>
            <p>${escapeHtml(cleanContent(metadata.content || '').slice(0, 320))}</p>
          </div>
          ${preview}
        </div>
        <footer>
          <span class="metric">${icon('like')}${metadata.upvotes || 0}</span>
          <span class="metric">${icon('comment')}${comments}</span>
          <span class="contributors">${avatars}</span>
          ${lastComment}
          ${summary.attachments ? `<span>${summary.attachments} files</span>` : ''}
          ${summary.skipped ? `<span>${summary.skipped} large skipped</span>` : ''}
        </footer>
      </a>
    </article>`;
  }).join('\n');
  const labelPills = Array.from(labels.values()).filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(group.name)} Community Archive</title>
<style>
  :root { --bg:#f7f7f4; --card:#fff; --ink:#202124; --muted:#767676; --line:#deded8; --blue:#2f6df6; --gold:#f0c15a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .top { position: sticky; top:0; z-index:5; background:#fff; border-bottom:1px solid var(--line); }
  .top-inner { max-width:1240px; margin:0 auto; height:72px; display:flex; align-items:center; gap:22px; padding:0 18px; }
  .brand { font-size:20px; font-weight:700; }
  .search { flex:1; max-width:520px; padding:14px 18px; border:0; border-radius:8px; background:#eee; font-size:16px; }
  .tabs { display:flex; gap:34px; color:var(--muted); font-weight:600; }
  .tabs span:first-child { color:var(--ink); border-bottom:3px solid var(--ink); padding-bottom:21px; }
  main { max-width:1240px; margin:0 auto; display:grid; grid-template-columns:minmax(0, 1fr) 300px; gap:32px; padding:28px 18px 70px; }
  .composer { height:72px; background:#fff; border:1px solid var(--line); border-radius:8px; box-shadow:0 1px 5px #0001; display:flex; align-items:center; padding:0 22px; color:#999; font-size:22px; font-weight:600; margin-bottom:22px; }
  .filters { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:20px; align-items:center; }
  .pill { padding:11px 18px; border:1px solid var(--line); border-radius:22px; background:#fff; color:#888; cursor:pointer; font:inherit; }
  .pill.active { background:#999; color:#fff; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; margin-bottom:14px; overflow:hidden; }
  .card.pinned { border-color:#e6c56c; }
  .card-link { display:block; color:inherit; text-decoration:none; padding:18px; }
  .row { display:flex; align-items:center; gap:10px; }
  .avatar { width:42px; height:42px; border-radius:50%; object-fit:cover; background:#ddd; }
  .pin { margin-left:auto; font-weight:700; display:inline-flex; align-items:center; gap:6px; }
  svg { width:22px; height:22px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .muted { color:var(--muted); font-size:13px; font-weight:600; }
  .body-row { display:flex; gap:18px; margin-top:14px; }
  .body-main { flex:1; min-width:0; }
  h1 { margin:0 0 6px; font-size:22px; }
  h2 { margin:0 0 8px; font-size:23px; line-height:1.18; display:flex; align-items:center; gap:10px; }
  .unread-dot { width:10px; height:10px; border-radius:50%; background:var(--blue); flex:0 0 auto; }
  .card.is-read .unread-dot { display:none; }
  p { margin:0; font-size:18px; color:#343434; }
  .preview-wrap { position:relative; width:118px; height:118px; border-radius:8px; flex:0 0 auto; overflow:hidden; background:#eee; }
  .preview { width:100%; height:100%; object-fit:cover; display:block; }
  .play { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:44px; height:32px; border-radius:8px; background:#202124e6; box-shadow:0 1px 3px #0004; }
  .play:after { content:""; position:absolute; left:17px; top:8px; border-left:13px solid #fff; border-top:8px solid transparent; border-bottom:8px solid transparent; }
  footer { display:flex; gap:14px; align-items:center; color:#777; margin-top:16px; font-weight:600; flex-wrap:wrap; }
  .metric { display:inline-flex; align-items:center; gap:6px; min-width:42px; }
  .metric svg { width:22px; height:22px; color:#8a8a8a; }
  .contributors { display:inline-flex; align-items:center; margin-left:4px; min-width:0; }
  .mini-avatar { width:28px; height:28px; border-radius:50%; object-fit:cover; border:2px solid #fff; background:#ddd; margin-left:-7px; }
  .mini-avatar:first-child { margin-left:0; }
  .last-comment { color:var(--blue); margin-left:6px; }
  .card.is-read .last-comment { color:#888; }
  .side-card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:18px; margin-bottom:18px; }
  .side-card img { max-width:100%; border-radius:6px; }
  .stats { display:grid; grid-template-columns:repeat(3,1fr); text-align:center; gap:8px; color:#777; }
  .stats strong { display:block; color:#222; font-size:22px; }
  @media (max-width: 900px) { main { grid-template-columns:1fr; } aside { display:none; } .preview { width:96px; height:96px; } }
</style>
</head>
<body>
<header class="top"><div class="top-inner"><div class="brand">${escapeHtml(group.name)}</div><input id="q" class="search" placeholder="Search archive"><nav class="tabs"><span>Community</span><span>Classroom</span><span>Calendar</span><span>Members</span></nav></div></header>
<main>
  <section>
    <div class="composer">Write something</div>
    <div class="filters"><button class="pill active" type="button" data-filter="">All</button>${labelPills.map(label => `<button class="pill" type="button" data-filter="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join('')}</div>
    <h1>${posts.length} archived posts</h1>
    ${cards}
  </section>
  <aside>
    <div class="side-card"><h2>${escapeHtml(group.name)}</h2><p>${escapeHtml(group.description || '')}</p><div class="stats"><div><strong>${group.members || ''}</strong>Members</div><div><strong>${group.online || ''}</strong>Online</div><div><strong>${group.admins || ''}</strong>Admins</div></div></div>
    <div class="side-card"><strong>Generated</strong><p>${escapeHtml(generatedAt)}</p><p>${processed.success} saved, ${processed.failed} failed, ${processed.skipped} skipped existing</p></div>
  </aside>
</main>
<script>
  const q = document.getElementById('q');
  const readKey = 'skoolArchiveReadPosts';
  const readPosts = new Set(JSON.parse(localStorage.getItem(readKey) || '[]'));
  let activeFilter = '';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  function relative(ts) {
    const ms = Number(ts);
    if (!ms) return '';
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const units = [
      ['year', 31536000000],
      ['month', 2592000000],
      ['week', 604800000],
      ['day', 86400000],
      ['hour', 3600000],
      ['minute', 60000],
    ];
    for (const [unit, size] of units) {
      if (abs >= size || unit === 'minute') return rtf.format(Math.round(diff / size), unit);
    }
    return 'now';
  }
  function compactRelative(ts) {
    const text = relative(ts);
    return text.replace(' ago', '').replace('in ', '');
  }
  function paintReadState() {
    document.querySelectorAll('.card').forEach(card => {
      card.classList.toggle('is-read', readPosts.has(card.dataset.id));
    });
  }
  function applyFilters() {
    const needle = q.value.trim().toLowerCase();
    document.querySelectorAll('.card').forEach(card => {
      const matchesSearch = !needle || card.dataset.title.includes(needle) || card.dataset.author.includes(needle);
      const matchesFilter = !activeFilter || card.dataset.label === activeFilter;
      card.style.display = matchesSearch && matchesFilter ? '' : 'none';
    });
  }
  document.querySelectorAll('.relative-time').forEach(el => { el.textContent = compactRelative(el.dataset.ts); });
  document.querySelectorAll('.last-comment').forEach(el => { el.textContent = 'New comment ' + compactRelative(el.dataset.ts); });
  document.querySelectorAll('.card-link').forEach(link => {
    link.addEventListener('click', () => {
      const card = link.closest('.card');
      readPosts.add(card.dataset.id);
      localStorage.setItem(readKey, JSON.stringify([...readPosts]));
      card.classList.add('is-read');
    });
  });
  document.querySelectorAll('.pill').forEach(button => {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.filter || '';
      document.querySelectorAll('.pill').forEach(item => item.classList.toggle('active', item === button));
      applyFilters();
    });
  });
  q.addEventListener('input', applyFilters);
  paintReadState();
</script>
</body>
</html>`;
}

(async () => {
  fs.mkdirSync(outRoot, { recursive: true });
  const browser = await chromium.connectOverCDP(process.env.SKOOL_CDP_URL || 'http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  const boot = await page.evaluate(() => {
    const data = JSON.parse(document.querySelector('#__NEXT_DATA__').textContent);
    return {
      buildId: data.buildId,
      group: data.query.group,
      pageProps: data.props.pageProps,
    };
  });

  const groupSlug = boot.group;
  const firstPage = boot.pageProps;
  const pageCount = Math.ceil(firstPage.total / 30);
  const postsById = new Map();
  const pages = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    const url = `https://www.skool.com/_next/data/${boot.buildId}/${groupSlug}.json?group=${groupSlug}${pageNum > 1 ? `&p=${pageNum}` : ''}`;
    const response = await page.evaluate(async pageUrl => {
      const r = await fetch(pageUrl, { credentials: 'include' });
      return { ok: r.ok, status: r.status, json: await r.json() };
    }, url);
    if (!response.ok) throw new Error(`Failed page ${pageNum}: ${response.status}`);
    const props = response.json.pageProps;
    pages.push({ page: pageNum, count: props.postTrees.length });
    for (const tree of props.postTrees || []) postsById.set(tree.post.id, tree);
    console.log(`page ${pageNum}/${pageCount}: ${postsById.size}/${firstPage.total}`);
  }

  const labels = labelIndex(firstPage.currentGroup?.labels || []);
  const posts = Array.from(postsById.values());
  const selected = limit ? posts.slice(0, limit) : posts;
  const feedAssetsDir = path.join(outRoot, '_community-feed-assets');
  if (feedAssets) fs.mkdirSync(feedAssetsDir, { recursive: true });
  const avatarCache = new Map();
  const saveFeedAvatar = async (user, fallbackName) => {
    const avatarUrl = contributorAvatarUrl(user) || user?.metadata?.picture_profile || user?.metadata?.pictureProfile || '';
    const key = user?.id || user?.name || fallbackName || avatarUrl;
    if (!feedAssets || !avatarUrl || !key) return '';
    if (avatarCache.has(key)) return avatarCache.get(key);
    try {
      const ext = path.extname(new URL(avatarUrl).pathname) || '.jpg';
      const dest = path.join(feedAssetsDir, 'avatars', `${safeName(key)}${ext}`);
      if (await downloadSmall(context, avatarUrl, dest, maxAttachmentMb * 1024 * 1024)) {
        optimizeImage(dest, 96);
        const local = rel(outRoot, dest);
        avatarCache.set(key, local);
        return local;
      }
    } catch {
      // Missing contributor avatars should not block the archive.
    }
    avatarCache.set(key, '');
    return '';
  };

  const items = [];
  for (const tree of posts) {
    const post = tree.post;
    const metadata = post.metadata || {};
    const avatar = post.user?.metadata?.picture_profile || post.user?.metadata?.pictureProfile || post.user?.metadata?.picture_bubble || post.user?.metadata?.pictureBubble || '';
    const preview = firstPreviewUrl(post);
    const item = {
      id: post.id,
      post,
      author: authorName(post.user),
      age: metadata.lastComment ? '' : '',
      originalUrl: `https://www.skool.com/${groupSlug}/${post.name}`,
      localAvatar: '',
      localPreview: '',
      localContributorAvatars: [],
      previewIsVideo: previewIsVideo(post),
      lastCommentMs: timestampToMs(metadata.lastComment) || Date.parse(post.updatedAt || '') || 0,
      pinned: Boolean(metadata.pinned || metadata.pin || metadata.isPinned || post.pinned),
      archive: null,
    };
    item.localAvatar = await saveFeedAvatar(post.user, item.author);
    for (const contributor of contributorRows(post).slice(0, 5)) {
      const local = await saveFeedAvatar(contributor, authorName(contributor));
      if (local && !item.localContributorAvatars.includes(local)) item.localContributorAvatars.push(local);
    }
    if (feedAssets && preview) {
      const ext = path.extname(new URL(preview).pathname).split('?')[0] || '.jpg';
      const dest = path.join(feedAssetsDir, 'previews', `${slugName(post.name || post.id)}${ext}`);
      if (await downloadSmall(context, preview, dest, maxAttachmentMb * 1024 * 1024)) {
        optimizeImage(dest, 420);
        item.localPreview = rel(outRoot, dest);
      }
    }
    items.push(item);
  }

  const status = { success: 0, failed: 0, skipped: 0, failures: [] };
  fs.writeFileSync(path.join(outRoot, 'community-feed.json'), JSON.stringify({
    groupUrl,
    total: firstPage.total,
    pages,
    posts: posts.map(tree => tree.post),
  }, null, 2));

  if (!listOnly) {
    let nextIndex = 0;
    const archiveOne = async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= selected.length) return;

      const post = selected[index].post;
      const url = `https://www.skool.com/${groupSlug}/${post.name}`;
      if (shouldSkipExisting(post)) {
        status.skipped += 1;
        console.log(`[${index + 1}/${selected.length}] skip ${post.name}`);
      } else {
        console.log(`[${index + 1}/${selected.length}] archive ${post.name}`);
        const result = await runPostArchiver(url, {
            ...process.env,
            MAX_ATTACHMENT_MB: String(maxAttachmentMb),
            SKOOL_BUILD_ID: boot.buildId,
            SKOOL_GROUP: groupSlug,
            SKOOL_DOWNLOAD_MEDIA: textOnly ? '0' : '1',
          });
        if (result.status === 0) {
          status.success += 1;
        } else {
          status.failed += 1;
          status.failures.push({ url, status: result.status, stderr: result.stderr.slice(-2000), stdout: result.stdout.slice(-2000) });
          console.error(result.stderr || result.stdout);
        }
      }
      items.find(item => item.id === post.id).archive = loadArchiveSummary(post);
      if ((index + 1) % 10 === 0) {
        fs.writeFileSync(path.join(outRoot, 'community-archive-progress.json'), JSON.stringify(status, null, 2));
      }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => archiveOne()));
  }

  for (const item of items) {
    if (!item.archive) item.archive = loadArchiveSummary(item.post);
  }

  const groupMeta = firstPage.currentGroup?.metadata || {};
  const html = renderCommunityIndex({
    group: {
      name: firstPage.currentGroup?.metadata?.displayName || firstPage.currentGroup?.name || groupSlug,
      description: groupMeta.description || '',
      members: groupMeta.totalMembers,
      online: groupMeta.totalOnlineMembers,
      admins: groupMeta.totalAdmins,
    },
    posts: items,
    labels,
    generatedAt: new Date().toISOString(),
    processed: status,
  });
  fs.writeFileSync(path.join(outRoot, 'index.html'), html);
  fs.writeFileSync(path.join(outRoot, 'community-archive-summary.json'), JSON.stringify(status, null, 2));

  console.log(JSON.stringify({
    outRoot,
    index: path.join(outRoot, 'index.html'),
    total: posts.length,
    selected: selected.length,
    textOnly,
    concurrency,
    ...status,
  }, null, 2));

  await page.close();
  await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
