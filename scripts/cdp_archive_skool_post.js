require('./load_env');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const rootDir = process.env.SKOOL_ARCHIVE_ROOT || process.cwd();
const collectionName = process.env.SKOOL_COLLECTION_NAME || 'Skool Community';
const defaultOutRoot = path.join(rootDir, collectionName, 'Community Posts');
const postUrl = process.argv[2] || process.env.SKOOL_POST_URL;
const outRoot = process.argv[3] || defaultOutRoot;
if (!postUrl) {
  console.error('Usage: node cdp_archive_skool_post.js <post-url> [outRoot]');
  console.error('  or set SKOOL_POST_URL, e.g. https://www.skool.com/<community>/<post-slug>');
  process.exit(2);
}
const maxAttachmentBytes = Math.max(1, Number(process.env.MAX_ATTACHMENT_MB || 30)) * 1024 * 1024;
const downloadMedia = process.env.SKOOL_DOWNLOAD_MEDIA !== '0';
const skoolBuildId = process.env.SKOOL_BUILD_ID || '';
const skoolGroup = process.env.SKOOL_GROUP || '';
const prefetchPath = process.env.SKOOL_PREFETCH_PATH || '';
const cdpUrl = process.env.SKOOL_CDP_URL || 'http://127.0.0.1:9222';
const fetchComments = process.env.SKOOL_FETCH_COMMENTS !== '0';

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

function userAvatar(user) {
  const metadata = user?.metadata || {};
  return metadata.picture_profile || metadata.pictureProfile || metadata.picture_bubble || metadata.pictureBubble || '';
}

function metadataOf(post) {
  return post?.metadata || {};
}

function pagePostTree(nextData) {
  return nextData?.props?.pageProps?.postTree || nextData?.props?.pageProps?.renderData?.postTree;
}

function metadataAttachments(metadata) {
  const value = metadata?.attachments_data || metadata?.attachmentsData || metadata?.attachments_data_v2 || metadata?.attachmentsDataV2;
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function metadataVideos(metadata) {
  const value = metadata?.video_links_data || metadata?.videoLinksData || metadata?.video_links || metadata?.videoLinks;
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function extractMarkdownLinks(text) {
  const links = [];
  const md = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = md.exec(text || ''))) links.push({ text: match[1], url: match[2] });

  const bare = /(^|[\s(])((?:https?:\/\/)[^\s)\]]+)/g;
  while ((match = bare.exec(text || ''))) {
    const url = match[2].replace(/[.,;:]+$/, '');
    if (!links.some(link => link.url === url)) links.push({ text: url, url });
  }
  return links;
}

function cleanContent(text) {
  return String(text || '')
    .replace(/\\([()[\]])/g, '$1')
    .replace(/\[ul\]/g, '')
    .replace(/\[li\]/g, '\n- ')
    .replace(/\[([^\]]+)\]\(obj:\/\/user\/([^)]+)\)/g, (_m, label) => label.startsWith('@') ? label : `@${label}`)
    .replace(/\[([^\]]+)\]\(obj:\/\/[^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]+\)/g, '$1')
    .trim();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkify(text) {
  const replacements = [];
  const source = String(text || '')
    .replace(/\[([^\]]+)\]\(obj:\/\/user\/([^)]+)\)/g, (_m, label) => {
      const token = `\u0000MENTION${replacements.length}\u0000`;
      const mention = label.startsWith('@') ? label : `@${label}`;
      replacements.push(`<span class="mention">${escapeHtml(mention)}</span>`);
      return token;
    })
    .replace(/\[([^\]]+)\]\(obj:\/\/[^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]+\)/g, '$1');
  const tokenized = cleanContent(source).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, label, url) => {
    const token = `\u0000LINK${replacements.length}\u0000`;
    replacements.push(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
    return token;
  });
  let out = escapeHtml(tokenized);
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+)/g, (_m, prefix, url) => {
    const cleanUrl = url.replace(/[.,;:]+$/, '');
    const suffix = url.slice(cleanUrl.length);
    return `${prefix}<a href="${escapeHtml(cleanUrl)}">${escapeHtml(cleanUrl)}</a>${escapeHtml(suffix)}`;
  });
  replacements.forEach((html, index) => {
    out = out.replace(`\u0000LINK${index}\u0000`, html).replace(`\u0000MENTION${index}\u0000`, html);
  });
  out = out.replace(/(^|[\s>])@([A-Za-z0-9][A-Za-z0-9 _.-]{1,40})/g, (_m, prefix, name) => `${prefix}<span class="mention">@${escapeHtml(name.trim())}</span>`);
  return out.replace(/\n/g, '<br>');
}

