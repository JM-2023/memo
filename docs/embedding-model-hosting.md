# Embedding model hosting — GitHub Releases

Status: **implemented** (semantic search shipped on top of it). The design
survived contact with reality with a handful of amendments, all folded into
the sections below and marked "as implemented".

Implementation map:

| Concern                          | File                                   |
| -------------------------------- | -------------------------------------- |
| Pinned manifest + mirrors        | `src/lib/modelManifest.ts`             |
| IndexedDB freeze (survives logout) | `src/lib/modelStore.ts`              |
| Mirror chain + SHA-256 verify    | `src/lib/modelLoader.ts`               |
| transformers.js wiring + self-test | `src/lib/modelRuntime.ts`            |
| Download/import/export dialog    | `src/components/ModelSettingsModal.tsx`|
| Sealed vector index (logout-wiped) | `src/lib/semanticIndex.ts`           |
| Feed integration                 | `src/hooks/useSemanticSearch.ts`, `App.tsx` |
| WASM copy + stray prune          | `vite.config.ts`                       |
| Build assertions                 | `scripts/verify-pages-output.mjs`      |
| CSP for mirrors + wasm           | `functions/_middleware.ts`             |

Scope: how the on-device semantic index obtains its embedding model
**without** storing the model on this project's Cloudflare deployment and
**without** depending on any third-party URL staying alive. This document
guarantees that the model bytes are available, verified, and permanent on
every device; the index built on top of them is documented in
`src/lib/semanticIndex.ts` (short version: embeddings are derived from memo
content, so unlike the model they are sealed with the snapshot key and wiped
on logout).

## 1. Principles

1. **The network matters only once per device.** After the first successful
   download, every model byte is frozen into IndexedDB on that device and the
   feature must keep working fully offline, forever — even if every mirror
   later disappears.
2. **Every byte is pinned.** The app ships a manifest with the SHA-256 and
   size of each file. A download that does not hash-match is discarded no
   matter which mirror served it. "The link is alive but the content changed"
   is a failure, not an update.
3. **Fail closed, degrade open.** If the model cannot be obtained, semantic
   features show an explicit "model unavailable" state with Retry and a manual
   file import. The rest of the app is untouched. There is never a silent
   network fetch to a host the manifest does not list.
4. **The primary mirror is ours.** GitHub release assets on a repository we
   control are the primary source. Hugging Face is a pinned fallback, never
   the primary. Link rot on the primary is therefore something only we can
   cause.

## 2. Architecture overview

```
MODEL_MANIFEST (in-repo constant: files, sizes, sha256, mirrors, version)
      │
      ▼
ensureModelReady()  ── per file: IndexedDB hit? ──► done
      │                        │ miss
      │                        ▼
      │              try mirrors in order:
      │                1. GitHub release asset   (ours)
      │                2. Hugging Face, pinned   (fallback)
      │              verify sha256 → write to IndexedDB
      ▼
transformers.js pipeline
  env.customCache  = adapter over the IndexedDB store (read-only)
  env.allowRemoteModels = false      → a cache miss throws; it never
                                       silently fetches huggingface.co
  onnxruntime WASM served same-origin → no hidden CDN dependency
```

Two independent "links" exist and both must be self-controlled:

