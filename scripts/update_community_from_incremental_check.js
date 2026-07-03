const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const collectionName = process.env.SKOOL_COLLECTION_NAME || 'Skool Community';
const communityUrl = (process.env.SKOOL_COMMUNITY_URL || 'https://www.skool.com/your-community').replace(/\/+$/, '');
const postsRoot = path.join(rootDir, collectionName, 'Community Posts');
const checkPath = process.argv[2] || path.join(postsRoot, 'incremental-check-2026-05-11.json');
const feedPath = path.join(postsRoot, 'community-feed.json');
const assetsRoot = path.join(postsRoot, '_community-feed-assets');

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

function avatarUrl(user) {
  const metadata = user?.metadata || {};
  return metadata.picture_bubble || metadata.pictureBubble || metadata.picture_profile || metadata.pictureProfile || '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function cleanContent(text) {
  return String(text || '')
    .replace(/\\([()[\]])/g, '$1')
    .replace(/\[ul\]/g, '')
    .replace(/\[ol(?::\d+)?\]/g, '')
    .replace(/\[li\]/g, '\n- ')
    .replace(/\[([^\]]+)\]\(obj:\/\/user\/([^)]+)\)/g, (_m, label) => label.startsWith('@') ? label : `@${label}`)
    .replace(/\[([^\]]+)\]\(obj:\/\/[^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]+\)/g, '$1')
    .trim();
}

function linkify(text) {
  const out = escapeHtml(cleanContent(text));
  return out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+)/g, (_m, prefix, url) => {
      const clean = url.replace(/[.,;:]+$/, '');
      const suffix = url.slice(clean.length);
      return `${prefix}<a href="${escapeHtml(clean)}">${escapeHtml(clean)}</a>${escapeHtml(suffix)}`;
    })
    .replace(/(^|[\s>])@([A-Za-z0-9][A-Za-z0-9 _.-]{1,40})/g, (_m, prefix, name) => `${prefix}<span class="mention">@${escapeHtml(name.trim())}</span>`)
    .replace(/\n/g, '<br>');
}

function labelName(post) {
  const defaults = new Map([
    ['4eb96d7e11a145f6b4fe0ef4a87e77ca', 'General discussion'],
    ['e95057b131af4d42a676ca1226e3a874', 'Introduction'],
    ['d2b13f37148f4bc6aee0718ccf699b6f', 'Q&A'],
    ['d25da396c3c14c8ab4a4514b6999a442', 'Wins'],
    ['078ce2c74dc84b308608e1113c914c59', 'Announcements'],
  ]);
  const labels = parseJson(post.metadata?.labels, []);
  if (Array.isArray(labels) && labels[0]?.metadata?.name) return labels[0].metadata.name;
  return defaults.get(post.labelId || post.label_id) || '';
}

function firstPreviewUrl(post) {
  const metadata = post.metadata || {};
  if (metadata.imagePreviewSmall || metadata.image_preview_small) return metadata.imagePreviewSmall || metadata.image_preview_small;
  if (metadata.imagePreview || metadata.image_preview) return metadata.imagePreview || metadata.image_preview;
  const videos = parseJson(metadata.video_links_data || metadata.videoLinksData, []);
  if (Array.isArray(videos) && videos[0]?.thumbnail) return videos[0].thumbnail;
  return '';
}

function previewIsVideo(post) {
  const metadata = post.metadata || {};
  const videos = parseJson(metadata.video_links_data || metadata.videoLinksData, []);
  return videos.length > 0 || Boolean(metadata.videoLinks || metadata.video_links || metadata.videoIds || metadata.video_ids);
}

function contributors(post) {
  const list = parseJson(post.metadata?.contributors, []);
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter(user => {
    const key = user?.id || user?.name || authorName(user);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function download(url, dest, maxBytes = 4 * 1024 * 1024) {
  if (!url) return '';
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) return '';
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) return '';
    fs.writeFileSync(dest, buf);
    return dest;
  } catch {
    return '';
  }
}

function optimizeImage(filePath, maxPx) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    execFileSync('/usr/bin/sips', ['-Z', String(maxPx), filePath], { stdio: 'ignore' });
  } catch {
    // Keep source image if sips cannot process it.
  }
}

async function saveAvatar(user, fallback) {
  const url = avatarUrl(user);
  if (!url) return '';
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  const dest = path.join(assetsRoot, 'avatars', `${safeName(user?.id || user?.name || fallback)}${ext}`);
  const saved = await download(url, dest, 2 * 1024 * 1024);
  optimizeImage(saved, 96);
  return saved ? rel(postsRoot, saved) : '';
}