function flattenComments(nodes, level = 0, rows = []) {
  for (const node of nodes || []) {
    const post = node.post || {};
    const metadata = metadataOf(post);
    const attachments = metadataAttachments(metadata);
    const videos = metadataVideos(metadata);
    const content = metadata.content || '';
    rows.push({
      id: post.id,
      parentId: post.parent_id || post.parentId || '',
      level,
      author: authorName(post.user),
      userSlug: post.user?.name || '',
      userId: post.user?.id || '',
      avatarUrl: userAvatar(post.user),
      createdAt: post.created_at || post.createdAt || '',
      updatedAt: post.updated_at || post.updatedAt || '',
      upvotes: metadata.upvotes || 0,
      contentRaw: content,
      content: cleanContent(content),
      links: extractMarkdownLinks(content),
      videos: Array.isArray(videos) ? videos : [],
      attachments: Array.isArray(attachments) ? attachments : [],
      localAttachments: [],
      localAvatar: '',
    });
    flattenComments(node.children || [], level + 1, rows);
  }
  return rows;
}

async function download(context, url, dest) {
  if (!url) return false;
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

  const response = await context.request.get(url, {
    timeout: 120000,
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  if (!response.ok()) {
    throw new Error(`Download failed ${response.status()} ${url}`);
  }
  fs.writeFileSync(tmp, await response.body());
  fs.renameSync(tmp, dest);
  return true;
}

function attachmentUrl(attachment) {
  const metadata = attachment?.metadata || {};
  return metadata.read_url || metadata.src_read_url || metadata.url || '';
}

function attachmentFileName(attachment, index) {
  const metadata = attachment?.metadata || {};
  const fromName = metadata.file_name || metadata.name || '';
  if (fromName) return safeName(fromName, `attachment-${index}`);
  const type = metadata.content_type || '';
  const ext = type.includes('png') ? '.png'
    : type.includes('jpeg') || type.includes('jpg') ? '.jpg'
    : type.includes('gif') ? '.gif'
    : type.includes('pdf') ? '.pdf'
    : '';
  return `attachment-${index}${ext}`;
}

function rel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function giphyFallbackUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/media\/(?:v\d+\.[^/]+\/)?([^/]+)\//);
    if (!/giphy\.com$/.test(parsed.hostname) || !match?.[1]) return '';
    return `https://media.giphy.com/media/${match[1]}/giphy.gif`;
  } catch {
    return '';
  }
}

function optimizeAvatar(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    execFileSync('/usr/bin/sips', ['-Z', '96', filePath], { stdio: 'ignore' });
  } catch {
    // Keep the original avatar if local image optimization fails.
  }
}

async function materializeAttachment(context, archiveDir, filesDir, attachment, owner, index) {
  const metadata = attachment.metadata || {};
  const url = attachmentUrl(attachment);
  const name = attachmentFileName(attachment, index + 1);
  const bytes = metadata.src_content_length || metadata.content_length || null;
  const dest = path.join(filesDir, `${safeName((owner.createdAt || '').slice(0, 10) || 'post')} - ${safeName(owner.author || 'Unknown')} - ${name}`);
  const local = {
    id: attachment.id || '',
    name,
    url,
    contentType: metadata.content_type || metadata.src_content_type || '',
    bytes,
    path: rel(archiveDir, dest),
  };

  if (bytes && bytes > maxAttachmentBytes) {
    local.skipped = true;
    local.reason = `larger than ${Math.round(maxAttachmentBytes / 1024 / 1024)} MB`;
    return local;
  }

  if (!downloadMedia) {
    local.deferred = true;
    local.reason = 'media download disabled for fast text-first archive';
    return local;
  }

  try {
    await download(context, url, dest);
  } catch (err) {
    const fallback = giphyFallbackUrl(url);
    if (fallback && fallback !== url) {
      try {
        await download(context, fallback, dest);
        local.url = fallback;
        local.originalUrl = url;
        return local;
      } catch (fallbackErr) {
        local.error = String(fallbackErr.message || fallbackErr);
      }
    } else {
      local.error = String(err.message || err);
    }
  }
  return local;
}

