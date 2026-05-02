#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_COOKIE_FILE = path.join('.secrets', 'weread-cookies.json');
const ROOT_URL = 'https://weread.qq.com';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookieFile = args.cookieFile || process.env.WEREAD_COOKIE_FILE || DEFAULT_COOKIE_FILE;
  const cookiePayload = loadCookiePayload(cookieFile, process.env.WEREAD_COOKIE_JSON);
  const sourceUrl = args.url || cookiePayload.sourceUrl;

  if (!sourceUrl) {
    throw new Error('缺少 reader URL。请传入 --url，或在 Cookie JSON 中保留 sourceUrl。');
  }

  const cookieHeader = buildCookieHeader(cookiePayload.cookies || []);
  if (!cookieHeader) {
    throw new Error('缺少 Cookie。请检查 Cookie JSON 中的 cookies 数组。');
  }

  logStep('config', {
    sourceUrl,
    cookieSource: args.cookieFile ? 'arg-file' : process.env.WEREAD_COOKIE_FILE ? 'env-file' : 'default-file',
    cookieCount: cookiePayload.cookies?.length || 0
  });

  const reader = await fetchAndParseState(sourceUrl, cookieHeader);
  logStep('reader-page', summarizeState(reader.state, reader.html, sourceUrl));

  const bookId = findFirstString([
    reader.state?.bookId,
    reader.state?.reader?.bookId,
    reader.state?.reader?.bookInfo?.bookId,
    reader.state?.bookInfo?.bookId
  ]);

  let chapterInfos = findChapterInfos(reader.state);
  let bookDetail = null;

  if (bookId && chapterInfos.length === 0) {
    const detailUrl = `${ROOT_URL}/web/bookDetail/${encodeURIComponent(bookId)}`;
    bookDetail = await fetchAndParseState(detailUrl, cookieHeader);
    chapterInfos = findChapterInfos(bookDetail.state);
    logStep('book-detail-page', summarizeState(bookDetail.state, bookDetail.html, detailUrl));
  }

  logStep('chapter-infos', summarizeChapterInfos(chapterInfos));

  const selected = selectChapter(chapterInfos, {
    chapterUid: args.chapterUid,
    chapterTitle: args.chapterTitle
  });

  logStep('chapter-selection', selected);

  if (bookId && selected.chapterUid) {
    await probeChapterContent(bookId, selected.chapterUid, cookieHeader);
  } else {
    logStep('chapter-content-skip', {
      reason: !bookId ? 'missing-book-id' : 'missing-chapter-uid',
      hint: '如果 chapterInfos 已输出，请用 --chapter-uid 指定一个目录中的章节 UID 再运行。'
    });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name.startsWith('--')) continue;
    if (value == null || value.startsWith('--')) {
      args[toCamel(name.slice(2))] = true;
      continue;
    }
    args[toCamel(name.slice(2))] = value;
    i += 1;
  }
  return args;
}

function toCamel(name) {
  return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function loadCookiePayload(cookieFile, cookieJson) {
  if (cookieJson) return JSON.parse(cookieJson);

  if (!fs.existsSync(cookieFile)) {
    throw new Error(`找不到 Cookie 文件: ${cookieFile}`);
  }

  return JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
}

function buildCookieHeader(cookies) {
  return cookies
    .filter((cookie) => cookie && cookie.name && typeof cookie.value === 'string')
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function fetchAndParseState(url, cookieHeader) {
  const response = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      Referer: ROOT_URL,
      'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome Safari'
    }
  });
  const html = await response.text();
  const state = extractInitialState(html);

  return {
    url,
    status: response.status,
    ok: response.ok,
    html,
    state
  };
}

function extractInitialState(html) {
  const marker = 'window.__INITIAL_STATE__';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;

  const equalsIndex = html.indexOf('=', markerIndex);
  const startIndex = html.indexOf('{', equalsIndex);
  if (equalsIndex < 0 || startIndex < 0) return null;

  const endIndex = findMatchingBrace(html, startIndex);
  if (endIndex < 0) return null;

  return JSON.parse(html.slice(startIndex, endIndex + 1));
}

function findMatchingBrace(text, startIndex) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return i;
  }

  return -1;
}

function summarizeState(state, html, url) {
  const chapterInfos = findChapterInfos(state);
  const currentChapter = state?.currentChapter || state?.reader?.currentChapter || {};

  return {
    url,
    hasInitialState: Boolean(state),
    htmlLength: html.length,
    topLevelKeys: Object.keys(state || {}).slice(0, 20),
    bookIdCandidates: compact([
      state?.bookId,
      state?.reader?.bookId,
      state?.reader?.bookInfo?.bookId,
      state?.bookInfo?.bookId
    ]),
    currentChapter: summarizeChapter(currentChapter),
    readerChapterUid: state?.reader?.chapterUid || '',
    chapterInfosCount: chapterInfos.length
  };
}

function findChapterInfos(state) {
  const candidates = [
    state?.chapterInfos,
    state?.reader?.chapterInfos,
    state?.bookInfo?.chapterInfos,
    state?.reader?.bookInfo?.chapterInfos
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }

  return [];
}