async function savePreview(post) {
  const url = firstPreviewUrl(post);
  if (!url) return '';
  const ext = path.extname(new URL(url).pathname).split('?')[0] || '.jpg';
  const dest = path.join(assetsRoot, 'previews', `${slugName(post.name || post.id)}${ext}`);
  const saved = await download(url, dest, 8 * 1024 * 1024);
  optimizeImage(saved, 520);
  return saved ? rel(postsRoot, saved) : '';
}

function icon(name) {
  if (name === 'comment') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z"/></svg>';
  if (name === 'like') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m0 11V11m0 11h10.3a2 2 0 0 0 2-1.7l1.2-7A2 2 0 0 0 18.5 11H15V6a3 3 0 0 0-3-3l-5 8"/></svg>';
  if (name === 'pin') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-4 1-4 6-2-2-5 5 5-5-2-2 6-4 1-4Z"/></svg>';
  return '';
}

function renderBasicPostPage({ post, localAvatar, localPreview }) {
  const metadata = post.metadata || {};
  const title = metadata.title || post.name;
  const videos = parseJson(metadata.video_links_data || metadata.videoLinksData, []);
  const videoCards = videos.map(video => `<a class="video" href="${escapeHtml(video.url || '')}">
    <span class="video-thumb"><img src="${escapeHtml(video.thumbnail || localPreview)}" alt=""><span class="play"></span>${video.len_ms ? `<span class="duration">${Math.round(video.len_ms / 60000)}:${String(Math.round(video.len_ms / 1000) % 60).padStart(2, '0')}</span>` : ''}</span>
    <span>${escapeHtml(video.title || video.url || 'Video')}</span>
  </a>`).join('');
  const preview = !videos.length && localPreview ? `<a class="image-link" href="../${escapeHtml(localPreview)}"><img src="../${escapeHtml(localPreview)}" alt=""></a>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{--bg:#f5f5f2;--ink:#242528;--muted:#8b8b8b;--line:#deded8;--card:#fff;--link:#2f6df6}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.archive-top{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid var(--line)}.archive-top-inner{max-width:980px;margin:0 auto;height:62px;display:flex;gap:24px;align-items:center;padding:0 18px;font-weight:760}.archive-top a{color:var(--ink);text-decoration:none}.archive-top .nav-link{color:var(--muted)}main{max-width:980px;margin:0 auto;padding:28px 18px 80px}.post{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px}.post-head{display:flex;gap:12px;align-items:center;margin-bottom:18px}.avatar{width:58px;height:58px;border-radius:50%;object-fit:cover;background:#ddd}.muted{color:var(--muted);font-weight:600}h1{font-size:31px;line-height:1.12;margin:0 0 18px}.content{font-size:20px;margin-top:18px}a{color:var(--link);text-decoration:none;overflow-wrap:anywhere}.metrics{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:18px;color:#8a8a8a;font-weight:700}.metrics span{display:inline-flex;align-items:center;gap:8px;padding:10px 15px;border-right:1px solid var(--line)}.metrics span:last-child{border-right:0}svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.image-link img{width:320px;max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:18px}.video{display:grid;gap:7px;width:360px;max-width:100%;margin-top:18px}.video-thumb{position:relative;display:block;overflow:hidden;border-radius:8px;background:#111;aspect-ratio:16/9}.video img{width:100%;height:100%;object-fit:cover}.play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:56px;height:40px;border-radius:9px;background:#202124e8}.play:after{content:"";position:absolute;left:22px;top:10px;border-left:16px solid #fff;border-top:10px solid transparent;border-bottom:10px solid transparent}.duration{position:absolute;right:8px;bottom:8px;background:#202124e8;color:#fff;border-radius:6px;padding:2px 7px;font-size:14px}.notice{margin-top:20px;color:var(--muted);font-size:15px}</style></head><body>
  <header class="archive-top"><div class="archive-top-inner"><a href="../index.html">${escapeHtml(collectionName)}</a><a class="nav-link" href="../index.html">Community</a><a class="nav-link" href="../../classroom/index.html">Classroom</a></div></header>
  <main><section class="post"><div class="post-head">${localAvatar ? `<img class="avatar" src="../${escapeHtml(localAvatar)}" alt="">` : '<div class="avatar"></div>'}<div><strong>${escapeHtml(authorName(post.user))}</strong><div class="muted">${escapeHtml(post.createdAt || '')}${labelName(post) ? ` · ${escapeHtml(labelName(post))}` : ''}</div></div></div><h1>${escapeHtml(title)}</h1><div class="content">${linkify(metadata.content || '')}</div>${videoCards}${preview}<div class="metrics"><span>${icon('like')} Like</span><span>${metadata.upvotes || 0}</span><span>${icon('comment')} ${metadata.comments || 0} comments</span></div><p class="notice">This page was refreshed from the live community feed. Full comment bodies require a direct Skool comments fetch.</p></section></main></body></html>`;
  return html;
}