async function materializeVideoThumbnails(context, archiveDir, thumbsDir, videos) {
  for (const video of videos || []) {
    if (!video.thumbnail) continue;
    if (!downloadMedia) {
      video.thumbnailDeferred = true;
      continue;
    }
    const ext = path.extname(new URL(video.thumbnail).pathname).split('?')[0] || '.jpg';
    const dest = path.join(thumbsDir, `${safeName(video.video_id || video.title || 'video')}${ext}`);
    try {
      await download(context, video.thumbnail, dest);
      video.localThumbnail = rel(archiveDir, dest);
    } catch (err) {
      video.thumbnailDownloadError = String(err.message || err);
    }
  }
}

function renderAttachments(items) {
  return (items || []).map(item => {
    if (item.deferred) {
      return `<a class="file deferred" href="${escapeHtml(item.url)}"><span>${escapeHtml(item.name)}</span><small>Queued: ${escapeHtml(item.contentType || 'file')}</small></a>`;
    }
    if (item.skipped) {
      return `<a class="file skipped" href="${escapeHtml(item.url)}"><span>${escapeHtml(item.name)}</span><small>Skipped: ${escapeHtml(item.reason || 'too large')}</small></a>`;
    }
    if ((item.contentType || '').startsWith('image/')) {
      return `<a class="image-link" href="${escapeHtml(item.path)}"><img src="${escapeHtml(item.path)}" alt="${escapeHtml(item.name)}"></a>`;
    }
    if ((item.contentType || '').startsWith('video/')) {
      return `<video class="local-video" src="${escapeHtml(item.path)}" controls preload="metadata"></video>`;
    }
    return `<a class="file" href="${escapeHtml(item.path)}"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.contentType || 'file')}</small></a>`;
  }).join('');
}

function parsePostUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  return { group: parts[0] || skoolGroup, post: parts[1] || '' };
}

async function fetchJson(context, url) {
  const response = await context.request.get(url, { timeout: 120000, headers: { 'user-agent': 'Mozilla/5.0' } });
  const text = await response.text();
  if (!response.ok()) throw new Error(`GET ${response.status()} ${url}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function collectTreeIds(nodes, seen = new Set()) {
  for (const node of nodes || []) {
    if (node?.post?.id) seen.add(node.post.id);
    collectTreeIds(node.children || [], seen);
  }
  return seen;
}

function filterNewTree(node, seen) {
  if (!node?.post?.id || seen.has(node.post.id)) return null;
  seen.add(node.post.id);
  return {
    ...node,
    children: (node.children || []).map(child => filterNewTree(child, seen)).filter(Boolean),
  };
}

async function fetchAllComments(context, post) {
  const groupId = post.groupId || post.group_id;
  const root = { post, children: [] };
  const seen = new Set();
  const pages = [];
  let cursor = '';

  for (let pageIndex = 0; pageIndex < 200; pageIndex += 1) {
    const url = `https://api2.skool.com/posts/${post.id}/comments?group-id=${groupId}&limit=25&pinned=true${cursor ? `&created-gt=${cursor}` : ''}`;
    const page = await fetchJson(context, url);
    const children = [
      ...(page.pinned_post_tree?.children || []),
      ...(page.post_tree?.children || []),
    ];
    let added = 0;
    for (const child of children) {
      const filtered = filterNewTree(child, seen);
      if (filtered) {
        root.children.push(filtered);
        added += collectTreeIds([filtered]).size;
      }
    }
    pages.push({ cursor: cursor || null, last: page.last || 0, roots: children.length, added });
    if (!page.last || String(page.last) === String(cursor) || added === 0) break;
    cursor = page.last;
  }

  return { post_tree: root, pages };
}

