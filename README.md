# MEMO — Private notes on Cloudflare

MEMO is a personal, single-owner note app built with Cloudflare Pages, Pages Functions, and D1. It is designed for typical personal use within Cloudflare's Free plan and does not require R2. The interface supports light and dark themes and is available in English and Simplified Chinese. English is the default; the language can be changed in Settings and is remembered by the browser.

## Features

- **Passcode gate:** protect the notebook with a numeric passcode (4–18 digits). The salted PBKDF2 hash is stored in D1, and authenticated sessions use an HMAC-signed cookie. Data and stored-image APIs return `401` until the session is authenticated.
- **Dashboard and statistics:** browse memo, tag, and day totals; weekly, monthly, and yearly memo and character counts; a horizontal heatmap that follows the This week / This month / This year selector (week strip, wall-calendar month, GitHub-style year band) and pages backwards period by period; and a detailed yearly statistics view with monthly activity, weekday and time-of-day distributions, and streaks. All timestamps are stored in UTC and rendered in the viewer's local time zone.
- **Hierarchical tags:** organize notes with paths such as `#parent/child`, navigate through breadcrumb segments, and pin, rename, or remove tags. Global rewrites are bounded and resumable, then synchronize to other devices. Rename targets must sit outside the source tag's own ancestor/descendant subtree so an interrupted operation can be replayed safely.
- **Writing and media:** search and sort by created or edited time, use tag autocomplete, and add images by selecting, pasting, or dragging files. External image links in Markdown or direct image URLs are previewed without using D1 storage.
- **Markdown:** memos render per-line Markdown — `#`–`###` headings, bullet/numbered lists with nesting, `- [ ]` task checkboxes, `>` quotes, `---` dividers, `| a | b |` tables (equal-column rows, bold header above a `| --- |` delimiter, `\|` for a literal pipe), and inline **bold**, *italic*, ~~strikethrough~~, ==highlight==, `code`, and `[text](url)` links, with `#tags` still clickable inside styled text. The composer helps write it: Enter continues a list (Enter on an empty item exits it) and builds tables row by row (header → delimiter → empty rows), Tab/Shift+Tab indent lists and hop between table cells, ⌘B/⌘I/⌘E/⌘⇧S/⌘⇧H wrap the selection, and the toolbar gains bold, list, and table buttons. Content stays plain text, so nothing changes for sync, search, or encryption.
- **Memo actions:** pin, edit, copy, or delete a memo, and open images in a lightbox.
- **Recycle bin:** normal deletion keeps the memo and its attachments available for restoration. Permanent deletion and emptying the recycle bin remove the memo rows and images, leaving only small tombstones so other devices can synchronize the deletion.
- **Portable backups:** export the entire notebook, including Trash, inline images, and pinned tags, to a readable JSON file. Import merges new memo IDs, skips existing ones, and encrypts restored content with the destination deployment key.
- **Incremental synchronization:** every synchronized memo or tag mutation receives a globally increasing `seq`. Clients merge responses by entity version, pull changes with `GET /api/sync?since=N` after local writes, when the window regains focus or visibility, and every 60 seconds. Tabs in the same browser share one network pull through Web Locks and exchange the resulting delta through `BroadcastChannel`.
- **Instant startup:** each device keeps an AES-GCM-sealed snapshot of the notebook in IndexedDB. A page load is then a single incremental sync instead of a full download, no matter how large the notebook is. The snapshot key is held server-side and only handed out on authenticated responses, so a device without a valid session stores nothing but ciphertext; logging out deletes the snapshot.
- **Encryption at rest (optional):** with the `MEMO_ENC_KEY` secret set, memo text is sealed with AES-256-GCM before it reaches D1, so database dumps, backups, and console views hold only ciphertext (about 28 bytes plus base64 overhead per memo). Rows written before the key existed are sealed gradually in the background. Images are intentionally left unsealed to avoid ~33% extra storage.
- **Semantic search (on-device, optional):** a brain toggle beside the search box ranks memos by meaning instead of substring — "水果" finds the memo that only mentions 苹果和香蕉, and an English query can retrieve a Chinese memo. Everything runs in the browser: IBM Granite Embedding 97M Multilingual R2 (enhanced for 52 languages, ~123 MB q8) is downloaded from a pinned Hugging Face revision, verified against SHA-256 checksums baked into the app, and executed through same-origin WebAssembly. No memo text ever leaves the device. An immutable GitHub Release provides hash-identical files for manual import. The vector index is derived from memo content, so it is sealed with the same server-held key as the snapshot. Explicit logout deletes both the model and index; Settings → Semantic Search also offers a standalone clear action. Download, per-file export, and content-hash-matched import for offline devices live in the same panel. See `docs/embedding-model-hosting.md` for the hosting design.