- the **model files** (this document's main subject), and
- the **onnxruntime-web `.wasm` runtime**, which transformers.js loads at
  inference time and which by default comes from **jsDelivr's CDN** — a hidden
  third-party link that must be eliminated (§6.3).

## 3. Model choice and files

Recommended: **`Xenova/bge-small-zh-v1.5`** (ONNX conversion of BAAI's
`bge-small-zh-v1.5`, MIT-licensed) at int8 quantization — Chinese-first with
acceptable English, ~24 MB quantized, 512-token input window, well within
mobile WASM performance for a few thousand memos.

Files the transformers.js `feature-extraction` pipeline requests:

| Purpose        | Request path (as the pipeline asks for it) | Release asset name (flat) |
| -------------- | ------------------------------------------ | ------------------------- |
| Model config   | `config.json`                              | `config.json`             |
| Tokenizer      | `tokenizer.json`                           | `tokenizer.json`          |
| Tokenizer conf | `tokenizer_config.json`                    | `tokenizer_config.json`   |
| Weights (q8)   | `onnx/model_quantized.onnx`                | `model_quantized.onnx`    |

GitHub release assets cannot contain `/` in their names, so asset names are
flattened; the manifest maps flat asset names back to request paths.

As implemented: a live network audit against `@huggingface/transformers`
4.2.0 confirmed exactly these four requests and nothing else
(`special_tokens_map.json` is never asked for). If a future library upgrade
requests an additional small JSON, add it to the release and the manifest
rather than letting it fall through to the network.

Alternative if English recall matters more: `Xenova/multilingual-e5-small`
(~4–5× larger quantized). Everything in this document is model-agnostic — the
manifest decides; switching models is a new release tag plus a manifest edit.

Usage notes (for the index feature, recorded here so they are not lost):

- BGE models: pool with `cls`, `normalize: true`.
- For query→memo retrieval, prefix the *query only* with
  `为这个句子生成表示以用于检索相关文章：`; memo→memo similarity uses no prefix.
- Memos can reach 40k characters; anything past the 512-token window must be
  chunked by the index design, not truncated silently.

## 4. Publishing runbook (one-time per model version)

Requires: a **public** GitHub repository. Anonymous browser `fetch()` cannot
read private-repo release assets. This project's `JM-2023/memo` is public
(verified via anonymous API), so it hosts its own model releases; a private
fork would need a dedicated public repository (model weights are public
artifacts; nothing private is disclosed).

```bash
# 1. Download the pinned revision from Hugging Face.
#    Pin a commit SHA, never `main` — `main` can change under you.
REV=<hf-commit-sha>
BASE="https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/${REV}"
curl -fLO "${BASE}/config.json"
curl -fLO "${BASE}/tokenizer.json"
curl -fLO "${BASE}/tokenizer_config.json"
curl -fL -o model_quantized.onnx "${BASE}/onnx/model_quantized.onnx"

# 2. Record hashes and exact sizes for the manifest.
shasum -a 256 config.json tokenizer.json tokenizer_config.json model_quantized.onnx
wc -c    config.json tokenizer.json tokenizer_config.json model_quantized.onnx

# 3. Publish an immutable release. `--latest=false` keeps model releases from
#    shadowing app releases if they share a repository.
gh release create model-bge-small-zh-q8-r1 \
  --repo JM-2023/memo --latest=false \
  --title "Embedding model: bge-small-zh-v1.5 q8 (r1)" \
  --notes "ONNX int8 of BAAI/bge-small-zh-v1.5 via Xenova (MIT). Pinned HF revision: ${REV}. Immutable: never edit assets on this tag; publish r2 instead." \
  config.json tokenizer.json tokenizer_config.json model_quantized.onnx
```

No `gh`? The web UI works identically: repository → Releases → "Draft a new
release" → tag `model-bge-small-zh-q8-r1` → attach the four files → uncheck
"Set as the latest release" → publish. Until the release exists the app
simply uses the Hugging Face fallback (verified end-to-end), so publishing
is an availability upgrade, not a blocker.

Rules:

- **Tags are immutable by policy.** Never re-upload or edit assets on a
  published `model-*` tag; any change — even re-quantizing the same model —
  is a new tag (`…-r2`) and a manifest update. Client-side hash pinning
  enforces this even if the policy is violated.
- Include the model's license (MIT for BGE) in the release notes.

### 4.1 Verify CORS before relying on it

GitHub serves release-asset downloads through a redirect; **both hops** must
carry `access-control-allow-origin` for a browser `fetch()` to succeed. Verify
once at publish time from a terminal:

```bash
curl -sI -H "Origin: https://<your-app-host>" \
  "https://github.com/OWNER/REPO/releases/download/model-bge-small-zh-q8-r1/model_quantized.onnx" \
  | grep -iE '^(HTTP|location|access-control)'
# Then repeat against the reported `location:` URL and expect HTTP 200,
# `access-control-allow-origin: *`, and a content-length.
```

Observed live: while the release does **not** exist, GitHub answers the URL
with a 404 that carries no CORS headers, so the browser console shows a CORS
error rather than a 404 for the primary mirror. That is the expected shape of
"primary missing" — the loader records it and falls through to Hugging Face,
which is exactly how the feature ran end-to-end before the release was
published.

If GitHub ever drops CORS on this path (unlikely but out of our control), the
mirror list makes the fix a one-line change — e.g. promote the Hugging Face
mirror or move the assets to any static host. Do not add a proxy through the
app's own Functions as a workaround; that reintroduces the Cloudflare
hosting this design exists to avoid.

## 5. Client architecture

Three new modules under `src/lib/`, no new heavy dependencies besides
`@huggingface/transformers` itself.

### 5.1 `modelManifest.ts` — the single source of truth

```ts
export interface ModelFileSpec {
  /** Flat asset name in the GitHub release. */
  asset: string;
  /** Path the pipeline requests; also the cache-adapter match suffix. */
  requestPath: string;
  /** Exact size in bytes, from `wc -c` at publish time. */
  bytes: number;
  /** Lowercase hex SHA-256, from `shasum` at publish time. */
  sha256: string;
}

export interface ModelManifest {
  /** transformers.js model id, e.g. "Xenova/bge-small-zh-v1.5". */
  id: string;
  /** Pinned HF revision for the fallback mirror (commit SHA, not "main"). */
  hfRevision: string;
  /** Bump on ANY change; the embedding index stores and keys off this. */
  version: string; // e.g. "bge-small-zh-q8-r1"
  releaseTag: string; // e.g. "model-bge-small-zh-q8-r1"
  files: ModelFileSpec[];
}

/** Ordered: first success wins. Ours first, pinned third party as fallback. */
export const MODEL_MIRRORS: ReadonlyArray<
  (m: ModelManifest, f: ModelFileSpec) => string
> = [
  (m, f) =>
    `https://github.com/OWNER/REPO/releases/download/${m.releaseTag}/${f.asset}`,
  (m, f) => `https://huggingface.co/${m.id}/resolve/${m.hfRevision}/${f.requestPath}`,
];
```

### 5.2 `modelStore.ts` — IndexedDB freeze

- A **separate database** from the snapshot cache (e.g. `memo-model`), one
  object store, key `${manifest.version}/${file.requestPath}`, value
  `ArrayBuffer` plus `{ sha256, bytes, storedAt }`.
- On open, delete entries belonging to any other manifest version — one model
  at a time keeps worst-case storage ≈ one model.
- **Not sealed, and survives logout.** Model weights are public content, not
  user data; encrypting them buys nothing and re-downloading 24 MB on every
  logout is pure cost. Add an explicit exclusion (with this rationale as a
  comment) wherever `logoutCleanup.ts` enumerates what to wipe, so the wipe
  stays intentional rather than accidental.
- After the first successful store, call `navigator.storage.persist()` (if
  not already requested elsewhere) to reduce eviction risk.

### 5.3 `modelLoader.ts` — mirror chain + verification

`ensureModelReady(onProgress): Promise<void>`, sequential over
`manifest.files`:

1. Store hit → done (hash was verified at write time; do not re-hash 24 MB on
   every startup).
2. Miss → for each mirror in order: `fetch`, stream to an `ArrayBuffer` with
   progress callbacks (`content-length` is present on both mirrors; the big
   file dominates, so per-byte progress ≈ overall progress).
3. Verify `crypto.subtle.digest("SHA-256", buf)` and the byte length against
   the manifest. Mismatch → discard, log a console warning naming the mirror
   (possible tamper or truncation), try the next mirror.
4. All mirrors failed → reject with a typed error carrying per-mirror causes;
   the UI renders it as "model unavailable · Retry · Import from file".

Deliberate non-features: no resume/range requests (25 MB retries fine), no
auto-update polling (model changes are deliberate releases), no concurrent
downloads (simpler progress, the ONNX dominates anyway).

### 5.4 transformers.js wiring

Pin an **exact** version of `@huggingface/transformers` (v3+, no caret): the
copied WASM runtime (§6.3) must stay in lockstep with the JS that requests it.

```ts
import { env, pipeline } from "@huggingface/transformers";