async function fetchPostData(context, page) {
  if (prefetchPath) {
    const prefetched = JSON.parse(fs.readFileSync(prefetchPath, 'utf8'));
    const nextData = prefetched.nextData;
    const postTree = pagePostTree(nextData) || prefetched.comments?.post_tree || prefetched.comments?.postTree;
    const post = postTree?.post;
    if (!post?.id) throw new Error(`Prefetch is missing post data: ${prefetchPath}`);

    const existingComments = prefetched.comments || { post_tree: { post, children: [] }, pages: [] };
    const existingChildren = existingComments.post_tree?.children || existingComments.postTree?.children || [];
    const expected = Number(post.metadata?.comments || 0);
    if (fetchComments && expected > existingChildren.length) {
      return { nextData, comments: await fetchAllComments(context, post) };
    }
    return { nextData, comments: existingComments };
  }

  if (skoolBuildId && skoolGroup) {
    const { group, post } = parsePostUrl(postUrl);
    const groupSlug = skoolGroup || group;
    const detailUrl = `https://www.skool.com/_next/data/${skoolBuildId}/${groupSlug}/${post}.json?group=${groupSlug}&post=${post}`;
    const nextJson = await fetchJson(context, detailUrl);
    const nextData = { props: { pageProps: nextJson.pageProps } };
    const postTree = pagePostTree(nextData);
    const comments = await fetchAllComments(context, postTree.post);
    return { nextData, comments };
  }

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  const nextData = await page.evaluate(() => JSON.parse(document.querySelector('#__NEXT_DATA__').textContent));
  const postTree = pagePostTree(nextData);
  const comments = await fetchAllComments(context, postTree.post);
  return { nextData, comments };
}

function renderVideos(videos) {
  return (videos || []).map(video => {
    const thumb = video.localThumbnail || video.thumbnail || '';
    const duration = video.len_ms || video.lenMs || video.duration || 0;
    return `<a class="video" href="${escapeHtml(video.url || '')}">
      ${thumb ? `<span class="video-thumb"><img src="${escapeHtml(thumb)}" alt=""><span class="play" aria-hidden="true"></span>${duration ? `<span class="duration">${escapeHtml(formatDuration(duration))}</span>` : ''}</span>` : ''}
      <span class="video-title">${escapeHtml(video.title || video.url || 'Video')}</span>
    </a>`;
  }).join('');
}

