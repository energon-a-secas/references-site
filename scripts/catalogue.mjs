#!/usr/bin/env node
// The catalogue: every reference the Energon community uses, in one file.
//
//   api/v2/catalogue.json   the source of truth. Edited by hand, or by
//                           scripts/submission.mjs (the GitHub issue form) and
//                           scripts/import-uploads.mjs (Meme Vault uploads).
//   api/v1/references.json  GENERATED: every entry that has a trigger, in the
//                           exact shape the Enerbot Slack bot reads
//                           (cb-enerbot-private/actions/cultural_references.rb).
//
//   node scripts/catalogue.mjs           validate, tidy the catalogue, write v1
//   node scripts/catalogue.mjs --check   exit 1 if either file would change
//
// The bot builds its whole list inside one rescue, so a single incomplete
// entry would empty it in Slack. That is why nothing reaches v1 without a
// trigger, a source and a language, and why v1 is never edited by hand.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOGUE_PATH = 'api/v2/catalogue.json';
export const V1_PATH = 'api/v1/references.json';

export const SITE = 'https://references.neorgon.com';
export const REPO = 'https://github.com/energon-a-secas/references-site';
// Bundled memes are files that memes-site serves; memes-site/scripts/sync-catalogue.mjs
// turns these URLs back into its own asset paths.
export const VAULT_PREFIX = 'https://memes.neorgon.com/assets/images/';

export const KINDS = ['reference', 'meme'];
export const ORIGINS = ['enerbot', 'submission', 'vault', 'upload'];
export const MEDIA_TYPES = ['youtube', 'gif', 'image'];

const ENTRY_KEYS = ['id', 'kind', 'label', 'source', 'category', 'trigger', 'media', 'language', 'tags', 'notes', 'origin', 'credit', 'added'];
const TRIGGER_KEYS = ['pattern', 'flags', 'keywords'];
const MEDIA_KEYS = ['url', 'type', 'primary'];
const META_KEYS = ['version', 'count', 'kinds', 'description', 'usage', 'endpoints', 'source'];
const OPTIONAL_TEXT = ['source', 'category', 'language', 'notes', 'credit'];

// Lowercase words joined by single hyphens. Letters beyond ASCII are allowed
// because a bundled meme's id is its Meme Vault name, which votes are keyed by
// (mañana-cubre-turno), and renaming it would orphan them.
const ID = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function today() {
  return process.env.CATALOGUE_TODAY || new Date().toISOString().slice(0, 10);
}

export function serialize(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

export function readCatalogue(root = ROOT) {
  return JSON.parse(readFileSync(join(root, CATALOGUE_PATH), 'utf8'));
}

/**
 * True when a quantified group contains a quantifier itself, as in (a+)+ or
 * (\s*\w+)*: the shape that backtracks without end on a near miss. The bot
 * runs every pattern on every Slack message, so one of these can hang it.
 */
export function hasNestedQuantifier(pattern) {
  const groups = [];
  let inClass = false;
  const quantifierAt = (i) => pattern[i] === '+' || pattern[i] === '*' || /^\{\d+,\d*\}/.test(pattern.slice(i));
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') groups.push(false);
    else if (c === ')') {
      const inner = groups.pop() ?? false;
      const quantified = quantifierAt(i + 1);
      if (inner && quantified) return true;
      if (groups.length && (inner || quantified)) groups[groups.length - 1] = true;
    } else if (groups.length && quantifierAt(i)) groups[groups.length - 1] = true;
  }
  return false;
}

/**
 * Compiles every trigger the way the bot does, with Ruby's Regexp, because a
 * pattern JavaScript accepts can still be one Ruby refuses (a variable-length
 * lookbehind), and the bot's single rescue would then drop its whole list.
 * Returns { checked, failures: [[id, message]] }; checked is false without Ruby.
 */
