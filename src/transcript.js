/**
 * Input handling: take whatever the user points us at (a Claude.ai URL, a JSON
 * export, a saved HTML page, a pasted transcript) and produce
 *   - `blobs`: text chunks to scan for recipe cards, and
 *   - `data`:  the parsed JSON tree, when the input was JSON.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeHtmlEntities } from './util.js';

const TEXT_KEYS = new Set([
  'text', 'content', 'body', 'message', 'markdown', 'value', 'answer', 'response'
]);

/** Detect the input format from an explicit hint, a filename, or the content. */
export function detectFormat(raw, { hint, filename } = {}) {
  if (hint && hint !== 'auto') return hint;
  if (filename) {
    if (/\.json$/i.test(filename)) return 'json';
    if (/\.html?$/i.test(filename)) return 'html';
    if (/\.(md|markdown)$/i.test(filename)) return 'markdown';
    if (/\.(txt|text|log)$/i.test(filename)) return 'text';
  }
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) return 'html';
  return 'text';
}

/** Is this string a Claude.ai conversation URL? */
export function isClaudeUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

/** Minimal HTML -> text conversion (no DOM dependency). */
export function htmlToText(html) {
  return decodeHtmlEntities(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|pre|tr)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
  ).replace(/\n{3,}/g, '\n\n');
}

/** Recursively pull out `<script>` payloads that contain JSON (saved pages). */
export function htmlEmbeddedJson(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const body = match[1].trim();
    if (body.length > 40 && (body.startsWith('{') || body.startsWith('['))) out.push(body);
  }
  return out;
}

function messageLabel(message, index) {
  const sender = message?.sender || message?.role || message?.author?.role || 'message';
  return `${sender} #${index + 1}`;
}

function messageText(message) {
  const parts = [];
  if (typeof message?.text === 'string') parts.push(message.text);
  const content = message?.content;
  if (typeof content === 'string') parts.push(content);
  for (const block of Array.isArray(content) ? content : []) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    // Artifacts and other tool calls carry their payload on `input`.
    if (block.input && typeof block.input === 'object') {
      for (const key of ['content', 'text', 'body', 'new_str']) {
        if (typeof block.input[key] === 'string') parts.push(block.input[key]);
      }
    }
    if (typeof block.content === 'string') parts.push(block.content);
    for (const inner of Array.isArray(block.content) ? block.content : []) {
      if (inner && typeof inner.text === 'string') parts.push(inner.text);
    }
  }
  for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
    if (typeof attachment?.extracted_content === 'string') parts.push(attachment.extracted_content);
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Find message arrays anywhere in a JSON tree. */
function findMessageArrays(node, found = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return found;
  for (const key of ['chat_messages', 'messages', 'conversation', 'turns']) {
    if (Array.isArray(node[key]) && node[key].length) found.push(node[key]);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) findMessageArrays(item, found, depth + 1);
    } else if (value && typeof value === 'object') {
      findMessageArrays(value, found, depth + 1);
    }
  }
  return found;
}

/** Collect free text from an arbitrary JSON tree as a last resort. */
function collectStrings(node, out = [], depth = 0) {
  if (depth > 10) return out;
  if (typeof node === 'string') {
    if (node.length > 24) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out, depth + 1);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (TEXT_KEYS.has(key) && value.length > 24) out.push(value);
      } else {
        collectStrings(value, out, depth + 1);
      }
    }
  }
  return out;
}

/** Turn parsed JSON into labelled text blobs. */
export function blobsFromJson(data) {
  const blobs = [];
  const messageArrays = findMessageArrays(data);
  const seen = new Set();
  for (const messages of messageArrays) {
    messages.forEach((message, index) => {
      const text = messageText(message);
      if (!text || seen.has(text)) return;
      seen.add(text);
      blobs.push({ text, label: messageLabel(message, index), index });
    });
  }
  if (!blobs.length) {
    collectStrings(data).forEach((text, index) => {
      if (seen.has(text)) return;
      seen.add(text);
      blobs.push({ text, label: `text #${index + 1}`, index });
    });
  }
  return blobs;
}

/** Tolerant JSON.parse: strips comments and trailing commas before retrying. */
export function looseJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = String(text)
      .replace(/^\uFEFF/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
      .replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(cleaned);
    } catch {
      return undefined;
    }
  }
}

/**
 * Fetch a Claude.ai conversation over HTTP.
 *
 * Conversations are private, so this only works with a session key: pass
 * `--cookie` / `sessionKey`, or set CLAUDE_SESSION_KEY. Without it Claude.ai
 * returns the app shell (or 401/403) and we surface a clear error instead.
 */