function renderHtml(archive) {
  const postAttachments = renderAttachments(archive.localAttachments);
  const postVideos = renderVideos(archive.videos);
  const likeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m0 11V11m0 11h10.3a2 2 0 0 0 2-1.7l1.2-7A2 2 0 0 0 18.5 11H15V6a3 3 0 0 0-3-3l-5 8"/></svg>';
  const commentIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z"/></svg>';
  const renderComment = (comment, options = {}) => {
    const avatar = comment.localAvatar
      ? `<img class="avatar" src="${escapeHtml(comment.localAvatar)}" alt="">`
      : '<div class="avatar fallback"></div>';
    const attachments = renderAttachments(comment.localAttachments);
    const videos = renderVideos(comment.videos);
    const long = cleanContent(comment.contentRaw).length > 520;
    return `<article class="comment level-${comment.level}${options.hidden ? ' hidden-reply' : ''}" ${options.thread ? `data-thread="${escapeHtml(options.thread)}"` : ''} id="${escapeHtml(comment.id)}">
      <div class="rail">${avatar}</div>
      <div class="bubble">
        <header><strong>${escapeHtml(comment.author)}</strong><span class="dot">·</span><span class="relative-time" data-ts="${Date.parse(comment.createdAt || '') || ''}">${escapeHtml(comment.createdAt)}</span><button class="dots" type="button" aria-label="More">•••</button></header>
        <div class="body${long ? ' collapsed' : ''}">${linkify(comment.contentRaw)}</div>
        ${long ? '<button class="see-more" type="button">See more</button>' : ''}
        ${videos ? `<div class="videos">${videos}</div>` : ''}
        ${attachments ? `<div class="attachments">${attachments}</div>` : ''}
        <div class="comment-actions"><span>${likeIcon}</span><span>${comment.upvotes || 0}</span><button type="button">Reply</button></div>
      </div>
    </article>`;
  };

  const threads = [];
  let current = null;
  for (const comment of archive.comments) {
    if (comment.level === 0 || !current) {
      current = { root: comment, replies: [] };
      threads.push(current);
    } else {
      current.replies.push(comment);
    }
  }
  const comments = threads.map(thread => {
    const visibleReplies = 2;
    const hiddenCount = Math.max(0, thread.replies.length - visibleReplies);
    const rows = [renderComment(thread.root, { thread: thread.root.id })];
    thread.replies.forEach((reply, index) => rows.push(renderComment(reply, {
      thread: thread.root.id,
      hidden: index >= visibleReplies,
    })));
    if (hiddenCount) {
      rows.push(`<button class="view-replies" type="button" data-thread="${escapeHtml(thread.root.id)}">↳ View ${hiddenCount} more ${hiddenCount === 1 ? 'reply' : 'replies'}</button>`);
    }
    return `<section class="thread">${rows.join('\n')}</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(archive.title)}</title>
<style>
  :root { color-scheme: light; --bg: #f5f5f2; --ink: #242528; --muted: #8b8b8b; --line: #deded8; --card: #fff; --link: #2f6df6; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 18px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 18px 80px; }
  .post, .bubble { background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .post { padding: 24px; margin-bottom: 24px; }
  .post-head { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
  h1 { font-size: 31px; line-height: 1.12; margin: 0 0 18px; letter-spacing:0; }
  .meta, header { color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; align-items:center; }
  .meta { font-weight: 600; }
  a { color: var(--link); text-decoration: none; overflow-wrap: anywhere; }
  .content { margin-top: 18px; font-size: 20px; }
  .post-actions { display:inline-flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; margin-top:18px; color:#8a8a8a; font-weight:700; }
  .post-actions span { display:inline-flex; align-items:center; gap:8px; padding:10px 15px; border-right:1px solid var(--line); }
  .post-actions span:last-child { border-right:0; }
  svg { width:23px; height:23px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .thread { margin: 10px 0 18px; }
  .comment { display: grid; grid-template-columns: 42px 1fr; gap: 10px; margin: 10px 0; }
  .comment.level-1 { margin-left: 46px; }
  .comment.level-2 { margin-left: 86px; }
  .hidden-reply { display:none; }
  .avatar { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; border: 1px solid var(--line); background: #d8d8d8; }
  .post-head .avatar { width:58px; height:58px; }
  .bubble { padding: 15px 17px; }
  header strong { color: var(--ink); }
  .dots { margin-left:auto; border:0; background:transparent; color:#999; font:inherit; font-weight:800; padding:0 4px; }
  .body { margin-top: 8px; white-space: normal; overflow-wrap:anywhere; }
  .body.collapsed { max-height: 122px; overflow:hidden; }
  .mention, .see-more, .view-replies { color: var(--link); }
  .see-more, .view-replies { border:0; background:transparent; font:inherit; font-weight:700; padding:0; cursor:pointer; }
  .view-replies { margin:6px 0 8px 88px; }
  .attachments, .videos { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
  .image-link img { width: 260px; max-height: 220px; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); }
  .local-video { width: 260px; max-width: 100%; border-radius: 6px; border: 1px solid var(--line); background: #111; }
  .file, .video { display: grid; gap: 7px; width: 280px; min-height: 86px; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fafafa; color: var(--ink); }
  .file.skipped { border-color: #d9b56b; background: #fff8e8; }
  .file.deferred { border-color: #b8c7ef; background: #f5f8ff; }
  .file small { color: var(--muted); }
  .video-thumb { position:relative; display:block; overflow:hidden; border-radius:6px; background:#111; aspect-ratio:16/9; }
  .video img { width: 100%; height:100%; display:block; object-fit:cover; }
  .play { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:56px; height:40px; border-radius:9px; background:#202124e8; box-shadow:0 1px 3px #0005; }
  .play:after { content:""; position:absolute; left:22px; top:10px; border-left:16px solid #fff; border-top:10px solid transparent; border-bottom:10px solid transparent; }
  .duration { position:absolute; right:8px; bottom:8px; background:#202124e8; color:#fff; border-radius:6px; padding:2px 7px; font-size:14px; }
  .video-title { font-size:14px; line-height:1.25; font-weight:600; }
  .comment-actions { display:flex; align-items:center; gap:10px; margin-top:12px; color:#8a8a8a; font-weight:700; }
  .comment-actions svg { width:22px; height:22px; }
  .comment-actions button { border:0; background:transparent; color:#8a8a8a; font:inherit; font-weight:700; padding:0 0 0 10px; }
  @media (max-width: 700px) {
    main { padding:16px 10px 60px; }
    .comment.level-1, .comment.level-2 { margin-left:18px; }
    .file, .video { width: min(100%, 320px); }
  }
</style>
</head>
<body>
<main>
  <section class="post">
    <div class="post-head">
      ${archive.localAvatar ? `<img class="avatar" src="${escapeHtml(archive.localAvatar)}" alt="">` : '<div class="avatar fallback"></div>'}
      <div><strong>${escapeHtml(archive.author)}</strong><div class="meta"><span class="relative-time" data-ts="${Date.parse(archive.createdAt || '') || ''}">${escapeHtml(archive.createdAt)}</span></div></div>
    </div>
    <h1>${escapeHtml(archive.title)}</h1>
    <div class="meta"><span>${archive.upvotes} likes</span><span>${archive.commentCount} comments</span><a href="${escapeHtml(archive.url)}">Original Skool post</a></div>
    <div class="content">${linkify(archive.contentRaw)}</div>
    ${postVideos ? `<div class="videos">${postVideos}</div>` : ''}
    ${postAttachments ? `<div class="attachments">${postAttachments}</div>` : ''}
    <div class="post-actions"><span>${likeIcon} Like</span><span>${archive.upvotes}</span><span>${commentIcon} ${archive.commentCount} comments</span></div>
  </section>
  ${comments}
</main>
<script>
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  function compactRelative(ts) {
    const ms = Number(ts);
    if (!ms) return '';
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const units = [['year',31536000000],['month',2592000000],['week',604800000],['day',86400000],['hour',3600000],['minute',60000]];
    for (const [unit, size] of units) {
      if (abs >= size || unit === 'minute') return rtf.format(Math.round(diff / size), unit).replace(' ago','').replace('in ','');
    }
    return 'now';
  }
  document.querySelectorAll('.relative-time').forEach(el => { el.textContent = compactRelative(el.dataset.ts); });
  document.querySelectorAll('.see-more').forEach(button => {
    button.addEventListener('click', () => {
      button.previousElementSibling.classList.remove('collapsed');
      button.remove();
    });
  });
  document.querySelectorAll('.view-replies').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.hidden-reply[data-thread="' + CSS.escape(button.dataset.thread) + '"]').forEach(row => row.classList.remove('hidden-reply'));
      button.remove();
    });
  });
</script>
</body>
</html>`;
}

function renderMarkdown(archive) {
  const lines = [
    `# ${archive.title}`,
    '',
    `Original: ${archive.url}`,
    `Author: ${archive.author}`,
    `Created: ${archive.createdAt}`,
    `Likes: ${archive.upvotes}`,
    `Comments: ${archive.commentCount}`,
    '',
    archive.content,
    '',
    '## Comments',
    '',
  ];

  for (const comment of archive.comments) {
    const prefix = comment.level ? '  '.repeat(comment.level) : '';
    lines.push(`${prefix}- ${comment.author} | ${comment.createdAt} | ${comment.upvotes} likes`);
    if (comment.content) lines.push(`${prefix}  ${comment.content.replace(/\n/g, `\n${prefix}  `)}`);
    for (const link of comment.links) lines.push(`${prefix}  Link: ${link.url}`);
    for (const video of comment.videos || []) lines.push(`${prefix}  Video: ${video.title || ''} ${video.url || ''}`.trim());
    for (const attachment of comment.localAttachments) lines.push(`${prefix}  File: ${attachment.path}`);
    lines.push('');
  }
  if (archive.localAttachments?.length) {
    lines.push('## Post Attachments', '');
    for (const attachment of archive.localAttachments) {
      lines.push(`- ${attachment.skipped ? 'Skipped' : 'File'}: ${attachment.path || attachment.url} ${attachment.reason || ''}`.trim());
    }
    lines.push('');
  }
  return lines.join('\n');
}

(async () => {
  let browser = null;
  let page = null;
  let context = prefetchPath
    ? {
        request: {
          async get(url, options = {}) {
            const response = await fetch(url, {
              headers: options.headers || { 'user-agent': 'Mozilla/5.0' },
            });
            const buffer = Buffer.from(await response.arrayBuffer());
            return {
              ok: () => response.ok,
              status: () => response.status,
              body: async () => buffer,
              text: async () => buffer.toString('utf8'),
            };
          },
        },
      }
    : null;

  if (!prefetchPath) {
    browser = await chromium.connectOverCDP(cdpUrl);
    context = browser.contexts()[0];
    page = await context.newPage();
  } else if (fetchComments) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      context = browser.contexts()[0];
      page = await context.newPage();
    } catch (err) {
      throw new Error(`Cannot fetch Skool comments for ${prefetchPath}: start a logged-in browser with remote debugging at ${cdpUrl} or set SKOOL_FETCH_COMMENTS=0. ${err.message || err}`);
    }
  }

  const data = await fetchPostData(context, page);

  const post = pagePostTree(data.nextData).post;
  const postMetadata = metadataOf(post);
  const commentsRoot = data.comments.post_tree?.children || [];
  const comments = flattenComments(commentsRoot);
  const archiveDir = path.join(outRoot, slugName(post.name || postMetadata.title || post.id));
  const filesDir = path.join(archiveDir, 'files');
  const thumbsDir = path.join(archiveDir, 'video-thumbnails');
  const avatarsDir = path.join(archiveDir, 'avatars');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  fs.mkdirSync(avatarsDir, { recursive: true });

  const postAttachments = metadataAttachments(postMetadata);
  const postVideos = metadataVideos(postMetadata);
  const localPostAttachments = [];
  let localPostAvatar = '';
  const postAvatarUrl = userAvatar(post.user);
  if (postAvatarUrl && downloadMedia) {
    const ext = path.extname(new URL(postAvatarUrl).pathname) || '.jpg';
    const dest = path.join(avatarsDir, `${safeName(post.user?.id || post.user?.name || authorName(post.user))}${ext}`);
    try {
      await download(context, postAvatarUrl, dest);
      optimizeAvatar(dest);
      localPostAvatar = rel(archiveDir, dest);
    } catch {
      localPostAvatar = '';
    }
  }
  for (let i = 0; i < postAttachments.length; i += 1) {
    localPostAttachments.push(await materializeAttachment(context, archiveDir, filesDir, postAttachments[i], {
      author: authorName(post.user),
      createdAt: post.created_at || post.createdAt || '',
    }, i));
  }
  await materializeVideoThumbnails(context, archiveDir, thumbsDir, Array.isArray(postVideos) ? postVideos : []);

  for (const comment of comments) {
    if (comment.avatarUrl && downloadMedia) {
      const ext = path.extname(new URL(comment.avatarUrl).pathname) || '.jpg';
      const dest = path.join(avatarsDir, `${safeName(comment.userId || comment.userSlug || comment.author)}${ext}`);
      try {
        await download(context, comment.avatarUrl, dest);
        optimizeAvatar(dest);
        comment.localAvatar = rel(archiveDir, dest);
      } catch (err) {
        comment.avatarDownloadError = String(err.message || err);
      }
    }

    for (let i = 0; i < comment.attachments.length; i += 1) {
      const attachment = comment.attachments[i];
      comment.localAttachments.push(await materializeAttachment(context, archiveDir, filesDir, attachment, comment, i));
    }

    await materializeVideoThumbnails(context, archiveDir, thumbsDir, comment.videos || []);
  }

  const archive = {
    url: postUrl,
    id: post.id,
    title: postMetadata.title || post.name,
    author: authorName(post.user),
    avatarUrl: postAvatarUrl,
    localAvatar: localPostAvatar,
    createdAt: post.created_at || post.createdAt || '',
    updatedAt: post.updated_at || post.updatedAt || '',
    upvotes: postMetadata.upvotes || 0,
    commentCount: postMetadata.comments || comments.length,
    contentRaw: postMetadata.content || '',
    content: cleanContent(postMetadata.content || ''),
    links: extractMarkdownLinks(postMetadata.content || ''),
    attachments: Array.isArray(postAttachments) ? postAttachments : [],
    localAttachments: localPostAttachments,
    videos: Array.isArray(postVideos) ? postVideos : [],
    comments,
    raw: {
      postTree: data.nextData.props.pageProps.postTree,
      comments: data.comments,
    },
  };

  fs.writeFileSync(path.join(archiveDir, 'post.json'), JSON.stringify(archive, null, 2));
  fs.writeFileSync(path.join(archiveDir, 'index.html'), renderHtml(archive));
  fs.writeFileSync(path.join(archiveDir, 'post.md'), renderMarkdown(archive));

  const attachmentCount = localPostAttachments.length + comments.reduce((sum, comment) => sum + comment.localAttachments.length, 0);
  const failed = [...localPostAttachments, ...comments.flatMap(comment => comment.localAttachments)].filter(item => item.error);
  const skipped = [...localPostAttachments, ...comments.flatMap(comment => comment.localAttachments)].filter(item => item.skipped);
  console.log(JSON.stringify({
    archiveDir,
    comments: comments.length,
    attachments: attachmentCount,
    failedAttachments: failed.length,
    skippedLargeAttachments: skipped.length,
    html: path.join(archiveDir, 'index.html'),
    json: path.join(archiveDir, 'post.json'),
    markdown: path.join(archiveDir, 'post.md'),
  }, null, 2));

  if (page) await page.close();
  if (browser) await browser.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