env.useBrowserCache = false; // our IndexedDB store is the only cache
env.useCustomCache = true;
env.customCache = {
  // Keys arrive as URL-or-path strings; match on requestPath suffix so any
  // host/revision prefix the library composes is irrelevant.
  match: async (key: string) => {
    const file = fileByRequestPathSuffix(manifest, key);
    if (!file) return undefined;
    const bytes = await modelStore.get(manifest.version, file.requestPath);
    return bytes ? new Response(bytes) : undefined;
  },
  put: async () => {}, // pre-populated by ensureModelReady; nothing to do
};
env.allowRemoteModels = false; // a cache miss must throw, never fetch HF
env.allowLocalModels = true;
env.localModelPath = "/assets/model-cache-miss/"; // the real-404 zone

await ensureModelReady(onProgress);
const embed = await pipeline("feature-extraction", manifest.id, {
  device: "wasm",
  dtype: "q8"
});
```

**v4 amendment (as implemented):** the original plan set both `allow*` flags
false; transformers.js v4 rejects that combination as an invalid
configuration on every `getModelFile` call. Local loading therefore stays
enabled but aimed at `/assets/model-cache-miss/` — `/assets/*` is the one
zone of this deployment that answers a genuine 404 (via
`public/assets/404.html`) instead of the SPA fallback's `200 index.html`.
The distinction is not cosmetic: a 404 makes the library treat the probe as
"not found locally" (so optional files resolve to null and required misses
throw), whereas the SPA fallback would feed HTML to the ONNX runtime as if
it were a model file. Cache lookups still run before either allow-flag
matters, so on a frozen device none of these paths is ever taken.

## 6. Integration requirements

### 6.1 Opt-in download, never on startup

This app is startup-latency-obsessed; keep it that way. The model downloads
only when the user explicitly enables semantic features in Settings (button
shows the size: "Download model (~24 MB)"), or taps Retry later. Progress in
the settings row; the feed never blocks on any of this.

### 6.2 The escape hatch: manual import/export

In Settings, next to the model status:

- **Import from file** — a file input accepting the four files (or just the
  `.onnx` when the small JSONs are already cached). Bytes are verified against
  the same manifest hashes and written to the same store. This is the
  guarantee that total link rot can strand a *new* device only until you copy
  the files from any old device, a backup, or a local clone of the release.
- **Export model files** (nice-to-have) — writes the cached files back out,
  making the device-to-device copy first-class.

Because import verifies the same SHA-256, a corrupted or wrong file cannot be
imported by accident.

### 6.3 Self-host the onnxruntime WASM — the hidden third-party link

transformers.js delegates inference to onnxruntime-web, which loads a
`.wasm`/`.mjs` loader pair at runtime — **by default from jsDelivr's CDN**.
Left unconfigured, the "self-hosted" feature still has a third-party link that
can rot. As implemented (onnxruntime-web 1.26):

- The runtime picks its build at load time: **`.jspi`** where the browser
  ships WebAssembly JSPI, **`.asyncify`** otherwise (what Chromium chose in
  live testing), plain as the legacy path — so `vite.config.ts` copies all
  three `.mjs`/`.wasm` pairs into
  `dist/assets/ort/<onnxruntime-web version>/`. The **`.jsep`** (WebGPU)
  build stays excluded: `device` is pinned to `"wasm"`, and at 26.1 MB that
  file exceeds Pages' 25 MiB per-file limit anyway.
- The path lives under `/assets/` (real 404s for misses, no `_routes.json`
  change needed) and embeds the ort package version, injected into the app
  as `__ORT_WASM_BASE__` via Vite `define` — a dependency bump can never
  pair stale cached WASM with newer JS.
- `wasmPaths` is set to that base as a **string**, not the `{wasm, mjs}`
  object form: the object form routes through v4's blob-URL factory cache,
  which would force `blob:` into `script-src`. The string form keeps every
  import same-origin, so CSP only needs `'wasm-unsafe-eval'`.
- `numThreads = 1` — multithreading needs cross-origin isolation
  (COOP/COEP), and a site-wide COEP header would break the
  external-image-link feature. Single-threaded q8 inference measured fine
  for incremental embedding of short memos.
- onnxruntime-web's ESM also references its sibling builds through
  `new URL(…, import.meta.url)`, which made Rollup emit a stray hashed
  23 MB asyncify copy into `dist/assets/`. The copy plugin deletes every
  ORT artifact outside `assets/ort/`, and `scripts/verify-pages-output.mjs`
  asserts all six copies exist, that no stray remains, that nothing in the
  build reaches 25 MiB, and that no `.onnx` ever ships.

### 6.4 Index invalidation

The embedding index stores `manifest.version` with its vectors. On mismatch
(model upgraded), rebuild in the background and keep serving the old index
until the rebuild completes. Publishing a new model release without bumping
`version` is a bug; hashes make it impossible to do accidentally.

## 7. Verification checklist (before shipping)

- **Network audit:** with the feature active on a fresh profile, the network
  tab shows only: same-origin requests, `github.com` +
  `objects.githubusercontent.com` (first activation only), and
  `huggingface.co` only while the GitHub mirror is deliberately blocked.
  Anything from `cdn.jsdelivr.net` means §6.3 is misconfigured; anything from
  `huggingface.co` while GitHub is healthy means §5.4's flags or the adapter
  are wrong.
- **Offline test:** activate once, then reload and use semantic search in
  airplane mode. Must work.
- **Failover test:** block `github.com` in DevTools request blocking → first
  activation succeeds via Hugging Face.
- **Tamper test:** corrupt one manifest hash in a dev build → that mirror's
  download is rejected with the warning, the next mirror is tried, and the
  final state is the readable error UI, not a broken pipeline.
- **Logout test:** logout wipes the snapshot as today but leaves the model
  store; re-login re-enables semantic features without a download.
- **Import test:** clear site data, then enable the feature using only
  "Import from file" with locally saved copies. Zero network requests.
- **Unit tests** (Vitest, following the existing suite's conventions):
  manifest hash/size verification, adapter suffix matching, mirror failover
  order, and version-mismatch purge in the store.

## 8. Failure modes → responses

| Failure                                   | Response                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Primary mirror 404/network error          | Next mirror; log which mirror failed.                                    |
| Hash or size mismatch from any mirror     | Discard, warn (named mirror), next mirror. Never store unverified bytes. |
| All mirrors down (new device)             | "Model unavailable · Retry · Import from file". App otherwise unaffected.|
| All mirrors down (initialized device)     | Invisible. Store hit; nothing fetches.                                   |
| IndexedDB write fails (quota)             | Keep bytes in memory for the session; warn; retry persisting next run.   |
| GitHub drops CORS on release downloads    | Promote HF mirror / move assets; one manifest edit. (§4.1)               |
| onnxruntime-web version bump              | Same-origin WASM copy updates automatically at build; re-run audit.      |

## 9. Non-goals

- No R2, no Workers AI, no proxying model bytes through Pages Functions —
  the model never touches the Cloudflare deployment.
- No automatic model updates; new models are deliberate manifest + release
  changes.
- No encryption of model files; they are public artifacts.
- No service worker; IndexedDB plus the custom cache adapter covers offline.
