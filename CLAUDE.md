# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
make serve    # Start dev server at http://localhost:8805
make kill     # Kill the dev server
```

`index.html` can also be opened directly in a browser. No server required since it's a single-file app with no ES modules.

## Architecture

This is a static GitHub Pages site with two distinct roles: a **JSON API** and a **browser playground**.

### Static JSON API

The "API" is two plain JSON files with stable versioned URLs, no backend:

- `api/v1/references.json`: 38 cultural references (README says 37; count has diverged). Each entry has an `id`, `label`, `source`, `trigger` (with `pattern`, `flags`, `keywords`), `media` array, `language`, and `tags`.
- `api/v1/music.json`: Songs (with lyrics excerpts), dance video URLs, and music recommendations.

**Critical detail:** `trigger.pattern` is raw Ruby regex source translated to JavaScript. Two entries intentionally have no `i` flag. They are case-sensitive originals. When adding new entries, preserve the original case sensitivity from the Ruby source.

### Single-file Frontend (`index.html`)

All CSS and JavaScript are inline in `index.html` (~1,700+ lines). There are no external JS files, no build step, no npm. The page has three sections toggled via tab navigation: **Playground**, **API**, and **Sources**.

Key JS behaviors:
- On load, `fetch('api/v1/references.json')` loads data locally (not from the live URL), then renders the card grid.
- The live regex playground: user types into `#search-input`, each keystroke runs all 38 patterns against the input using `new RegExp(ref.trigger.pattern, ref.trigger.flags)`. Matching cards get a `.highlight` class; non-matching cards get `.dimmed`. The match count badge updates in real time.
- Filter chips (`#filter-chips`) filter by `source` field. Active filters AND the search input are applied simultaneously.
- YouTube thumbnails are loaded lazily via `https://img.youtube.com/vi/{videoId}/mqdefault.jpg`. GIF entries show the direct GIF URL.
- The CSP header (`Content-Security-Policy`) in the meta tag explicitly allows `img-src` from `img.youtube.com` and `*.giphy.com`. Any new media domain requires a CSP update.

### Source Data (`cb-enerbot-private/`)

This is a read-only git submodule (separate `.git`, reference only, never modify). The original Ruby bot patterns live in `cb-enerbot-private/actions/cultural_references.rb`. That file now fetches from the live API URL (`https://references.neorgon.com/api/v1/references.json`) rather than hardcoding patterns. The JSON is the source of truth.

When adding or updating a reference entry in `references.json`, the Ruby bot automatically picks it up on next load (it caches via `@references ||=`).

## Reference Entry Schema

```json
{
  "id": "slug-id",
  "label": "Human name",
  "source": "Show / Movie / Origin",
  "trigger": {
    "pattern": "(raw regex)",
    "flags": "i",
    "keywords": ["readable phrase"]
  },
  "media": [
    { "url": "https://...", "type": "youtube|gif", "primary": true }
  ],
  "language": "es|en|es/en",
  "tags": ["tag1", "tag2"],
  "notes": "optional — use for case-sensitivity quirks"
}
```

Multiple media entries per reference are supported; the Ruby bot picks one at random (`urls.sample`). The playground always shows the `primary: true` entry.

## Deployment

Served via GitHub Pages: pushing to `main` deploys automatically. The `CNAME` file sets the custom domain to `references.neorgon.com`. No build pipeline.