export function rubyRejects(entries) {
  const patterns = entries.filter((entry) => entry.trigger && typeof entry.trigger.pattern === 'string').map((entry) => [entry.id, entry.trigger.pattern, entry.trigger.flags === 'i']);
  const script = [
    "require 'json'",
    "JSON.parse(STDIN.read.force_encoding('UTF-8')).each do |id, pattern, insensitive|",
    '  Regexp.new(pattern, insensitive ? Regexp::IGNORECASE : 0)',
    'rescue RegexpError, ArgumentError, TypeError => e',
    '  puts JSON.generate([id, e.message])',
    'end',
  ].join('\n');
  const result = spawnSync(process.env.RUBY || 'ruby', ['-e', script], { input: JSON.stringify(patterns), encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) return { checked: false, failures: [] };
  return { checked: true, failures: result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

/** Every problem in the catalogue, as readable lines. An empty list means valid. */
export function validate(catalogue) {
  const errors = [];
  if (!isObject(catalogue)) return ['the catalogue must be a JSON object'];
  if (!isObject(catalogue.meta)) errors.push('meta must be an object');
  else {
    for (const key of Object.keys(catalogue.meta)) if (!META_KEYS.includes(key)) errors.push(`meta: unknown key "${key}"`);
    for (const key of ['version', 'description', 'usage', 'source']) if (!isText(catalogue.meta[key])) errors.push(`meta.${key} must be text`);
    if (!isObject(catalogue.meta.endpoints)) errors.push('meta.endpoints must be an object');
  }
  if (!Array.isArray(catalogue.entries)) return [...errors, 'entries must be an array'];

  const seen = new Map();
  catalogue.entries.forEach((entry, index) => {
    const where = `entries[${index}]${isObject(entry) && isText(entry.id) ? ` (${entry.id})` : ''}`;
    const fail = (message) => errors.push(`${where}: ${message}`);
    if (!isObject(entry)) return fail('must be an object');

    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) fail(`unknown key "${key}"`);

    if (!isText(entry.id) || !ID.test(entry.id)) fail('id must be lowercase words joined by hyphens');
    else if (seen.has(entry.id)) fail(`id repeats entries[${seen.get(entry.id)}]`);
    else seen.set(entry.id, index);

    if (!KINDS.includes(entry.kind)) fail(`kind must be one of ${KINDS.join(', ')}`);
    if (!isText(entry.label)) fail('label must be text');
    if (!ORIGINS.includes(entry.origin)) fail(`origin must be one of ${ORIGINS.join(', ')}`);
    if (!isText(entry.added) || !DAY.test(entry.added) || Number.isNaN(Date.parse(entry.added))) fail('added must be a date, YYYY-MM-DD');
    for (const key of OPTIONAL_TEXT) if (key in entry && !isText(entry[key])) fail(`${key} must be text when present`);
    if (!Array.isArray(entry.tags) || !entry.tags.every(isText)) fail('tags must be a list of text');

    if (!Array.isArray(entry.media) || entry.media.length === 0) fail('media must list at least one item');
    else {
      entry.media.forEach((item, i) => {
        if (!isObject(item)) return fail(`media[${i}] must be an object`);
        for (const key of Object.keys(item)) if (!MEDIA_KEYS.includes(key)) fail(`media[${i}]: unknown key "${key}"`);
        if (!isText(item.url) || !/^https:\/\/\S+$/.test(item.url)) fail(`media[${i}].url must be an https URL`);
        if (!MEDIA_TYPES.includes(item.type)) fail(`media[${i}].type must be one of ${MEDIA_TYPES.join(', ')}`);
        if (typeof item.primary !== 'boolean') fail(`media[${i}].primary must be true or false`);
      });
      if (entry.media.filter((item) => isObject(item) && item.primary === true).length !== 1) fail('exactly one media item must be primary');
    }

    if (entry.kind === 'reference' && !('trigger' in entry)) fail('a reference needs a trigger, which is what the bot answers to');
    if (entry.kind === 'meme' && !isText(entry.category)) fail('a meme needs a category');
    if (entry.origin === 'vault' && Array.isArray(entry.media) && !entry.media.every((item) => isObject(item) && String(item.url).startsWith(VAULT_PREFIX))) {
      fail(`a vault meme is a file memes-site serves, so its media must start with ${VAULT_PREFIX}`);
    }
    if (entry.origin === 'upload' && !isText(entry.credit)) fail('an upload needs a credit ("Anon" when the uploader asked to stay anonymous)');

    if ('trigger' in entry) {
      const trigger = entry.trigger;
      if (!isObject(trigger)) return fail('trigger must be an object');
      for (const key of Object.keys(trigger)) if (!TRIGGER_KEYS.includes(key)) fail(`trigger: unknown key "${key}"`);
      // The bot only ever asks whether the flags include "i", so nothing else would mean the same in Slack.
      if (trigger.flags !== '' && trigger.flags !== 'i') fail('trigger.flags must be "i" or "" (case-sensitive)');
      if (!Array.isArray(trigger.keywords) || trigger.keywords.length === 0 || !trigger.keywords.every(isText)) fail('trigger.keywords must list at least one phrase');
      if (!isText(trigger.pattern)) fail('trigger.pattern must be text');
      else {
        try {
          new RegExp(trigger.pattern, trigger.flags === 'i' ? 'i' : '');
        } catch (error) {
          fail(`trigger.pattern does not compile: ${error.message}`);
        }
        if (hasNestedQuantifier(trigger.pattern)) fail('trigger.pattern repeats a group that repeats inside, as in (a+)+, which can hang the bot');
      }
      if (!isText(entry.source)) fail('an entry with a trigger needs a source, which the bot shows in its help');
      if (!isText(entry.language)) fail('an entry with a trigger needs a language');
    }
  });
  return errors;
}

function ordered(object, keys) {
  const out = {};
  for (const key of keys) if (key in object) out[key] = object[key];
  return out;
}

/** The catalogue with its keys in a fixed order and its counts recomputed. */
export function tidy(catalogue) {
  const entries = catalogue.entries.map((entry) => {
    const out = ordered(entry, ENTRY_KEYS);
    if (out.trigger) out.trigger = ordered(out.trigger, TRIGGER_KEYS);
    out.media = out.media.map((item) => ordered(item, MEDIA_KEYS));
    return out;
  });
  const kinds = Object.fromEntries(KINDS.map((kind) => [kind, entries.filter((entry) => entry.kind === kind).length]));
  const meta = ordered({ ...catalogue.meta, count: entries.length, kinds }, META_KEYS);
  return { meta, entries };
}

/** The bot's view: every entry with a trigger, in v1's shape and order. */
export function toV1(catalogue, previous = null) {
  const references = catalogue.entries
    .filter((entry) => entry.trigger)
    .map((entry) => {
      const out = {
        id: entry.id,
        label: entry.label,
        source: entry.source,
        trigger: { pattern: entry.trigger.pattern, flags: entry.trigger.flags, keywords: entry.trigger.keywords },
        media: entry.media.map(({ url, type, primary }) => ({ url, type, primary })),
        language: entry.language,
        tags: entry.tags,
      };
      if (entry.notes) out.notes = entry.notes;
      return out;
    });
  // The date moves only when what the bot reads moves, so a rebuild with
  // nothing new changes nothing and --check stays quiet.
  const unchanged = previous && JSON.stringify(previous.references) === JSON.stringify(references);
  return {
    meta: {
      version: '1.0.0',
      generated: unchanged && previous.meta?.generated ? previous.meta.generated : today(),
      count: references.length,
      description: 'Cultural references and memes powering the Enerbot Slack bot. Each entry carries the original regex trigger so any client can replicate the same pattern-matching logic.',
      usage: 'Reconstruct a RegExp from trigger.pattern + trigger.flags, then test user text against it. Multiple entries can match the same input.',
      endpoints: {
        references: `${SITE}/api/v1/references.json`,
        music: `${SITE}/api/v1/music.json`,
        catalogue: `${SITE}/api/v2/catalogue.json`,
      },
      source: REPO,
      generatedFrom: CATALOGUE_PATH,
    },
    references,
  };
}

/**
 * Validate the catalogue (in JavaScript, then in Ruby when it is installed),
 * then write (or, with check, compare) both files.
 * Returns { errors, stale, written, catalogue, ruby }, ruby saying whether Ruby checked.
 */
export function build({ root = ROOT, check = false, catalogue = null } = {}) {
  const source = catalogue ?? readCatalogue(root);
  const errors = validate(source);
  if (errors.length) return { errors, stale: [], written: [], catalogue: source, ruby: false };
  const ruby = rubyRejects(source.entries);
  for (const [id, message] of ruby.failures) {
    const index = source.entries.findIndex((entry) => entry.id === id);
    errors.push(`entries[${index}] (${id}): trigger.pattern does not compile in Ruby, which the bot uses: ${message}`);
  }
  if (errors.length) return { errors, stale: [], written: [], catalogue: source, ruby: ruby.checked };

  const tidied = tidy(source);
  const v1Full = join(root, V1_PATH);
  const previousText = existsSync(v1Full) ? readFileSync(v1Full, 'utf8') : null;
  let previous = null;
  try {
    previous = previousText ? JSON.parse(previousText) : null;
  } catch {
    previous = null;
  }

  const outputs = [
    [CATALOGUE_PATH, serialize(tidied)],
    [V1_PATH, serialize(toV1(tidied, previous))],
  ];
  const stale = [];
  const written = [];
  for (const [path, text] of outputs) {
    const full = join(root, path);
    const old = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (old === text) continue;
    stale.push(path);
    if (!check) {
      writeFileSync(full, text);
      written.push(path);
    }
  }
  return { errors, stale, written, catalogue: tidied, ruby: ruby.checked };
}

/**
 * memes-site keeps its own copy of the vault memes (js/data.js, written by its
 * scripts/sync-catalogue.mjs). Inside the monorepo, say when that copy lags, so
 * whoever just edited the catalogue knows to sync it. Never fails: the copy
 * belongs to memes-site, whose own tests hold it to the catalogue.
 */
async function memesSiteNotice(catalogue) {
  const sync = join(ROOT, '..', 'memes-site', 'scripts', 'sync-catalogue.mjs');
  if (!existsSync(sync)) return;
  try {
    const { render, ROOT: memesRoot, DATA_PATH } = await import(sync);
    const current = readFileSync(join(memesRoot, DATA_PATH), 'utf8');
    if (current !== render(catalogue)) console.log(`catalogue: memes-site's ${DATA_PATH} no longer matches; run make catalogue in projects/memes-site.`);
  } catch (error) {
    console.log(`catalogue: could not compare memes-site's copy (${error.message}).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const { errors, stale, catalogue, ruby } = build({ check });
  if (!errors.length) await memesSiteNotice(catalogue);
  if (!errors.length && !ruby) console.log('catalogue: no ruby on PATH, so patterns were compiled in JavaScript only; CI compiles them in Ruby too.');
  if (errors.length) {
    console.error(`catalogue: ${errors.length} problem${errors.length === 1 ? '' : 's'} in ${CATALOGUE_PATH}:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  const { count, kinds } = catalogue.meta;
  const summary = `${count} entries (${KINDS.map((kind) => `${kinds[kind]} ${kind}s`).join(', ')}), ${catalogue.entries.filter((entry) => entry.trigger).length} with a trigger`;
  if (check) {
    if (stale.length) {
      console.error(`catalogue: out of date:\n  ${stale.join('\n  ')}\nRun: node scripts/catalogue.mjs`);
      process.exit(1);
    }
    console.log(`catalogue: ${summary}; both files are current.`);
  } else {
    console.log(stale.length ? `catalogue: wrote ${stale.join(', ')}; ${summary}.` : `catalogue: nothing to change; ${summary}.`);
  }
}
