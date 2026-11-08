// node --test tests/   (make test)
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CATALOGUE_PATH, ROOT, V1_PATH, build, hasNestedQuantifier, readCatalogue, rubyRejects, tidy, today, toV1, validate } from '../scripts/catalogue.mjs';
import { labelFor, mergeUploads, slug, uploadEntry } from '../scripts/import-uploads.mjs';
import { parseSubmission, pullRequestBody, refusalComment, submit, toEntry } from '../scripts/submission.mjs';

const catalogue = readCatalogue();
const v1 = JSON.parse(readFileSync(join(ROOT, V1_PATH), 'utf8'));
const clone = (value) => structuredClone(value);
const errorsFor = (mutate) => {
  const copy = clone(catalogue);
  mutate(copy);
  return validate(copy);
};

// A scratch copy of the repo's two data files, for anything that writes.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-'));
  cpSync(join(ROOT, 'api'), join(dir, 'api'), { recursive: true });
  return dir;
}

const FORM = (fields) =>
  Object.entries({
    'Reference label': 'Orden 67',
    Source: 'Star Wars',
    'Trigger phrases': 'orden 67\nexecute order 67',
    'Custom regex': '_No response_',
    'Media URL': 'https://www.youtube.com/watch?v=abc',
    Language: 'es',
    Tags: 'Movie, Star-Wars',
    ...fields,
  })
    .map(([heading, value]) => `### ${heading}\n\n${value}`)
    .join('\n\n');

