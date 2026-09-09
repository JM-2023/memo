# README demo notebook

[`notebook.json`](notebook.json) contains 96 fictional memos and two fictional
Trash entries. All prose was written for the screenshots; it contains no personal
notebook data. It uses the app's `memo-backup` version 1 format and can be imported
through **My MEMO → Import Data** in a separate local instance.

The notes follow a small reading-corner project, cooking, gardening, reading and
everyday observations. They include a pinned checklist, nested and pinned tags,
Markdown tables, math, code, a link and a bilingual entry. Dates span October 2025
through September 10, 2026.

## Local instance

Build with `npm run build`. Use a temporary directory containing copies of
`dist/`, `functions/`, `src/` and `migrations/`. In that directory, create this
local-only `wrangler.toml`:

```toml
name = "memo-readme-demo"
pages_build_output_dir = "dist"
compatibility_date = "2026-06-22"

[[d1_databases]]
binding = "DB"
database_name = "memo-readme-demo"
database_id = "00000000-0000-0000-0000-000000000000"
```

Create a `.dev.vars` file there with a random `SESSION_SECRET`. From the repository
root, replace `<demo-dir>` below with that temporary directory:

```sh
npx wrangler d1 migrations apply DB --local --config <demo-dir>/wrangler.toml --persist-to <demo-dir>/state
npx wrangler pages dev --cwd <demo-dir> --ip 127.0.0.1 --port 8792 --persist-to <demo-dir>/state
```

Open `http://127.0.0.1:8792`, create a local passcode, then import `notebook.json`.
The placeholder database and separate state directory keep this demo isolated.

## Capture settings

The September 2026 images use the production build of **v2.5.35**, served through
local Pages Functions and D1. Chrome renders the actual application without
mocked API responses or edited interface text.

- Locale: English; time zone: `Asia/Shanghai`.
- Clock: September 10, 2026, 10:30. With Playwright, use
  `page.clock.setFixedTime(new Date("2026-09-10T02:30:00Z"))` before navigation.
  Timers and UI animations continue to run.
- Desktop: 1600 × 1000 pixels; 1600 × 1100 for Markdown and tags, so the expanded
  sidebar fits. The month heatmap is selected.
- Mobile: 390 × 844 pixels; Simplified Chinese interface, `journal` selected,
  keyword search for `窗边` to show the bilingual entry.
- Wait for fonts and entrance animations to settle before each capture. Move the
  pointer into an empty margin; retain editor focus for tag autocomplete.
- Semantic search stays off. Capture keyword search for `fruit` and the model
  settings panel with **Advanced** expanded before downloading. No model inference
  is used for these images.

The Markdown image selects `work/notebook`; the tag image selects `life/cooking`.
Daily review uses its default ten-note sample. The share image uses the quote
beginning “Leave a little space”, with cream paper and the dateline enabled.
The composer draft is “A small plan for Sunday”, followed by a market plan and
`#life/` to open tag suggestions.

All twelve interface images in `../screenshots/` were refreshed together. The
existing logo is a separate brand asset.
