#!/usr/bin/env node
// Turns an approved issue-form submission into a catalogue entry.
//
// .github/workflows/process-submission.yml runs this when a maintainer labels
// an issue "approved". It can also be run by hand with the same variables:
//
//   ISSUE_BODY="$(cat body.md)" ISSUE_NUMBER=7 ISSUE_AUTHOR=octocat node scripts/submission.mjs
//
// On success it appends the entry to api/v2/catalogue.json, rebuilds
// api/v1/references.json, and leaves for the workflow:
//   $GITHUB_OUTPUT            id, label, branch
//   $RUNNER_TEMP/pr-body.md   the pull request's description
// A refused submission writes $RUNNER_TEMP/refusal.md (the comment posted on
// the issue) and exits 1. Outside Actions both files go to the system temp dir.

import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, build, readCatalogue, today } from './catalogue.mjs';

/** GitHub renders each form field as "### Field label", a blank line, then the value. */
export function parseField(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.replace(/\r\n/g, '\n').match(new RegExp(`### ${escaped}\\s*\\n\\n([\\s\\S]*?)(?=\\n\\n### |$)`));
  if (!match) return '';
  const value = match[1].trim();
  return value === '_No response_' ? '' : value;
}

const FIELDS = ['Reference label', 'Source', 'Trigger phrases', 'Custom regex', 'Media URL', 'Language', 'Tags'];

/**
 * Fields whose heading appears more than once. A textarea can carry a line
 * that reads "### Media URL", and the first heading would win, so a planted
 * field could replace the real one. Such an issue is refused instead.
 */
export function repeatedFields(body) {
  const text = body.replace(/\r\n/g, '\n');
  return FIELDS.filter((heading) => text.split('\n').filter((line) => line.trim() === `### ${heading}`).length > 1);
}

export function parseSubmission(body) {
  return {
    repeated: repeatedFields(body),
    label: parseField(body, 'Reference label').replace(/\s+/g, ' '),
    source: parseField(body, 'Source').replace(/\s+/g, ' '),
    triggers: parseField(body, 'Trigger phrases'),
    regex: parseField(body, 'Custom regex'),
    mediaUrl: parseField(body, 'Media URL'),
    language: parseField(body, 'Language'),
    tags: parseField(body, 'Tags'),
  };
}

/** The id the workflow has always derived from a label. */
export function idFor(label) {
  return label
    .toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e')
    .replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o')
    .replace(/[úùü]/g, 'u').replace(/[ñ]/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function mediaTypeFor(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/\.gif($|\?)|giphy\.com/.test(url)) return 'gif';
  return 'image';
}

/**
 * The entry for one submission, or the reasons it cannot be one.
 * Returns { entry, problems, renamed }.
 */
export function toEntry(fields, { number, author, added, takenIds }) {
  if (fields.repeated?.length) {
    return { entry: null, problems: [`These fields appear more than once: ${fields.repeated.join(', ')}. Each heading may appear only once.`], renamed: null };
  }
  const missing = [];
  if (!fields.label) missing.push('Reference label');
  if (!fields.source) missing.push('Source');
  if (!fields.triggers) missing.push('Trigger phrases');
  if (!fields.mediaUrl) missing.push('Media URL');
  if (missing.length) return { entry: null, problems: [`Missing: ${missing.join(', ')}.`], renamed: null };

  // A taken id used to be left for the maintainer, but the catalogue refuses
  // repeats, so the issue number makes it unique and the PR says so.
  let id = idFor(fields.label) || `reference-${number}`;
  let renamed = null;
  if (takenIds.has(id)) {
    renamed = { from: id, to: `${id}-${number}` };
    id = renamed.to;
  }

  const keywords = fields.triggers.split('\n').map((line) => line.trim()).filter(Boolean);
  const entry = {
    id,
    kind: 'reference',
    label: fields.label,
    source: fields.source,
    trigger: { pattern: fields.regex || `(${keywords.join('|')})`, flags: 'i', keywords },
    media: [{ url: fields.mediaUrl, type: mediaTypeFor(fields.mediaUrl), primary: true }],
    language: fields.language || 'es',
    tags: fields.tags ? fields.tags.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean) : [],
    origin: 'submission',
    credit: `@${author}`,
    added,
  };
  return { entry, problems: [], renamed };
}

/** Adds the submission to the catalogue under `root` and rebuilds v1. */
export function submit(body, { number, author, root = ROOT, added = today() }) {
  const catalogue = readCatalogue(root);
  const { entry, problems, renamed } = toEntry(parseSubmission(body), {
    number,
    author,
    added,
    takenIds: new Set(catalogue.entries.map((item) => item.id)),
  });
  if (!entry) return { entry: null, problems, renamed };
  // The catalogue's own rules decide the rest: a pattern that does not
  // compile, or a media link that is not https, stops here, not in Slack.
  const result = build({ root, catalogue: { ...catalogue, entries: [...catalogue.entries, entry] } });
  const index = catalogue.entries.length;
  const problemsHere = result.errors.map((line) => line.replace(`entries[${index}] (${entry.id}): `, ''));
  return { entry: result.errors.length ? null : entry, problems: problemsHere, renamed };
}

export function pullRequestBody({ entry, renamed, number, author }) {
  const json = JSON.stringify(entry, null, 2);
  // A fence longer than any run of backticks in the entry, so a label cannot close it early.
  const fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  return [
    `Closes #${number}`,
    `Submitted by @${author}`,
    '',
    ...(renamed ? [`The id \`${renamed.from}\` was taken, so this entry is \`${renamed.to}\`. Rename it before merging if you prefer, then run \`node scripts/catalogue.mjs\`.`, ''] : []),
    'Adds the entry to `api/v2/catalogue.json` and rebuilds `api/v1/references.json`, the file the Slack bot reads.',
    '',
    '## Entry preview',
    `${fence}json`,
    json,
    fence,
  ].join('\n');
}

export function refusalComment(problems) {
  return [
    '❌ **This submission could not be added.**',
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Edit the issue to fix it, then remove and add the `approved` label again.',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const number = process.env.ISSUE_NUMBER;
  const author = process.env.ISSUE_AUTHOR;
  const out = process.env.RUNNER_TEMP || tmpdir();
  if (!process.env.ISSUE_BODY || !/^\d+$/.test(number ?? '') || !/^[A-Za-z0-9-]+(\[bot\])?$/.test(author ?? '')) {
    console.error('submission: set ISSUE_BODY, ISSUE_NUMBER and ISSUE_AUTHOR');
    process.exit(2);
  }
  const { entry, problems, renamed } = submit(process.env.ISSUE_BODY, { number, author, root: process.env.CATALOGUE_ROOT || ROOT });
  if (!entry) {
    writeFileSync(join(out, 'refusal.md'), refusalComment(problems) + '\n');
    console.error(`submission: refused issue #${number}:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  writeFileSync(join(out, 'pr-body.md'), pullRequestBody({ entry, renamed, number, author }) + '\n');
  // One line each: the label passed the form's single-line input and the catalogue's checks.
  const outputs = { id: entry.id, label: entry.label.replace(/[\r\n]+/g, ' '), branch: `submission/issue-${number}-${entry.id}` };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(`submission: added ${entry.id} from issue #${number}${renamed ? ` (id ${renamed.from} was taken)` : ''}.`);
}
