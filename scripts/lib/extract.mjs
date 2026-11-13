/*
 * Evidence page extraction for scripts/fetch-evidence.mjs.
 *
 * Everything a page says about itself (title, publisher, author, date, text) is untrusted:
 * it is cleaned, length-capped and stored as reported, never treated as verified. Text is
 * kept as plain data; nothing here executes or follows instructions found in a page.
 */
import { createHash } from 'node:crypto';

export const EXCERPT_CHARS = 1500;
const MAX_FIELD = { title: 300, site_name: 120, author: 120 };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function clean(value, max) {
  if (typeof value !== 'string') return null;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseAttributes(tag) {
  const attributes = {};
  for (const [, name, , double, single, bare] of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attributes[name.toLowerCase()] = double ?? single ?? bare ?? '';
  }
  return attributes;
}

function metaValue(metas, keys) {
  for (const key of keys) {
    const found = metas.find((meta) => (meta.property || meta.name || meta.itemprop || '').toLowerCase() === key && meta.content);
    if (found) return found.content;
  }
  return null;
}

function jsonLdObjects(html) {
  const objects = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      objects.push(value);
      if (value['@graph']) visit(value['@graph']);
    }
  };
  for (const [, body] of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(body.trim())); } catch { /* ignore malformed JSON-LD */ }
  }
  return objects;
}

function nameOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(nameOf).filter(Boolean).join(', ') || null;
  if (value && typeof value === 'object' && typeof value.name === 'string') return value.name;
  return null;
}

function isoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Title, site name, author, publication date and language, as the page reports them. */
export function extractMetadata(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  const article = jsonLdObjects(html).find((item) => item.headline || item.datePublished) || {};
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const timeTag = /<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const authorMeta = metaValue(metas, ['author', 'article:author', 'parsely-author', 'byl']);
  const lang = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,15})/i.exec(html)?.[1];
  return {
    title: clean(metaValue(metas, ['og:title', 'twitter:title']) || article.headline || titleTag, MAX_FIELD.title),
    site_name: clean(metaValue(metas, ['og:site_name', 'application-name']) || nameOf(article.publisher), MAX_FIELD.site_name),
    author: clean((authorMeta && !/^https?:\/\//i.test(authorMeta) ? authorMeta : null) || nameOf(article.author), MAX_FIELD.author),
    published_at: isoDate(metaValue(metas, ['article:published_time', 'datepublished', 'date', 'pubdate', 'publish-date', 'dc.date']) || article.datePublished || timeTag),
    language: lang ? lang.toLowerCase() : null,
  };
}

const REMOVED_BLOCKS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'figure'];

/** Readable main text: the largest <article>, else <main>, else <body>, without page chrome. */
export function extractText(html) {
  let content = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of REMOVED_BLOCKS) content = content.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  const pick = (tag) => [...content.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  content = pick('article') || pick('main') || pick('body') || content;
  content = content
    .replace(/<\/(p|div|section|h[1-6]|li|blockquote|tr|br)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(content)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** First `max` characters of the text, cut at a word boundary. */
export function excerptOf(text, max = EXCERPT_CHARS) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.8 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Canonical evidence URL: https only, no credentials, no fragment. Matches the contract and web app. */
export function canonicalUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password) return null;
  url.hash = '';
  return url.href;
}

/** Refuse hosts that are not public websites (the fetcher should never reach a private network). */
export function isPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.includes(':')) return false; // IPv6 literals
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}

/** One bundle record from a fetched page. Hashes let anyone check the bundle against the page later. */
export function buildRecord({ url, finalUrl, httpStatus, contentType, body, fetchedAt }) {
  const html = body ?? '';
  const isHtml = /html|xml/i.test(contentType || '');
  const text = isHtml ? extractText(html) : html.replace(/\s+/g, ' ').trim();
  return {
    url,
    status: 'ok',
    fetched_at: fetchedAt,
    final_url: finalUrl && finalUrl !== url ? finalUrl : null,
    http_status: httpStatus,
    content_type: contentType ? contentType.split(';')[0].trim().toLowerCase() : null,
    ...(isHtml ? extractMetadata(html) : { title: null, site_name: null, author: null, published_at: null, language: null }),
    excerpt: excerptOf(text),
    text_chars: text.length,
    text_sha256: sha256Hex(text),
    body_sha256: sha256Hex(html),
  };
}

const ACCEPTED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)/i;

/**
 * Fetch one source safely and return its bundle record. Never throws for a bad source:
 * failures become { status: 'timeout' | 'http_error' | 'unsupported_type' | 'too_large' | 'blocked' | 'network_error' }.
 */
export async function fetchSource(url, { fetchImpl = fetch, timeoutMs = 20_000, maxBytes = 3_000_000, now = () => new Date(), userAgent = 'HunchEvidenceFetcher/0.1' } = {}) {
  const fetchedAt = now().toISOString();
  const failed = (status, extra = {}) => ({ url, status, fetched_at: fetchedAt, ...extra });
  const canonical = canonicalUrl(url);
  if (!canonical || !isPublicHost(new URL(canonical).hostname)) return failed('blocked', { reason: 'not a public https URL' });
  let response;
  try {
    response = await fetchImpl(canonical, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return failed(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error');
  }
  const finalUrl = response.url || canonical;
  const finalHost = (() => { try { const u = new URL(finalUrl); return u.protocol === 'https:' ? u.hostname : null; } catch { return null; } })();
  if (!finalHost || !isPublicHost(finalHost)) return failed('blocked', { reason: 'redirected away from a public https URL' });
  if (!response.ok) return failed('http_error', { http_status: response.status });
  const contentType = response.headers.get('content-type') || '';
  if (!ACCEPTED_TYPES.test(contentType)) return failed('unsupported_type', { http_status: response.status, content_type: contentType.split(';')[0].trim() || null });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return failed('too_large', { http_status: response.status });
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return failed(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error');
  }
  if (bytes.length > maxBytes) return failed('too_large', { http_status: response.status });
  const body = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return buildRecord({ url: canonical, finalUrl, httpStatus: response.status, contentType, body, fetchedAt });
}
