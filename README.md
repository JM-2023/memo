# MEMO — Self-hosted flomo-style notes on Cloudflare

MEMO is a personal, single-owner note app built with Cloudflare Pages, Pages Functions, and D1. It is designed for typical personal use within Cloudflare's Free plan and does not require R2. The interface uses the same Liquid Glass design language as `project-manager-pwa`, supports light and dark themes, and is available in English and Simplified Chinese. English is the default; the language can be changed in Settings and is remembered by the browser.

## Features

- **Passcode gate:** protect the notebook with a 4-digit passcode. The salted PBKDF2 hash is stored in D1, and authenticated sessions use an HMAC-signed cookie. Data and stored-image APIs return `401` until the session is authenticated.
- **Dashboard and statistics:** browse memo, tag, and day totals; weekly, monthly, and yearly memo and character counts; a month-by-month GitHub-style heatmap; and a detailed yearly statistics view with monthly activity, weekday and time-of-day distributions, and streaks.
- **Hierarchical tags:** organize notes with paths such as `#parent/child`, navigate through breadcrumb segments, and pin, rename, or remove tags. Tag changes are rewritten in the affected memos on the server and then synchronized to other devices.
- **Writing and media:** search and sort by created or edited time, use tag autocomplete, and add images by selecting, pasting, or dragging files. External image links in Markdown or direct image URLs are previewed without using D1 storage.
- **Memo actions:** pin, edit, copy, or delete a memo, and open images in a lightbox.
- **Recycle bin:** normal deletion keeps the memo and its attachments available for restoration. Permanent deletion and emptying the recycle bin remove the memo rows and images, leaving only small tombstones so other devices can synchronize the deletion.
- **Incremental synchronization:** every synchronized memo or tag mutation receives a globally increasing `seq`. Clients pull changes with `GET /api/sync?since=N` after local writes, when the window regains focus or visibility, and every 60 seconds. `BroadcastChannel` keeps tabs in the same browser in sync immediately.

## Requirements

- Node.js 20 or newer
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

On the first visit, the app asks you to create a 4-digit passcode. The passcode hash is stored in the local D1 database and is not reset when the development server restarts.

## First deployment to Cloudflare

The Pages project must exist before Pages secrets can be added. For a new Cloudflare deployment, use this order.

1. Install dependencies and authenticate Wrangler:

   ```bash
   npm install
   npx wrangler login
   ```

2. Create the D1 database:

   ```bash
   npx wrangler d1 create your-d1-database
   ```

   Copy the returned `database_id` into the `[[d1_databases]]` section of `wrangler.toml`. Keep the binding name as `DB` and the database name as `flomo`.

3. Apply the production migrations:

   ```bash
   npm run db:migrate:remote
   ```

4. Create the Pages project. Skip this command if `memo` already exists in your account:

   ```bash
   npx wrangler pages project create your-pages-project --production-branch main
   ```

5. Generate and store a strong session secret. Run the first command, then paste its output when Wrangler prompts for the secret value:

   ```bash
   openssl rand -hex 32
   npx wrangler pages secret put SESSION_SECRET --project-name your-pages-project
   ```

6. Optionally pre-seed the 4-digit passcode. Without this secret, the first production visit shows the create-passcode screen:

   ```bash
   npm run hash-password -- "1234"
   npx wrangler pages secret put APP_PASSWORD_HASH --project-name your-pages-project
   ```

   Paste the complete output of `hash-password` when Wrangler prompts for the secret value.

7. Build and deploy the Pages application and its Functions:

   ```bash
   npm run deploy
   ```

Subsequent releases only need the migrations step when new migration files exist, followed by `npm run deploy`.

## Passcodes, sessions, and security

- Passcodes are hashed with PBKDF2-HMAC-SHA-256 using a random 16-byte salt and 100,000 iterations. The plaintext passcode is never stored.
- Session cookies are HMAC-SHA-256 signed and set with `HttpOnly`, `Secure`, `SameSite=Lax`, and a 30-day maximum age.
- Changing the passcode from the app increments the session generation. Every other device is signed out immediately, while the current device receives a new session.
- After a passcode has been created or changed in the app, the D1-stored hash takes precedence over `APP_PASSWORD_HASH`. Redeploying the code does not reset it.
- State-changing API requests with an `Origin` header are rejected when the origin does not match the app. Responses also include a restrictive Content Security Policy, clickjacking protection, MIME sniffing protection, and `noindex` directives.
- `.dev.vars` contains secrets and is ignored by Git. Never commit it, session secrets, passcode hashes, or exported notebook data.
- A 4-digit passcode is intended as a lightweight gate for a personal notebook. For a publicly discoverable or higher-risk deployment, add stronger edge access control such as Cloudflare Access or an equivalent authentication layer.

## Images and Cloudflare Free plan limits

Uploaded images are compressed in the browser to WebP, with JPEG as a fallback. The longest edge is limited to 1600 pixels and each compressed file is limited to 900KB. The encoded image data is stored in D1, so no R2 bucket is required. A memo can contain up to 9 stored images. External HTTPS image links are displayed remotely and do not consume D1 storage.

Cloudflare's current Free plan includes:

- 5 million D1 rows read per day
- 100,000 D1 rows written per day
- 5GB of total D1 storage per account
- A 500MB maximum size for each Free-plan D1 database

See Cloudflare's official [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) pages for the latest values.

Actual image capacity depends on the compressed sizes. Base64 encoding adds roughly one third to the binary file size, so a 900KB image uses about 1.2MB before database overhead. Monitor D1 storage if the notebook contains many images.
