# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
make serve      # Start dev server at http://localhost:8805
make kill       # Kill the dev server
make catalogue  # Validate api/v2/catalogue.json, tidy it, rebuild api/v1/references.json
make check      # Fail if either JSON file is out of date
make test       # node --test tests/*.test.mjs
make uploads    # Refresh the Meme Vault uploads in the catalogue (reads memes-site's public queries)
```

The site needs no build step and no npm; the scripts only need Node.

## Architecture

A static GitHub Pages site with two roles: a **JSON API** and a **browser playground**.

### The catalogue (the one source of truth)

`api/v2/catalogue.json` lists every reference the Energon community uses: the
Enerbot Slack bot's clips and the Meme Vault's memes. Every entry is a
reference and `kind` says which (`reference` or `meme`). `origin` says where it
came from:

- `enerbot`: the bot's original regex matrix (the first 37)
- `submission`: the GitHub issue form, credited to the submitter
- `vault`: a meme file that memes-site serves from its `assets/images/`
- `upload`: a meme someone uploaded on memes.neorgon.com, credited as the uploader chose ("Anon")

Edit it by hand, then run `make catalogue`, which validates it, rewrites it in
canonical key order with recomputed counts, and rebuilds v1. `scripts/catalogue.mjs`
holds the rules; read `validate()` before adding a field (unknown keys are refused).

Three files are generated from it, never edited by hand:

- `api/v1/references.json`: every entry with a `trigger`, in the exact v1 shape. Its `meta.generated` moves only when that list changes.
- `projects/memes-site/js/data.js`: the vault memes, written by memes-site's own `make catalogue`. `make catalogue` here prints a notice when that copy lags.
- `projects/amigos-ios/Amigos/Resources/enerbot-references.json`: the Amigos de Enerbot app's copy of v1, written by that repo's `scripts/sync-data.mjs`.

**Who reads v1, and why it is strict.** The Ruby bot (`cb-enerbot-private/actions/cultural_references.rb`)
fetches `https://references.neorgon.com/api/v1/references.json` and builds its
whole list inside one `rescue`, so a single entry missing `trigger.flags`,
`media[].url`, `label` or `source` empties the bot in Slack. That is why only
entries with a trigger reach v1, why a triggered entry must carry `source` and
`language`, and why `trigger.flags` is only ever `"i"` or `""` (the bot only asks
whether it includes `i`). A meme given a trigger, a source and a language
becomes a bot reply with no other change.

Every pattern is also compiled with Ruby's `Regexp` (`rubyRejects()`), because
JavaScript accepts patterns Ruby refuses, such as a variable-length lookbehind.
Without `ruby` on PATH that step is skipped with a notice; CI always runs it
with Ruby 3.4, the bot's version. A quantified group that repeats inside, as in
`(a+)+`, is refused outright (`hasNestedQuantifier()`): the bot runs every
pattern on every Slack message, and that shape can hang it.

`.github/workflows/check.yml` runs `make check` and `make test` on every push
and pull request, so a hand-edited catalogue PR gets the same checks.

**Uploads are owned by `scripts/import-uploads.mjs`.** It replaces every
`origin: upload` entry with a fresh snapshot of memes-site's public
`memes:list` (production deployment `polite-jellyfish-291`) and copies admins'
categories and labels onto bundled memes from `memes:organization`. It builds
each entry from an allowlist: the query also returns `uploadedBy` and
`ownerSubject`, and neither may ever reach this public file (a test holds that).
Edit uploads on memes.neorgon.com, then re-run `make uploads`.

**Critical detail:** `trigger.pattern` is raw Ruby regex source that also has to
read the same in JavaScript (the playground) and ICU (the Amigos app). Two
entries intentionally have no `i` flag; they are case-sensitive originals. When
adding entries, preserve the original case sensitivity.

`api/v1/music.json` (songs, dances, recommendations) is separate and hand-edited.

### Submissions

`.github/ISSUE_TEMPLATE/new-reference.yml` is the form. When a maintainer labels
an issue `approved`, `.github/workflows/process-submission.yml` runs
`scripts/submission.mjs`, which parses the form, appends a `submission` entry to
the catalogue and rebuilds v1; the workflow then commits both files to
`submission/issue-<n>-<id>`, opens the PR and comments on the issue. A refused
submission (missing field, pattern that does not compile, non-https media) gets
a comment instead, and so does an issue whose body repeats a field heading (a
textarea could otherwise plant a second "### Media URL"). A taken id is
suffixed with the issue number; labelling the same issue approved twice
comments that its branch already exists. Issue text reaches the shell only
through `env`, never through an expression inside a `run:` line. Actions are
pinned by commit SHA, as elsewhere in the fleet.

### Single-file frontend (`index.html`)

All CSS and JavaScript are inline in `index.html`. No external JS, no build, no npm.

- On load it fetches `api/v2/catalogue.json` (and `api/v1/music.json` separately, so a music failure leaves the grid standing).
- The kind toggle (All / References / Memes) and the facet chips filter the grid. A reference's facet is its `source`; a meme's is its `category`.
- The live matcher runs every trigger's regex exactly as the bot does, then a plain search across labels, sources, categories, tags, keywords, credits and notes, with accents folded. Pattern hits are listed first.
- Every interpolated value goes through `escHtml`: upload labels are whatever the uploader typed.
- The CSP meta allows `img-src` from `img.youtube.com`, `*.giphy.com`, `memes.neorgon.com` (vault memes) and `polite-jellyfish-291.convex.cloud` (uploads). A new media host needs a CSP update.

### Source data (`cb-enerbot-private/`)

A separate git repo cloned here for reference only (gitignored, read-only, never
modify): the Enerbot Slack bot. Its `actions/cultural_references.rb` fetches the
live v1 URL, so a merged change to the catalogue reaches Slack on the bot's next
restart (it memoizes the list per dyno).

## Deployment

GitHub Pages: pushing to `main` deploys. `CNAME` sets `references.neorgon.com`.
The repository is `energon-a-secas/references-site`.