export async function fetchConversation(url, { sessionKey, fetchImpl = fetch } = {}) {
  const target = conversationApiUrl(url) || url;
  const headers = { accept: 'application/json, text/html;q=0.8', 'user-agent': 'ninja-recipe-card-exporter' };
  if (sessionKey) {
    headers.cookie = /=/.test(sessionKey) ? sessionKey : `sessionKey=${sessionKey}`;
  }

  const response = await fetchImpl(target, { headers, redirect: 'follow' });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Could not fetch ${target} (HTTP ${response.status}). ` +
      'Claude.ai conversations are private: pass --cookie "sessionKey=..." (or set ' +
      'CLAUDE_SESSION_KEY), or export the chat and point the CLI at the file instead.'
    );
  }
  const contentType = response.headers?.get?.('content-type') || '';
  const format = contentType.includes('json') || body.trimStart().startsWith('{') ? 'json' : 'html';
  if (format === 'html' && !/chat_messages|recipe/i.test(body)) {
    throw new Error(
      `Fetched ${target} but it contains no conversation data (Claude.ai returned the app shell). ` +
      'Export the conversation to JSON/Markdown and pass the file path instead.'
    );
  }
  return { raw: body, format, origin: target };
}

/** Map a claude.ai conversation URL to its JSON API endpoint when possible. */
export function conversationApiUrl(url) {
  const match = String(url).match(
    /^https?:\/\/(?:www\.)?claude\.ai\/(?:chat|chats|share)\/([0-9a-f-]{16,})/i
  );
  if (!match) return null;
  return `https://claude.ai/api/organizations/current/chat_conversations/${match[1]}?rendering_mode=raw`;
}

/** File types worth scanning when a directory is given as the source. */
export const SOURCE_EXTENSIONS = ['.json', '.md', '.markdown', '.txt', '.text', '.html', '.htm'];

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Merge several loaded sources into one scannable unit. */
export function mergeSources(loaded) {
  const blobs = [];
  const data = [];
  for (const source of loaded) {
    const label = source.origin ? path.basename(source.origin) : '';
    for (const blob of source.blobs) {
      blobs.push({ ...blob, label: label ? `${label}: ${blob.label}` : blob.label });
    }
    if (source.data !== undefined) data.push(source.data);
  }
  return {
    raw: '',
    format: 'mixed',
    data: data.length ? data : undefined,
    blobs,
    origin: loaded.map((source) => source.origin).join(', ')
  };
}

/**
 * Load every supported file in a directory (recursively) as one source.
 * Lets a folder of pasted chats be exported in a single run.
 */
export async function loadDirectory(dir, options = {}) {
  const entries = await readdir(dir, { withFileTypes: true });
  const loaded = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      loaded.push(await loadDirectory(target, options));
      continue;
    }
    if (!SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    loaded.push(await loadSource(target, options));
  }
  if (!loaded.length) return { raw: '', format: 'mixed', data: undefined, blobs: [], origin: dir };
  return { ...mergeSources(loaded), origin: dir };
}

/** Load one or many sources (files, directories, URLs, stdin) as one unit. */
export async function loadSources(sources, options = {}) {
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.length === 1) return loadSource(list[0], options);
  const loaded = [];
  for (const source of list) loaded.push(await loadSource(source, options));
  return mergeSources(loaded);
}

/**
 * Load an input source into { raw, format, data, blobs, origin }.
 * `source` is a URL, a file path, a directory, or "-" for stdin.
 */
export async function loadSource(source, options = {}) {
  if (!isClaudeUrl(source) && source !== '-' && (await isDirectory(source))) {
    return loadDirectory(source, options);
  }

  let raw;
  let origin = source;
  let format = options.format || 'auto';

  if (isClaudeUrl(source)) {
    const fetched = await fetchConversation(source, options);
    raw = fetched.raw;
    origin = fetched.origin;
    if (format === 'auto') format = fetched.format;
  } else if (source === '-') {
    raw = await readStdin();
    origin = 'stdin';
  } else {
    raw = await readFile(source, 'utf8');
  }

  format = detectFormat(raw, { hint: format === 'auto' ? null : format, filename: isClaudeUrl(source) ? null : source });

  let data;
  let blobs = [];
  if (format === 'json') {
    data = looseJsonParse(raw);
    if (data === undefined) {
      throw new Error(`Input at ${origin} looks like JSON but could not be parsed.`);
    }
    blobs = blobsFromJson(data);
    if (!blobs.length) blobs = [{ text: raw, label: 'document', index: 0 }];
  } else if (format === 'html') {
    const embedded = htmlEmbeddedJson(raw);
    const embeddedParsed = [];
    for (const payload of embedded) {
      const parsed = looseJsonParse(payload);
      if (parsed === undefined) continue;
      embeddedParsed.push(parsed);
      blobs.push(...blobsFromJson(parsed));
    }
    // Recipe blogs embed schema.org Recipe data (JSON-LD) for SEO — expose it
    // as `data` so the structured-card scan can find it directly, the same
    // path a JSON conversation export goes through.
    if (embeddedParsed.length) data = embeddedParsed;
    blobs.push({ text: htmlToText(raw), label: 'page', index: blobs.length });
  } else {
    blobs = [{ text: raw, label: 'transcript', index: 0 }];
  }

  return { raw, format, data, blobs, origin };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