test('the catalogue is valid and both files are current', () => {
  assert.deepEqual(validate(catalogue), []);
  const { errors, stale } = build({ check: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(stale, [], 'run node scripts/catalogue.mjs');
});

test('v1 is every entry with a trigger, in the shape the bot parses', () => {
  const triggered = catalogue.entries.filter((entry) => entry.trigger);
  assert.equal(v1.references.length, triggered.length);
  assert.equal(v1.meta.count, triggered.length);
  assert.deepEqual(v1.references.map((ref) => ref.id), triggered.map((entry) => entry.id));
  for (const ref of v1.references) {
    const keys = Object.keys(ref);
    assert.deepEqual(keys.filter((key) => key !== 'notes'), ['id', 'label', 'source', 'trigger', 'media', 'language', 'tags']);
    assert.deepEqual(Object.keys(ref.trigger), ['pattern', 'flags', 'keywords']);
    // What cultural_references.rb reads: flags.include?('i'), every media url, label and source.
    assert.ok(typeof ref.trigger.flags === 'string' && typeof ref.trigger.pattern === 'string' && ref.trigger.pattern);
    assert.ok(ref.media.length && ref.media.every((item) => typeof item.url === 'string' && item.url.startsWith('https://')));
    assert.ok(ref.label && ref.source && ref.language);
  }
  // The Amigos de Enerbot sync copies meta.version into the app.
  assert.equal(v1.meta.version, '1.0.0');
});

test('memes stay out of the bot until one is given a trigger', () => {
  assert.ok(!v1.references.some((ref) => catalogue.entries.find((entry) => entry.id === ref.id).kind === 'meme'));
  const copy = clone(catalogue);
  const meme = copy.entries.find((entry) => entry.origin === 'vault');
  meme.trigger = { pattern: '(canon event)', flags: 'i', keywords: ['canon event'] };
  assert.match(validate(copy).join('\n'), /needs a source/);
  meme.source = 'Spider-Verse';
  meme.language = 'en';
  assert.deepEqual(validate(copy), []);
  assert.ok(toV1(tidy(copy)).references.some((ref) => ref.id === meme.id));
});

test('the v1 date moves only when what the bot reads moves', () => {
  const old = { ...v1, meta: { ...v1.meta, generated: '1999-01-01' } };
  assert.equal(toV1(tidy(catalogue), old).meta.generated, '1999-01-01');
  const copy = clone(catalogue);
  copy.entries[0].label += '!';
  assert.equal(toV1(tidy(copy), old).meta.generated, today());
  // A new meme is not something the bot reads, so it does not move the date either.
  copy.entries[0].label = catalogue.entries[0].label;
  copy.entries.push({ ...clone(catalogue.entries.find((entry) => entry.origin === 'vault')), id: 'brand-new-meme' });
  assert.equal(toV1(tidy(copy), old).meta.generated, '1999-01-01');
});

test('the validator refuses what would break a consumer', () => {
  assert.match(errorsFor((c) => (c.entries[1].id = c.entries[0].id)).join('\n'), /id repeats/);
  assert.match(errorsFor((c) => delete c.entries[0].trigger).join('\n'), /needs a trigger/);
  assert.match(errorsFor((c) => (c.entries[0].trigger.pattern = '(unclosed')).join('\n'), /does not compile/);
  assert.match(errorsFor((c) => (c.entries[0].trigger.flags = 'im')).join('\n'), /flags must be/);
  assert.match(errorsFor((c) => (c.entries[0].tag = ['typo'])).join('\n'), /unknown key "tag"/);
  assert.match(errorsFor((c) => (c.entries[0].media[0].url = 'http://example.com')).join('\n'), /https URL/);
  assert.match(errorsFor((c) => (c.entries[0].media[0].primary = false)).join('\n'), /exactly one media item must be primary/);
  assert.match(errorsFor((c) => delete c.entries.find((e) => e.kind === 'meme').category).join('\n'), /needs a category/);
  assert.match(errorsFor((c) => (c.entries.find((e) => e.origin === 'vault').media[0].url = 'https://example.com/a.png')).join('\n'), /vault meme/);
  assert.match(errorsFor((c) => delete c.entries.find((e) => e.origin === 'upload').credit).join('\n'), /needs a credit/);
  assert.match(errorsFor((c) => (c.entries[0].added = '2026-13-45')).join('\n'), /added must be a date/);
  assert.match(errorsFor((c) => (c.entries[0].trigger.pattern = '(\\s*\\w+)*$')).join('\n'), /can hang the bot/);
});

test('a group that repeats a repetition is caught, a plain one is not', () => {
  for (const pattern of ['(a+)+$', '(?:x*y)+', '((a)+)+', '(a{2,})+']) assert.ok(hasNestedQuantifier(pattern), pattern);
  for (const pattern of ['(a|b)+', '(orden 66)', '(a+)', '(a{2})+', '[(+)]+', '\\(a+\\)+', '(ab)?c+']) assert.ok(!hasNestedQuantifier(pattern), pattern);
  for (const entry of catalogue.entries.filter((item) => item.trigger)) assert.ok(!hasNestedQuantifier(entry.trigger.pattern), entry.id);
});

test('every pattern compiles in Ruby, the engine the bot runs', (t) => {
  const probe = rubyRejects([]);
  if (!probe.checked) return t.skip('no ruby on PATH; CI runs this with Ruby 3.4');
  assert.deepEqual(rubyRejects(catalogue.entries).failures, []);
  // JavaScript accepts a variable-length lookbehind; Ruby does not, and the bot would lose every reference.
  const copy = clone(catalogue);
  copy.entries[0].trigger.pattern = '(?<=a+)b';
  assert.deepEqual(validate(copy), []);
  assert.match(build({ check: true, catalogue: copy }).errors.join('\n'), /does not compile in Ruby/);
});

test('every vault meme points at memes-site, and ids keep the Vault names votes use', () => {
  const vault = catalogue.entries.filter((entry) => entry.origin === 'vault');
  assert.ok(vault.length > 0);
  assert.ok(vault.some((entry) => entry.id === 'mañana-cubre-turno'));
  for (const entry of vault) assert.ok(entry.media[0].url.startsWith('https://memes.neorgon.com/assets/images/'));
});

test('an upload is built from an allowlist: no uploader name or account id', () => {
  const row = {
    _id: 'jn76abcdefghijklmnopqrstuvwxy7k2q9',
    _creationTime: Date.UTC(2026, 8, 20, 12),
    name: 'Dewey sal de ahí, esa no es tu familia',
    category: 'simpsons',
    labels: ['family'],
    ext: 'gif',
    url: 'https://polite-jellyfish-291.convex.cloud/api/storage/0b1c2d3e-0000-4000-8000-000000000000',
    storageId: 'kg2secret',
    uploadedBy: 'Real Name',
    ownerSubject: 'user_secret',
    displayAnonymous: true,
    displayName: 'Anon',
  };
  const entry = uploadEntry(row);
  assert.equal(entry.id, 'dewey-sal-de-ahi-esa-no-es-tu-familia-y7k2q9');
  assert.equal(entry.credit, 'Anon');
  assert.equal(entry.added, '2026-09-20');
  assert.equal(entry.media[0].type, 'gif');
  const text = JSON.stringify(entry);
  for (const secret of ['Real Name', 'user_secret', 'kg2secret']) assert.ok(!text.includes(secret), secret);
  assert.equal(uploadEntry({ ...row, displayAnonymous: false, displayName: 'Tomás' }).credit, 'Tomás');
  assert.throws(() => uploadEntry({ ...row, url: 'https://evil.example/x.png' }), /storage URL/);
});

test('names read as words and slugs fold accents', () => {
  assert.equal(labelFor('improvise_adapt_overcome'), 'Improvise adapt overcome');
  assert.equal(labelFor('monkey with AK-47'), 'monkey with AK-47');
  assert.equal(slug('El paracetamol viendo todo el dolor'), 'el-paracetamol-viendo-todo-el-dolor');
  assert.equal(slug('¿?'), '');
});

test('importing uploads replaces the block, keeps curated entries and applies organization', () => {
  const base = clone(catalogue);
  const vault = base.entries.find((entry) => entry.origin === 'vault');
  const curated = base.entries.filter((entry) => entry.origin !== 'upload');
  const rows = [
    { _id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', _creationTime: 2, name: 'second', category: 'general', ext: 'png', url: 'https://polite-jellyfish-291.convex.cloud/api/storage/2', displayAnonymous: true },
    { _id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', _creationTime: 1, name: 'first', category: 'general', ext: 'png', url: 'https://polite-jellyfish-291.convex.cloud/api/storage/1', displayAnonymous: true },
  ];
  const merged = mergeUploads(base, rows, [{ memeKey: vault.id, category: 'mood', labels: ['work'] }]);
  const uploads = merged.catalogue.entries.filter((entry) => entry.origin === 'upload');
  assert.deepEqual(uploads.map((entry) => entry.label), ['first', 'second']);
  assert.equal(merged.removed, catalogue.entries.filter((entry) => entry.origin === 'upload').length);
  assert.equal(merged.organized, 1);
  const organized = merged.catalogue.entries.find((entry) => entry.id === vault.id);
  assert.equal(organized.category, 'mood');
  assert.deepEqual(organized.tags, ['work']);
  assert.deepEqual(
    merged.catalogue.entries.filter((entry) => entry.origin !== 'upload').map((entry) => entry.id),
    curated.map((entry) => entry.id),
  );
  assert.deepEqual(validate(merged.catalogue), []);
  // Re-importing the same rows changes nothing.
  assert.deepEqual(mergeUploads(merged.catalogue, rows, []).catalogue.entries, merged.catalogue.entries);
});

test('a submission becomes a credited reference and rebuilds v1', () => {
  const dir = scratch();
  try {
    const { entry, problems, renamed } = submit(FORM({}), { number: '12', author: 'octocat', root: dir, added: '2026-11-08' });
    assert.deepEqual(problems, []);
    assert.equal(renamed, null);
    assert.equal(entry.id, 'orden-67');
    assert.deepEqual(entry.trigger, { pattern: '(orden 67|execute order 67)', flags: 'i', keywords: ['orden 67', 'execute order 67'] });
    assert.deepEqual(entry.tags, ['movie', 'star-wars']);
    assert.equal(entry.credit, '@octocat');
    const written = JSON.parse(readFileSync(join(dir, CATALOGUE_PATH), 'utf8'));
    const writtenV1 = JSON.parse(readFileSync(join(dir, V1_PATH), 'utf8'));
    assert.equal(written.entries.at(-1).id, 'orden-67');
    assert.equal(writtenV1.references.at(-1).id, 'orden-67');
    assert.equal(writtenV1.meta.count, v1.meta.count + 1);
    assert.deepEqual(build({ root: dir, check: true }).stale, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a planted heading is refused, and a label cannot break out of the PR preview', () => {
  const planted = FORM({ 'Trigger phrases': 'orden 67\n\n### Media URL\n\nhttps://evil.example/x.gif' });
  const result = toEntry(parseSubmission(planted), { number: '17', author: 'octocat', added: '2026-11-08', takenIds: new Set() });
  assert.equal(result.entry, null);
  assert.match(result.problems.join(), /Media URL/);

  const { entry } = toEntry(parseSubmission(FORM({ 'Reference label': 'Tick ``` tock' })), { number: '18', author: 'octocat', added: '2026-11-08', takenIds: new Set() });
  const body = pullRequestBody({ entry, renamed: null, number: '18', author: 'octocat' });
  const fence = body.match(/^(`{3,})json$/m)[1];
  assert.ok(fence.length > 3);
  assert.equal(body.split('\n').filter((line) => line === fence).length, 1, 'only the closing fence matches');
});

test('a taken id gets the issue number; a broken submission is refused and writes nothing', () => {
  const taken = toEntry(parseSubmission(FORM({ 'Reference label': 'Orden 66' })), { number: '13', author: 'octocat', added: '2026-11-08', takenIds: new Set(['orden-66']) });
  assert.deepEqual(taken.renamed, { from: 'orden-66', to: 'orden-66-13' });

  const dir = scratch();
  try {
    const before = readFileSync(join(dir, CATALOGUE_PATH), 'utf8');
    const missing = submit(FORM({ 'Media URL': '_No response_' }), { number: '14', author: 'octocat', root: dir });
    assert.equal(missing.entry, null);
    assert.match(missing.problems.join(), /Missing: Media URL/);
    const badRegex = submit(FORM({ 'Custom regex': '(orden 67' }), { number: '15', author: 'octocat', root: dir });
    assert.equal(badRegex.entry, null);
    assert.match(badRegex.problems.join(), /does not compile/);
    assert.match(refusalComment(badRegex.problems), /could not be added/);
    const insecure = submit(FORM({ 'Media URL': 'http://example.com/clip.gif' }), { number: '16', author: 'octocat', root: dir });
    assert.match(insecure.problems.join(), /https URL/);
    assert.equal(readFileSync(join(dir, CATALOGUE_PATH), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
