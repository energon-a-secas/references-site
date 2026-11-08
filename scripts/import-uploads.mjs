#!/usr/bin/env node
// Brings the Meme Vault's live layer into the catalogue.
//
// memes-site keeps community uploads, and the categories and labels admins
// give bundled memes, in its Convex deployment. This reads the same public
// queries memes.neorgon.com calls for an anonymous visitor (memes:list and
// memes:organization), then:
//
//   - replaces every `origin: "upload"` entry with a fresh snapshot, so an
//     upload deleted on the site disappears here too. Those entries belong to
//     this script: edit them on memes.neorgon.com, not in the catalogue.
//   - copies an admin's category and labels onto the matching bundled meme.
//
// An upload's attribution is the name the site shows publicly (displayName,
// "Anon" for an anonymous upload). The query also returns uploadedBy and
// ownerSubject; neither is ever copied.
//
//   node scripts/import-uploads.mjs                 fetch, merge, rebuild v1
//   node scripts/import-uploads.mjs --check         exit 1 if the snapshot is stale
//   node scripts/import-uploads.mjs --list <file> [--organization <file>]
//                                                   merge saved replies instead of fetching

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, readCatalogue } from './catalogue.mjs';

export const DEPLOYMENT = process.env.MEMES_CONVEX_URL || 'https://polite-jellyfish-291.convex.cloud';
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

async function query(path) {
  const response = await fetch(`${DEPLOYMENT}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args: {}, format: 'json' }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const reply = await response.json();
  if (reply.status !== 'success') throw new Error(`${path}: ${reply.errorMessage || reply.status}`);
  return reply.value;
}

/** Accents folded, lowercase, words joined by hyphens: "Dewey sal de ahí" -> "dewey-sal-de-ahi". */
export function slug(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** A typed title stays as typed; a file-style name ("improvise_adapt_overcome") reads as words. */
export function labelFor(name) {
  const text = name.trim().replace(/\s+/g, ' ');
  if (/\s/.test(text) || !/[-_]/.test(text)) return text;
  const words = text.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const day = (millis) => new Date(millis).toISOString().slice(0, 10);

/** One catalogue entry from one memes:list row, built from an allowlist of fields. */
export function uploadEntry(row) {
  const problems = [];
  if (typeof row._id !== 'string' || !/^[a-z0-9]{8,}$/.test(row._id)) problems.push('an _id');
  if (typeof row.name !== 'string' || !row.name.trim()) problems.push('a name');
  if (typeof row.category !== 'string' || !row.category.trim()) problems.push('a category');
  if (!EXTENSIONS.includes(row.ext)) problems.push(`a known extension (got ${row.ext})`);
  if (typeof row.url !== 'string' || !row.url.startsWith(`${DEPLOYMENT}/api/storage/`)) problems.push('a storage URL on the deployment');
  if (typeof row._creationTime !== 'number') problems.push('a creation time');
  if (problems.length) throw new Error(`upload ${row._id ?? '?'} lacks ${problems.join(', ')}`);

  const credit = row.displayAnonymous === false && typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim() : 'Anon';
  return {
    id: `${slug(row.name) || 'meme'}-${row._id.slice(-6)}`,
    kind: 'meme',
    label: labelFor(row.name),
    category: row.category,
    media: [{ url: row.url, type: row.ext === 'gif' ? 'gif' : 'image', primary: true }],
    tags: Array.isArray(row.labels) ? row.labels.filter((label) => typeof label === 'string' && label.trim()) : [],
    origin: 'upload',
    credit,
    added: day(row._creationTime),
  };
}

/**
 * The catalogue with its upload entries replaced by `rows` and the admins'
 * organization applied to bundled memes. Uploads stay one block, oldest
 * first, where the previous block was (or at the end the first time).
 */
export function mergeUploads(catalogue, rows, organization = []) {
  const uploads = [...rows]
    .sort((a, b) => a._creationTime - b._creationTime || String(a._id).localeCompare(String(b._id)))
    .map(uploadEntry);

  const at = catalogue.entries.findIndex((entry) => entry.origin === 'upload');
  const rest = catalogue.entries.filter((entry) => entry.origin !== 'upload');
  const insertAt = at === -1 ? rest.length : catalogue.entries.slice(0, at).filter((entry) => entry.origin !== 'upload').length;

  const byKey = new Map(organization.map((row) => [row.memeKey, row]));
  let organized = 0;
  const kept = rest.map((entry) => {
    const row = entry.origin === 'vault' ? byKey.get(entry.id) : null;
    if (!row) return entry;
    const labels = Array.isArray(row.labels) ? row.labels : [];
    if (entry.category === row.category && JSON.stringify(entry.tags) === JSON.stringify(labels)) return entry;
    organized += 1;
    return { ...entry, category: row.category, tags: labels };
  });

  const before = new Set(catalogue.entries.filter((entry) => entry.origin === 'upload').map((entry) => entry.id));
  const after = new Set(uploads.map((entry) => entry.id));
  return {
    catalogue: { ...catalogue, entries: [...kept.slice(0, insertAt), ...uploads, ...kept.slice(insertAt)] },
    added: [...after].filter((id) => !before.has(id)).length,
    removed: [...before].filter((id) => !after.has(id)).length,
    uploads: uploads.length,
    organized,
  };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const listFile = option('--list');
  const organizationFile = option('--organization');
  try {
    const rows = listFile ? JSON.parse(readFileSync(listFile, 'utf8')) : await query('memes:list');
    const organization = organizationFile ? JSON.parse(readFileSync(organizationFile, 'utf8')) : listFile ? [] : await query('memes:organization');
    const unwrap = (value) => (Array.isArray(value) ? value : value?.value);
    const merged = mergeUploads(readCatalogue(), unwrap(rows), unwrap(organization) ?? []);
    const result = build({ check, catalogue: merged.catalogue });
    if (result.errors.length) {
      console.error(`import-uploads: the merged catalogue is invalid:\n  ${result.errors.join('\n  ')}`);
      process.exit(1);
    }
    const summary = `${merged.uploads} uploads (${merged.added} new, ${merged.removed} gone), ${merged.organized} bundled memes reorganized`;
    if (check) {
      if (result.stale.length) {
        console.error(`import-uploads: the snapshot is out of date (${summary}). Run: node scripts/import-uploads.mjs`);
        process.exit(1);
      }
      console.log(`import-uploads: snapshot is current; ${summary}.`);
    } else {
      console.log(`import-uploads: ${summary}; ${result.written.length ? `wrote ${result.written.join(', ')}` : 'nothing to change'}.`);
    }
  } catch (error) {
    console.error(`import-uploads: ${error.message}`);
    process.exit(1);
  }
}