## Requirements

- Node.js 20.19+, 22.13+, or 24+
- A Cloudflare account
- Wrangler authentication for remote setup and deployment

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run pages:dev
```

Set a long, random `SESSION_SECRET` in `.dev.vars` before starting the local Pages server. The app is then available at <http://localhost:8788>.

To enable content encryption at rest locally, also set `MEMO_ENC_KEY` in `.dev.vars` (64 hex characters, e.g. from `openssl rand -hex 32`). In production, set it once with `wrangler pages secret put MEMO_ENC_KEY`. **Never change the key after data exists** — sealed rows only open with the key that sealed them; a lost, missing, or rotated key makes content APIs fail closed instead of treating ciphertext as editable text.

Migration `0004_sync_integrity.sql` gives every memo an explicit `content_format`. It conservatively classifies legacy rows whose stored value begins with `enc1:` as encrypted. If an old plaintext memo literally began with those five characters, identify that row before enabling encryption and set only its `content_format` back to `plain` in D1. Do not change genuine encrypted rows.

The same migration creates a random `sync_epoch` for the database history. A newly bound D1 database is detected even if its numeric sync counter has already passed a sleeping device's old cursor. If you intentionally restore an older backup into the same D1 database, rotate the epoch once after the restore so connected clients discard snapshots from the replaced history:

```sql
UPDATE sync_counter SET sync_epoch = lower(hex(randomblob(16))) WHERE id = 1;
```

On the first local visit, the app asks you to create a passcode of 4–18 digits. The passcode hash is stored in the local D1 database and is not reset when the development server restarts. Public deployments require `APP_PASSWORD_HASH` during provisioning; the unauthenticated in-app setup endpoint is limited to loopback hosts.

## First deployment to Cloudflare

The Pages project must exist before Pages secrets can be added. Deployment-specific
identifiers stay in the local `wrangler.toml`, which is intentionally ignored by
Git. Start by copying the public template and replacing every placeholder:

```bash
cp wrangler.example.toml wrangler.toml
```

Set a private Pages project name, D1 database name and D1 `database_id` in that
file. Also set `CANONICAL_HOST` and `PRODUCTION_PAGES_HOST` to the deployment's
real hostnames. Never commit the completed file.

For a new Cloudflare deployment, use this order.

1. Install dependencies and authenticate Wrangler:

   ```bash
   npm install
   npx wrangler login
   ```

2. Create the production D1 database:

   ```bash
   npx wrangler d1 create <your-private-database-name>
   ```

   Copy the returned `database_id` and database name into the top-level
   `[[d1_databases]]` section of the ignored `wrangler.toml`. Keep the binding
   name as `DB`.

3. Apply the production migrations:

   ```bash
   npm run db:migrate:remote
   ```

4. Create the Pages project. Skip this command if the private project already
   exists in your account:

   ```bash
   npx wrangler pages project create <your-private-project-name> --production-branch main
   ```

5. Generate the production session secret. Run `openssl`, then paste its output when Wrangler prompts for the secret value:

   ```bash
   openssl rand -hex 32
   npx wrangler pages secret put SESSION_SECRET
   ```

6. Generate and store the initial passcode hash before the first public deployment:

   ```bash
   npm run hash-password -- "<your-long-numeric-passcode>"
   npx wrangler pages secret put APP_PASSWORD_HASH
   ```

   Paste the complete output of `hash-password` at the prompt.

7. Build and deploy the Pages application and its Functions:

   ```bash
   npm run deploy
   ```

Subsequent releases only need the remote migration command when new migration files exist, followed by `npm run deploy`.

### Pages static asset routing

The build intentionally contains `assets/404.html` and no root `404.html`. Cloudflare Pages therefore returns a real `404` for a missing `/assets/*` file while retaining its normal SPA fallback for application routes. `/assets/*` must remain in the `exclude` list in `public/_routes.json` so real hashed assets continue to be served directly by Pages rather than invoking Functions. Wrangler 4.110.0 currently serves this nested `404` with `Cache-Control: no-store`, but the repository deliberately leaves `Cache-Control` unset so Pages remains responsible for its status-specific cache policy.

Keep Pages' default cache headers on both the `pages.dev` hostname and the custom domain. In the custom domain's zone, remove Cache Rules that force a browser time-to-live for this Pages project, or configure them to respect existing origin headers. A zone-level Cache Rule can override the repository's `_headers` behavior, so repository checks cannot make an externally forced cache policy safe.

## Verification

Run the deterministic unit tests, the real Workers runtime + D1 migration tests, and the production build:

```bash
npm test
npm run build
```

`npm test` runs the Node unit suite first and then the Workers suite through Cloudflare's Vitest integration. The latter starts a temporary local `workerd` process and applies every migration to an isolated D1 binding.

## Passcodes, sessions, and security

- Passcodes are hashed with PBKDF2-HMAC-SHA-256 using a random 16-byte salt and 100,000 iterations. The plaintext passcode is never stored.
- Session cookies are HMAC-SHA-256 signed and set with `HttpOnly`, `Secure`, `SameSite=Lax`, and a 30-day maximum age.
- Changing the passcode from the app increments the session generation. Every other device is signed out immediately, while the current device receives a new session.
- The passcode hash and session generation live in one `auth_state` row. Initial setup uses a single-winner insert, and passcode changes use a conditional update, so concurrent setup/login/change requests cannot mint a cookie against mismatched authentication state.
- After a passcode has been created or changed in the app, the D1-stored hash takes precedence over `APP_PASSWORD_HASH`. Redeploying the code does not reset it.
- State-changing API requests with an `Origin` header are rejected when the origin does not match the app. Responses also include a restrictive Content Security Policy, clickjacking protection, MIME sniffing protection, and `noindex` directives.
- With `MEMO_ENC_KEY` set, memo content is encrypted at rest with AES-256-GCM (`enc1:` prefix in the `content` column) and decrypted only at the API boundary. The key lives in the deployment environment, so this protects the database layer (dumps, backups, the D1 console), not against someone who controls the Cloudflare account itself. Without the secret, the app runs in plaintext mode.
- The per-device IndexedDB snapshot is sealed with a random server-held key delivered only on authenticated responses; only the numeric sync cursor and an opaque random cache epoch are stored in the clear. An expired session leaves the local cache unreadable, and an explicit logout deletes it.
- `.dev.vars` contains secrets and is ignored by Git. Never commit it, session secrets, passcode hashes, or exported notebook data.
- `wrangler.toml` contains deployment-specific project, database and hostname identifiers and is ignored by Git. Only the placeholder-only `wrangler.example.toml` belongs in the repository.
- A numeric passcode is intended as a lightweight gate for a personal notebook. For a publicly discoverable or higher-risk deployment, add stronger edge access control such as Cloudflare Access or an equivalent authentication layer.

## Images and Cloudflare Free plan limits

Uploaded images are compressed in the browser to WebP, with JPEG as a fallback. The longest edge is limited to 1600 pixels and each compressed file is limited to 900KB. The encoded image data is stored in D1, so no R2 bucket is required. A memo can contain up to 9 stored images. External HTTPS image links are displayed remotely and do not consume D1 storage.

Cloudflare's current Free plan includes:

- 5 million D1 rows read per day
- 100,000 D1 rows written per day
- 5GB of total D1 storage per account
- A 500MB maximum size for each Free-plan D1 database

See Cloudflare's official [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) pages for the latest values.

Actual image capacity depends on the compressed sizes. Base64 encoding adds roughly one third to the binary file size, so a 900KB image uses about 1.2MB before database overhead. Monitor D1 storage if the notebook contains many images.
