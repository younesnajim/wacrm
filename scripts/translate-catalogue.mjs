#!/usr/bin/env node
/**
 * Translate messages/en.json into another locale, preserving structure.
 *
 *   OPENAI_API_KEY=sk-... node scripts/translate-catalogue.mjs ar
 *
 * Notes on why this is a script and not a one-shot paste:
 *  - en.json holds ~1,468 leaf strings. Batching keeps each request small
 *    enough that the model doesn't drift or truncate mid-object.
 *  - Progress is cached to messages/.<locale>.cache.json after every batch,
 *    so a rate limit or a dropped connection costs one batch, not the run.
 *  - Placeholders must survive verbatim. ICU args ({count}, {name}),
 *    WhatsApp template vars ({{1}}), and inline HTML/rich tags (<b>, <link>)
 *    are load-bearing: src/i18n/icu-safety.test.ts fails the build if a
 *    string stops parsing, and a mangled {{1}} silently breaks broadcasts.
 *
 * After it finishes, add the locale to TRANSLATED_LOCALES in
 * src/i18n/messages.test.ts so parity is enforced from then on.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = 'gpt-4o';
const BATCH_SIZE = 40;
const MAX_RETRIES = 4;

const locale = process.argv[2];
const apiKey = process.env.OPENAI_API_KEY;

if (!locale) {
  console.error('usage: node scripts/translate-catalogue.mjs <locale>');
  process.exit(1);
}
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set.');
  process.exit(1);
}

const MESSAGES_DIR = join(process.cwd(), 'messages');
const SOURCE = join(MESSAGES_DIR, 'en.json');
const TARGET = join(MESSAGES_DIR, `${locale}.json`);
const CACHE = join(MESSAGES_DIR, `.${locale}.cache.json`);

/** Per-locale style guidance. Add your own locales here. */
const STYLE = {
  ar: [
    'Use Modern Standard Arabic — clear and professional, not literary.',
    'Address the user in GENDER-NEUTRAL form. Use the masculine imperative',
    'as the neutral default (سجل، احجز، ابدأ، اكتشف، أرسل). Never use the',
    'feminine forms (سجلي، احجزي، ابدئي). This is a hard requirement.',
    'Keep established product/tech terms recognisable rather than inventing',
    'calques: WhatsApp = واتساب, CRM = نظام إدارة العلاقات, webhook = ويب هوك.',
    'Keep UI labels short — Arabic runs longer than English and these sit in',
    'buttons, table headers, and sidebar items.',
  ].join(' '),
};

// ---------------------------------------------------------------- helpers

function flatten(node, path = '', out = {}) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      flatten(v, path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  out[path] = node;
  return out;
}

function unflatten(flat) {
  const root = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part];
    }
    node[parts.at(-1)] = value;
  }
  return root;
}

/** Every placeholder that must appear untouched in the translation. */
function placeholders(text) {
  return (text.match(/\{\{\s*\d+\s*\}\}|\{[^{}]+\}|<\/?[a-zA-Z][^>]*>/g) ?? []).sort();
}

function placeholdersMatch(source, translated) {
  const a = placeholders(source);
  const b = placeholders(translated);
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translateBatch(entries, attempt = 1) {
  const payload = Object.fromEntries(entries);

  const system = [
    `You translate UI strings for a WhatsApp CRM from English into ${locale}.`,
    STYLE[locale] ?? '',
    'Rules:',
    '1. Return ONLY a JSON object. No prose, no markdown fences.',
    '2. The output must have exactly the same keys as the input.',
    '3. Reproduce every placeholder EXACTLY: {name}, {count}, {{1}}, <b>…</b>.',
    '   Do not translate, reorder, space, or drop them.',
    '4. Translate values only. Never translate keys.',
    '5. Keep leading/trailing whitespace and punctuation style.',
  ].join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload, null, 2) },
      ],
    }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt > MAX_RETRIES) throw new Error(`giving up after ${res.status}`);
    const wait = 2 ** attempt * 1000;
    console.log(`  ${res.status} — retrying in ${wait / 1000}s`);
    await sleep(wait);
    return translateBatch(entries, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

  const data = await res.json();
  const text = data.choices[0].message.content
    .replace(/^```(?:json)?|```$/gm, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (attempt > MAX_RETRIES) throw new Error('model did not return JSON');
    console.log('  unparseable response — retrying');
    return translateBatch(entries, attempt + 1);
  }

  // Keep only keys that came back intact with their placeholders. Anything
  // dropped here falls to the untranslated report at the end rather than
  // silently shipping a broken string.
  const good = {};
  for (const [key, source] of entries) {
    const value = parsed[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!placeholdersMatch(source, value)) {
      console.log(`  ! placeholder mismatch, keeping English: ${key}`);
      continue;
    }
    good[key] = value;
  }
  return good;
}

// ------------------------------------------------------------------- main

const source = flatten(JSON.parse(readFileSync(SOURCE, 'utf8')));
const done = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

const pending = Object.entries(source).filter(([k]) => !(k in done));
console.log(
  `${Object.keys(source).length} strings, ${Object.keys(done).length} cached, ` +
    `${pending.length} to translate`,
);

for (let i = 0; i < pending.length; i += BATCH_SIZE) {
  const batch = pending.slice(i, i + BATCH_SIZE);
  const n = Math.floor(i / BATCH_SIZE) + 1;
  const total = Math.ceil(pending.length / BATCH_SIZE);
  console.log(`batch ${n}/${total} (${batch.length} strings)`);

  Object.assign(done, await translateBatch(batch));
  writeFileSync(CACHE, JSON.stringify(done, null, 2));
}

// Any key the model never returned cleanly stays in English so the UI
// renders real text instead of a raw keypath.
const missing = Object.keys(source).filter((k) => !(k in done));
const final = { ...done };
for (const key of missing) final[key] = source[key];

writeFileSync(TARGET, JSON.stringify(unflatten(final), null, 2) + '\n');

console.log(`\nwrote ${TARGET}`);
if (missing.length) {
  console.log(`${missing.length} strings left in English — review these:`);
  for (const key of missing.slice(0, 20)) console.log(`  ${key}`);
  if (missing.length > 20) console.log(`  …and ${missing.length - 20} more`);
}
console.log(`\nNext: add '${locale}' to TRANSLATED_LOCALES in src/i18n/messages.test.ts`);