function renderMarkdown(post) {
  const metadata = post.metadata || {};
  return [
    `# ${metadata.title || post.name}`,
    '',
    `Original: ${communityUrl}/${post.name}`,
    `Author: ${authorName(post.user)}`,
    `Created: ${post.createdAt || ''}`,
    `Likes: ${metadata.upvotes || 0}`,
    `Comments: ${metadata.comments || 0}`,
    '',
    cleanContent(metadata.content || ''),
    '',
  ].join('\n');
}

function renderIndex(items, summary) {
  const labels = ['General discussion', 'Introduction', 'Q&A', 'Wins', 'Announcements'];
  const cards = items.map(item => {
    const { post } = item;
    const metadata = post.metadata || {};
    const slug = slugName(post.name || metadata.title || post.id);
    const label = labelName(post);
    const comments = Number(metadata.comments || 0);
    const preview = item.localPreview ? `<div class="preview-wrap ${item.previewIsVideo ? 'is-video' : ''}"><img class="preview" src="${escapeHtml(item.localPreview)}" alt="">${item.previewIsVideo ? '<span class="play" aria-hidden="true"></span>' : ''}</div>` : '';
    const avatars = item.localContributorAvatars.slice(0, 5).map(avatar => `<img class="mini-avatar" src="${escapeHtml(avatar)}" alt="">`).join('');
    const href = `${slug}/index.html`;
    return `<article class="card" data-id="${escapeHtml(post.id)}" data-label="${escapeHtml(label)}" data-title="${escapeHtml((metadata.title || post.name || '').toLowerCase())}" data-author="${escapeHtml(item.author.toLowerCase())}">
      <a class="card-link" href="${escapeHtml(href)}">
        <div class="row">${item.localAvatar ? `<img class="avatar" src="${escapeHtml(item.localAvatar)}" alt="">` : '<div class="avatar fallback"></div>'}<div><strong>${escapeHtml(item.author)}</strong><div class="muted"><span class="relative-time" data-ts="${Date.parse(post.createdAt || '') || ''}">${escapeHtml(post.createdAt || '')}</span>${label ? ` · ${escapeHtml(label)}` : ''}</div></div></div>
        <div class="body-row"><div class="body-main"><h2><span class="unread-dot" aria-hidden="true"></span>${escapeHtml(metadata.title || post.name)}</h2><p>${escapeHtml(cleanContent(metadata.content || '').slice(0, 320))}</p></div>${preview}</div>
        <footer><span class="metric">${icon('like')}${metadata.upvotes || 0}</span><span class="metric">${icon('comment')}${comments}</span><span class="contributors">${avatars}</span>${comments ? '<span class="last-comment">Last comment</span>' : ''}</footer>
      </a>
    </article>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(collectionName)} Community Archive</title><style>
  :root{--bg:#f7f7f4;--card:#fff;--ink:#202124;--muted:#767676;--line:#deded8;--blue:#2f6df6;--gold:#f0c15a}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.top{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid var(--line)}.top-inner{max-width:1240px;margin:0 auto;height:72px;display:flex;align-items:center;gap:22px;padding:0 18px}.brand{font-size:20px;font-weight:700}.search{flex:1;max-width:520px;padding:14px 18px;border:0;border-radius:8px;background:#eee;font-size:16px}.tabs{display:flex;gap:34px;color:var(--muted);font-weight:600}.tabs a,.tabs span{color:inherit;text-decoration:none}.tabs a:first-child{color:var(--ink);border-bottom:3px solid var(--ink);padding-bottom:21px}main{max-width:1240px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr)300px;gap:32px;padding:28px 18px 70px}.composer{height:72px;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 1px 5px #0001;display:flex;align-items:center;padding:0 22px;color:#999;font-size:22px;font-weight:600;margin-bottom:22px}.filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}.pill{padding:11px 18px;border:1px solid var(--line);border-radius:22px;background:#fff;color:#888;cursor:pointer;font:inherit}.pill.active{background:#999;color:#fff}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:14px;overflow:hidden}.card-link{display:block;color:inherit;text-decoration:none;padding:18px}.row{display:flex;align-items:center;gap:10px}.avatar{width:42px;height:42px;border-radius:50%;object-fit:cover;background:#ddd}.muted{color:var(--muted);font-size:13px;font-weight:600}.body-row{display:flex;gap:18px;margin-top:14px}.body-main{flex:1;min-width:0}h1{margin:0 0 12px;font-size:22px}h2{margin:0 0 8px;font-size:23px;line-height:1.18;display:flex;align-items:center;gap:10px}.unread-dot{width:10px;height:10px;border-radius:50%;background:var(--blue);flex:0 0 auto}.card.is-read .unread-dot{display:none}p{margin:0;font-size:18px;color:#343434}.preview-wrap{position:relative;width:118px;height:118px;border-radius:8px;flex:0 0 auto;overflow:hidden;background:#eee}.preview{width:100%;height:100%;object-fit:cover;display:block}.play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:44px;height:32px;border-radius:8px;background:#202124e6;box-shadow:0 1px 3px #0004}.play:after{content:"";position:absolute;left:17px;top:8px;border-left:13px solid #fff;border-top:8px solid transparent;border-bottom:8px solid transparent}footer{display:flex;gap:14px;align-items:center;color:#777;margin-top:16px;font-weight:600;flex-wrap:wrap}.metric{display:inline-flex;align-items:center;gap:6px;min-width:42px}.metric svg,svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.contributors{display:inline-flex;align-items:center;margin-left:4px}.mini-avatar{width:28px;height:28px;border-radius:50%;object-fit:cover;border:2px solid #fff;background:#ddd;margin-left:-7px}.mini-avatar:first-child{margin-left:0}.last-comment{color:var(--blue);margin-left:6px}.side-card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:18px;margin-bottom:18px}.side-card p{font-size:18px}.stats{display:grid;grid-template-columns:repeat(3,1fr);text-align:center;gap:8px;color:#777}.stats strong{display:block;color:#222;font-size:22px}@media(max-width:900px){main{grid-template-columns:1fr}aside{display:none}.preview-wrap{width:96px;height:96px}}</style></head><body>
  <header class="top"><div class="top-inner"><div class="brand">${escapeHtml(collectionName)}</div><input id="q" class="search" placeholder="Search archive"><nav class="tabs"><a href="index.html">Community</a><a href="../classroom/index.html">Classroom</a><span>Calendar</span><span>Members</span></nav></div></header>
  <main><section><div class="composer">Write something</div><div class="filters"><button class="pill active" data-filter="">All</button>${labels.map(label => `<button class="pill" data-filter="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join('')}</div><h1>${items.length} archived posts</h1>${cards}</section><aside><div class="side-card"><h2>${escapeHtml(collectionName)}</h2></div><div class="side-card"><strong>Generated</strong><p>${escapeHtml(new Date().toISOString())}</p><p>${summary.newPosts} new posts, ${summary.changedPosts} changed posts, ${summary.newComments} new live comments detected</p></div></aside></main>
  <script>const q=document.getElementById('q');let activeFilter='';const readKey='skoolArchiveReadPosts';const readPosts=new Set(JSON.parse(localStorage.getItem(readKey)||'[]'));const rtf=new Intl.RelativeTimeFormat('en',{numeric:'auto'});function rel(ts){const ms=Number(ts);if(!ms)return'';const diff=ms-Date.now(),abs=Math.abs(diff),units=[['year',31536e6],['month',2592e6],['week',6048e5],['day',864e5],['hour',36e5],['minute',6e4]];for(const[u,s]of units){if(abs>=s||u==='minute')return rtf.format(Math.round(diff/s),u).replace(' ago','').replace('in ','')}return'now'}document.querySelectorAll('.relative-time').forEach(e=>e.textContent=rel(e.dataset.ts));function paint(){document.querySelectorAll('.card').forEach(c=>c.classList.toggle('is-read',readPosts.has(c.dataset.id)))}function filter(){const n=q.value.trim().toLowerCase();document.querySelectorAll('.card').forEach(c=>{c.style.display=(!n||c.dataset.title.includes(n)||c.dataset.author.includes(n))&&(!activeFilter||c.dataset.label===activeFilter)?'':'none'})}document.querySelectorAll('.card-link').forEach(a=>a.addEventListener('click',()=>{const c=a.closest('.card');readPosts.add(c.dataset.id);localStorage.setItem(readKey,JSON.stringify([...readPosts]));c.classList.add('is-read')}));document.querySelectorAll('.pill').forEach(b=>b.addEventListener('click',()=>{activeFilter=b.dataset.filter||'';document.querySelectorAll('.pill').forEach(x=>x.classList.toggle('active',x===b));filter()}));q.addEventListener('input',filter);paint();</script></body></html>`;
}

(async () => {
  const check = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
  const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  const livePosts = check.livePostsFirstPages || check.livePostsFirstFive || [];
  const oldById = new Map(feed.posts.map(post => [post.id, post]));
  const merged = [];
  const seen = new Set();
  for (const post of livePosts) {
    merged.push(post);
    seen.add(post.id);
  }
  for (const post of feed.posts) {
    if (!seen.has(post.id)) merged.push(post);
  }
  feed.total = check.total || merged.length;
  feed.posts = merged;
  fs.writeFileSync(feedPath, JSON.stringify(feed, null, 2));

  const newRows = check.changed.filter(row => row.isNew);
  const changedRows = check.changed.filter(row => !row.isNew);
  const rowsById = new Map(check.changed.map(row => [row.id, row]));
  const items = [];

  for (const post of merged) {
    const item = {
      post,
      author: authorName(post.user),
      localAvatar: await saveAvatar(post.user, authorName(post.user)),
      localPreview: await savePreview(post),
      localContributorAvatars: [],
      previewIsVideo: previewIsVideo(post),
    };
    for (const user of contributors(post).slice(0, 5)) {
      const local = await saveAvatar(user, authorName(user));
      if (local && !item.localContributorAvatars.includes(local)) item.localContributorAvatars.push(local);
    }
    items.push(item);

    const row = rowsById.get(post.id);
    const slug = slugName(post.name || post.metadata?.title || post.id);
    const dir = path.join(postsRoot, slug);
    if (row?.isNew && !fs.existsSync(path.join(dir, 'post.json'))) {
      fs.mkdirSync(dir, { recursive: true });
      const archive = {
        url: `${communityUrl}/${post.name}`,
        id: post.id,
        title: post.metadata?.title || post.name,
        author: authorName(post.user),
        createdAt: post.createdAt || '',
        updatedAt: post.updatedAt || '',
        upvotes: post.metadata?.upvotes || 0,
        commentCount: post.metadata?.comments || 0,
        contentRaw: post.metadata?.content || '',
        content: cleanContent(post.metadata?.content || ''),
        links: [],
        comments: [],
        raw: { post },
      };
      fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify(archive, null, 2));
      fs.writeFileSync(path.join(dir, 'index.html'), renderBasicPostPage({ post, localAvatar: item.localAvatar, localPreview: item.localPreview }));
      fs.writeFileSync(path.join(dir, 'post.md'), renderMarkdown(post));
    } else if (row && fs.existsSync(path.join(dir, 'post.json'))) {
      const jsonPath = path.join(dir, 'post.json');
      const archive = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      archive.title = post.metadata?.title || archive.title;
      archive.updatedAt = post.updatedAt || archive.updatedAt;
      archive.upvotes = post.metadata?.upvotes || archive.upvotes;
      archive.commentCount = post.metadata?.comments || archive.commentCount;
      archive.raw = archive.raw || {};
      archive.raw.liveFeedPost = post;
      fs.writeFileSync(jsonPath, JSON.stringify(archive, null, 2));
    }
  }

  const summary = {
    checkedAt: check.checkedAt,
    total: check.total,
    checkedPages: check.checkedPages,
    newPosts: newRows.length,
    changedPosts: changedRows.length,
    newComments: check.reports.reduce((sum, page) => sum + (page.newComments || 0), 0),
    newPostSlugs: newRows.map(row => row.slug),
    changedSlugs: changedRows.map(row => row.slug),
  };
  const checkName = path.basename(checkPath).replace(/^incremental-check-/, '').replace(/\.json$/, '') || new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(postsRoot, `incremental-update-${checkName}-summary.json`), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(postsRoot, 'index.html'), renderIndex(items, summary));
  console.log(JSON.stringify(summary, null, 2));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