function summarizeChapterInfos(chapterInfos) {
  return {
    count: chapterInfos.length,
    firstItems: chapterInfos.slice(0, 12).map(summarizeChapter),
    hasWordCount: chapterInfos.some((chapter) => chapter.wordCount != null),
    hasAnchors: chapterInfos.some((chapter) => Array.isArray(chapter.anchors) && chapter.anchors.length > 0)
  };
}

function summarizeChapter(chapter) {
  return {
    title: chapter?.title || '',
    chapterUid: chapter?.chapterUid || chapter?.id || '',
    chapterIdx: chapter?.chapterIdx ?? chapter?.index ?? null,
    level: chapter?.level ?? null,
    wordCount: chapter?.wordCount ?? chapter?.words ?? null,
    anchors: Array.isArray(chapter?.anchors) ? chapter.anchors.length : 0
  };
}

function selectChapter(chapterInfos, options) {
  if (options.chapterUid) {
    const matched = chapterInfos.find((chapter) => String(chapter.chapterUid || chapter.id || '') === String(options.chapterUid));
    return {
      strategy: 'chapter-uid',
      found: Boolean(matched),
      chapterUid: options.chapterUid,
      chapter: matched ? summarizeChapter(matched) : null
    };
  }

  if (options.chapterTitle) {
    const normalizedTitle = normalizeTitle(options.chapterTitle);
    const matched = chapterInfos.filter((chapter) => normalizeTitle(chapter.title) === normalizedTitle);
    return {
      strategy: 'chapter-title',
      found: matched.length === 1,
      matchCount: matched.length,
      chapterUid: matched.length === 1 ? matched[0].chapterUid : '',
      chapter: matched.length === 1 ? summarizeChapter(matched[0]) : null
    };
  }

  return {
    strategy: 'none',
    found: false,
    chapterUid: '',
    hint: '传入 --chapter-uid 或 --chapter-title 可以继续探测 chapterContent。'
  };
}

async function probeChapterContent(bookId, chapterUid, cookieHeader) {
  const urls = [
    `${ROOT_URL}/web/book/chapterContent?bookId=${encodeURIComponent(bookId)}&chapterUid=${encodeURIComponent(chapterUid)}&base64=1`,
    `${ROOT_URL}/web/book/chapterContent?bookId=${encodeURIComponent(bookId)}&chapterUid=${encodeURIComponent(chapterUid)}`,
    `https://i.weread.qq.com/book/chapterContent?bookId=${encodeURIComponent(bookId)}&chapterUid=${encodeURIComponent(chapterUid)}`
  ];

  for (const url of urls) {
    const response = await fetch(url, {
      headers: {
        Cookie: cookieHeader,
        Referer: ROOT_URL,
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome Safari'
      }
    });
    const text = await response.text();
    const parsed = parseJsonMaybe(text);

    logStep('chapter-content-probe', {
      url: redactQuery(url),
      status: response.status,
      ok: response.ok,
      bodyLength: text.length,
      contentType: response.headers.get('content-type') || '',
      jsonKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : [],
      candidateSummary: summarizeContentCandidates(parsed || text)
    });
  }
}

function summarizeContentCandidates(value) {
  const candidates = [];
  collectContentCandidates(value, 'root', candidates, 0, new WeakSet());
  return candidates
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);
}

function collectContentCandidates(value, pathName, candidates, depth, seen) {
  if (value == null || depth > 8) return;

  if (typeof value === 'string') {
    const looksContentLike = /content|html|text|body|chapter/i.test(pathName);
    if (looksContentLike || value.length > 80) {
      candidates.push({
        path: pathName,
        type: 'string',
        length: value.length,
        looksHtml: /<\/?[a-z][\s\S]*>/i.test(value),
        looksBase64: looksLikeBase64(value)
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    candidates.push({
      path: pathName,
      type: 'array',
      length: value.length
    });
    value.slice(0, 20).forEach((item, index) => {
      collectContentCandidates(item, `${pathName}[${index}]`, candidates, depth + 1, seen);
    });
    return;
  }

  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  Object.keys(value).forEach((key) => {
    collectContentCandidates(value[key], `${pathName}.${key}`, candidates, depth + 1, seen);
  });
}

function looksLikeBase64(text) {
  const normalized = String(text || '').trim();
  if (normalized.length < 80 || normalized.length % 4 === 1) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(normalized)) return false;
  return !/[<>{}\u4e00-\u9fff]/.test(normalized);
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim();
}

function findFirstString(values) {
  return compact(values)[0] || '';
}

function compact(values) {
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function redactQuery(url) {
  const parsed = new URL(url);
  if (parsed.searchParams.has('bookId')) parsed.searchParams.set('bookId', '<bookId>');
  if (parsed.searchParams.has('chapterUid')) parsed.searchParams.set('chapterUid', '<chapterUid>');
  return parsed.toString();
}

function logStep(event, data) {
  console.log('[verify]:' + JSON.stringify({ event, ...data }));
}

main().catch((error) => {
  console.error('[verify-error]:' + JSON.stringify({
    message: error.message,
    stack: error.stack ? error.stack.split('\n').slice(0, 3) : []
  }));
  process.exit(1);
});
