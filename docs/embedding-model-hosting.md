# Embedding model hosting — pinned download and release archive

Status: **implemented** (semantic search shipped on top of it). The design
survived contact with reality with a handful of amendments, all folded into
the sections below and marked "as implemented".

Implementation map:

| Concern                          | File                                   |
| -------------------------------- | -------------------------------------- |
| Pinned manifest + mirrors        | `src/lib/modelManifest.ts`             |
| IndexedDB freeze (logout-cleared) | `src/lib/modelStore.ts`               |
| Mirror chain + SHA-256 verify    | `src/lib/modelLoader.ts`               |
| transformers.js wiring + self-test | `src/lib/modelRuntime.ts`            |
| Download/import/export dialog    | `src/components/ModelSettingsModal.tsx`|
| Sealed vector index (logout-wiped) | `src/lib/semanticIndex.ts`           |
| Feed integration                 | `src/hooks/useSemanticSearch.ts`, `App.tsx` |
| WASM copy + stray prune          | `vite.config.ts`                       |
| Build assertions                 | `scripts/verify-pages-output.mjs`      |
| CSP for mirrors + wasm           | `functions/_middleware.ts`             |

Scope: how the on-device semantic index obtains its embedding model
**without** storing the model on this project's Cloudflare deployment, using
a pinned automatic source and an owner-controlled manual archive. This
document guarantees that accepted bytes are verified and remain available
offline until the user clears local semantic data or explicitly logs out; the
index built on top of them is documented in `src/lib/semanticIndex.ts` (short
version: embeddings are derived from memo content, so they are sealed with the
snapshot key; both stores are wiped on logout).

## 1. Principles

1. **The network matters only while the model is absent.** After a successful
   download, every model byte is frozen into IndexedDB and the feature keeps
   working fully offline. An explicit logout or the panel's Clear Model action
   deliberately removes that freeze, so a later activation downloads or
   imports it again.
2. **Every byte is pinned.** The app ships a manifest with the SHA-256 and
   size of each file. A download that does not hash-match is discarded no
   matter which mirror served it. "The link is alive but the content changed"
   is a failure, not an update.
3. **Fail closed, degrade open.** If the model cannot be obtained, semantic
   features show an explicit "model unavailable" state with Retry and a manual
   file import. The rest of the app is untouched. There is never a silent
   network fetch to a host the manifest does not list.
4. **The automatic source must pass browser CORS.** The pinned Hugging Face
   revision is primary because it passes the live browser path. Our immutable
   GitHub release keeps hash-identical files under our control for manual
   import and remains a best-effort secondary; its current redirect chain does
   not expose CORS headers (§4.1).

## 2. Architecture overview

```
MODEL_MANIFEST (in-repo constant: files, sizes, sha256, mirrors, version)
      │
      ▼
ensureModelReady()  ── per file: IndexedDB hit? ──► done
      │                        │ miss
      │                        ▼
      │              try mirrors in order:
      │                1. Hugging Face, pinned   (CORS-capable)
      │                2. GitHub release asset   (best effort)
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

Selected: **`onnx-community/granite-embedding-97m-multilingual-r2-ONNX`**
(ONNX conversion of IBM Granite Embedding 97M Multilingual R2, Apache 2.0)
at int8 quantization. It produces 384-dimensional vectors, supports 200+
languages through its pretraining corpus, and has retrieval-pair and
cross-lingual training for 52 languages including Chinese, English, Japanese,
Korean, French, German, Spanish, Arabic, Hindi, and many others. The official
ONNX repository is explicitly compatible with Transformers.js.

The q8 weights plus tokenizer and configs total 123,173,845 bytes (~123 MB).
That is substantially larger than the former 24 MB Chinese-first BGE model,
but remains a one-time download within each signed-in local lifecycle and is
the practical quality/size point for multilingual browser search. The April
2026 IBM model card reports
59.6 on Multilingual MTEB Retrieval for the 97M R2 model versus 50.9 for
`multilingual-e5-small`; the 97M model is also designed for latency-sensitive
edge deployment. Larger candidates were rejected for this app: EmbeddingGemma
needs about 198 MB for q4 weights alone, while Qwen3-Embedding-0.6B is a 600M
parameter decoder model. Jina Embeddings v5 Nano is smaller than its full
model but uses a non-commercial license and custom model code.

Files the transformers.js `feature-extraction` pipeline requests:

| Purpose        | Request path (as the pipeline asks for it) | Release asset name (flat) |
| -------------- | ------------------------------------------ | ------------------------- |
| Model config   | `config.json`                              | `config.json`             |
| Tokenizer      | `tokenizer.json`                           | `tokenizer.json`          |
| Tokenizer conf | `tokenizer_config.json`                    | `tokenizer_config.json`   |
| Weights (q8)   | `onnx/model_quantized.onnx`                | `model_quantized.onnx`    |

GitHub release assets cannot contain `/` in their names, so asset names are
flattened; the manifest maps flat asset names back to request paths.

As implemented: a local frozen-cache audit against `@huggingface/transformers`
4.2.0 confirmed exactly these four requests and nothing else
(`special_tokens_map.json` is never asked for). If a future library upgrade
requests an additional small JSON, add it to the release and the manifest
rather than letting it fall through to the network.

Usage notes (for the index feature, recorded here so they are not lost):

- Granite R2 uses `cls` pooling and normalized vectors.
- Query and document text share one symmetric embedding space. Do not add the
  former BGE Chinese query prefix; it harms multilingual input.
- Although the model supports a 32,768-token context, the browser index keeps
  400-character overlapping chunks. This keeps single-threaded WASM work
  responsive and lets the best local passage represent a long memo.

## 4. Publishing runbook (one-time per model version)

Requires: a **public** GitHub repository. Anonymous browser `fetch()` cannot
read private-repo release assets. This project's `JM-2023/memo` is public
(verified via anonymous API), so it hosts its own model releases; a private
fork would need a dedicated public repository (model weights are public
artifacts; nothing private is disclosed).

```bash
# 1. Download the pinned revision from Hugging Face.
#    Pin a commit SHA, never `main` — `main` can change under you.
REV=536a9f241cb3f02a9c5995a1e708c784bd274859
BASE="https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX/resolve/${REV}"
curl -fLO "${BASE}/config.json"
curl -fLO "${BASE}/tokenizer.json"
curl -fLO "${BASE}/tokenizer_config.json"
curl -fL -o model_quantized.onnx "${BASE}/onnx/model_quantized.onnx"

# 2. Record hashes and exact sizes for the manifest.
shasum -a 256 config.json tokenizer.json tokenizer_config.json model_quantized.onnx
wc -c    config.json tokenizer.json tokenizer_config.json model_quantized.onnx

# 3. Publish an immutable release. `--latest=false` keeps model releases from
#    shadowing app releases if they share a repository.
gh release create model-granite-embedding-97m-multilingual-r2-q8-r1 \
  --repo JM-2023/memo --latest=false \
  --title "Embedding model: Granite 97M Multilingual R2 q8 (r1)" \
  --notes "ONNX int8 of IBM Granite Embedding 97M Multilingual R2 via ONNX Community (Apache-2.0). Pinned HF revision: ${REV}. Immutable: never edit assets on this tag; publish r2 instead." \
  config.json tokenizer.json tokenizer_config.json model_quantized.onnx
```

No `gh`? The web UI works identically: repository → Releases → "Draft a new
release" → tag `model-granite-embedding-97m-multilingual-r2-q8-r1` → attach
the four files → uncheck
"Set as the latest release" → publish. The app uses the pinned Hugging Face
revision for automatic download; publishing creates an immutable owner-held
archive and a manual-import path.

Rules:

- **Tags are immutable by policy.** Never re-upload or edit assets on a
  published `model-*` tag; any change — even re-quantizing the same model —
  is a new tag (`…-r2`) and a manifest update. Client-side hash pinning
  enforces this even if the policy is violated.
- Include the model's Apache 2.0 license and IBM/ONNX Community attribution in
  the release notes.

### 4.1 Verify CORS before relying on it

GitHub serves release-asset downloads through a redirect; **both hops** must
carry `access-control-allow-origin` for a browser `fetch()` to succeed. Verify
once at publish time from a terminal before putting this URL ahead of a known
CORS-capable source:

```bash
curl -sI -H "Origin: https://<your-app-host>" \
  "https://github.com/OWNER/REPO/releases/download/model-granite-embedding-97m-multilingual-r2-q8-r1/model_quantized.onnx" \
  | rg -i '^(HTTP|location|access-control)'
# Then repeat against the reported `location:` URL. A usable result has HTTP
# 200, `access-control-allow-origin: *`, and a content-length.
```

Observed live on 2026-08-15 after publishing
`model-granite-embedding-97m-multilingual-r2-q8-r1`: the first hop returned
HTTP 302 and the signed asset hop returned HTTP 200 with
`content-length: 97858099`, but neither response carried
`access-control-allow-origin`. GitHub is therefore kept behind the pinned
Hugging Face URL and treated as a manual-import archive, not a
browser-reliable automatic source. Do not add a proxy through the app's own
Functions as a workaround; that would reintroduce the Cloudflare hosting this
design exists to avoid.

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
  /** transformers.js model id, e.g. the pinned Granite ONNX repository. */
  id: string;
  /** Pinned HF revision for the primary mirror (commit SHA, not "main"). */
  hfRevision: string;
  /** Bump on ANY change; the embedding index stores and keys off this. */
  version: string; // e.g. "granite-embedding-97m-multilingual-r2-q8-r1"
  releaseTag: string; // e.g. "model-granite-embedding-97m-multilingual-r2-q8-r1"
  files: ModelFileSpec[];
}

/** Ordered: first success wins. Browser-valid pinned source first. */
export const MODEL_MIRRORS: ReadonlyArray<
  (m: ModelManifest, f: ModelFileSpec) => string
> = [
  (m, f) => `https://huggingface.co/${m.id}/resolve/${m.hfRevision}/${f.requestPath}`,
  (m, f) =>
    `https://github.com/OWNER/REPO/releases/download/${m.releaseTag}/${f.asset}`,
];
```

### 5.2 `modelStore.ts` — IndexedDB freeze

- A **separate database** from the snapshot cache (e.g. `memo-model`), one
  object store, key `${manifest.version}/${file.requestPath}`, value
  `ArrayBuffer` plus `{ sha256, bytes, storedAt }`.
- On open, delete entries belonging to any other manifest version — one model
  at a time keeps worst-case storage ≈ one model.
- **Not sealed, but cleared deliberately.** Model weights are public content,
  so encrypting them buys nothing. Explicit logout and Settings → Semantic
  Search → Clear Model both delete the database to make clearing this device
  predictable; the latter also deletes the sealed semantic index and disposes
  the active ONNX runtime.
- After the first successful store, call `navigator.storage.persist()` (if
  not already requested elsewhere) to reduce eviction risk.

### 5.3 `modelLoader.ts` — mirror chain + verification

`ensureModelReady(onProgress): Promise<void>`, sequential over
`manifest.files`:

1. Store hit → done (hash was verified at write time; do not re-hash 123 MB on
   every startup).
2. Miss → for each mirror in order: `fetch`, stream to an `ArrayBuffer` with
   progress callbacks (`content-length` is used where supplied; the big file
   dominates, so per-byte progress ≈ overall progress). Opening the response
   and every body read have a 30-second inactivity deadline; a stalled mirror
   is aborted before the next source is tried.
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
and adjacent metadata show "Download Model" and "About 123 MB"), or taps
Retry Download later. The panel reports downloaded bytes, Transformers.js
aggregate model-loading bytes, real runtime/self-test stages, completed index
memos, and scanned query rows. None of these values is advanced by a timer.
Clicking the Brain while any semantic work remains opens this progress monitor
instead of disabling the feature; the feed remains usable throughout. When a
Brain-toggle request discovers a missing model, that intent is remembered:
successful download and self-test begin indexing without requiring a second
toggle click.

### 6.2 The escape hatch: manual import/export

In Settings, next to the model status:

- **Import from file** — a file input accepting the four files (or just the
  `.onnx` when the small JSONs are already cached). Bytes are verified against
  the same manifest hashes and written to the same store. This is the
  guarantee that total link rot can strand a *new* device only until you copy
  the files from any old device, a backup, or a local clone of the release.
- **Export model files** (nice-to-have) — writes the cached files back out,
  making the device-to-device copy first-class.
- **Clear Model** — after an inline confirmation, disposes the active runtime
  and deletes both the public model files and the sealed semantic index. The
  main semantic-search toggle turns off immediately.

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
  external-image-link feature. `wasm.proxy = true` moves that one inference
  thread into onnxruntime-web's proxy Worker, keeping React and the settings
  panel on the main thread while still capping inference at one CPU thread.
- onnxruntime-web's ESM also references its sibling builds through
  `new URL(…, import.meta.url)`, which made Rollup emit a stray hashed
  23 MB asyncify copy into `dist/assets/`. The copy plugin deletes every
  ORT artifact outside `assets/ort/`, and `scripts/verify-pages-output.mjs`
  asserts all six copies exist, that no stray remains, that nothing in the
  build reaches 25 MiB, and that no `.onnx` ever ships.

### 6.4 Index invalidation

The embedding index stores `manifest.version` with its vectors. On mismatch
(model upgraded), the old index is rejected and rebuilt in the background.
Publishing a new model release without bumping `version` is a bug; hashes make
it impossible to do accidentally. Each row also stores a compact fingerprint
of the exact text windows embedded, plus its chunk position and count. When a
memo timestamp changes, that distinguishes attachment-only edits from text
edits without re-embedding unchanged text, and it lets the planner reject
incomplete memo rows. Image-only memos are deliberately settled with zero
vector rows.

### 6.5 First-build latency and hybrid retrieval

Transformers.js pads every feature-extraction batch to its longest input. The
indexer therefore groups the exact same memo chunks by approximate length into
eight-input batches before inference, then restores deterministic memo/chunk
order in the stored index. This removes padding-only attention work and keeps
batch latency and memory peaks bounded without changing text windows, weights,
pooling, normalization, or the similarity threshold. Model startup and
sealed-index loading also run in parallel.

The indexer publishes the first searchable partial index quickly, checkpoints
larger builds every 256 completed rows, and publishes the final deterministic
order. Intermediate views share one preallocated append-only vector buffer, so
progressive search stays linear instead of recopying the whole accumulated
index after every eight-text batch. Query inference is serialized through the
same ONNX session and its vector is reused as later checkpoints arrive, so
semantic matches can appear before the full first build is finished. Literal
keyword/phrase matching remains active throughout and after the build: final
results are the union of both paths, with keyword hits in the high-confidence
tier and semantic-only hits ranked beneath them.

Tag, calendar day, statistics drilldown, and structured Filters form one
intersection before retrieval. The same scoped memo IDs gate semantic dot
products, so a Tag + Filter search cannot surface or spend scoring work on an
out-of-view memo. Query ranking itself runs in 256-row slices with a browser
scheduler yield between slices. Its progress is observable in the panel, and
large indexes cannot monopolize the main thread.

## 7. Verification checklist (before shipping)

- **Network audit:** with the feature active on a fresh profile, the network
  tab shows only same-origin requests plus the pinned `huggingface.co` path on
  first activation. Anything from `cdn.jsdelivr.net` means §6.3 is
  misconfigured; a GitHub request during a healthy HF download means the
  primary failed verification or transport.
- **Offline test:** activate once, then reload and use semantic search in
  airplane mode. Must work.
- **Failure-path test:** block `huggingface.co` in DevTools request blocking →
  the best-effort GitHub attempt fails readably under current CORS behavior,
  and the dialog offers Retry and file import.
- **Tamper test:** corrupt one manifest hash in a dev build → that mirror's
  download is rejected with the warning, the next mirror is tried, and the
  final state is the readable error UI, not a broken pipeline.
- **Logout test:** logout wipes the snapshot, sealed vector index, model store,
  session-only model fallback, and active ONNX runtime; re-login requires a
  new download or verified file import before semantic search can run.
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
| All mirrors down (model still stored)     | Invisible. Store hit; nothing fetches.                                   |
| IndexedDB write fails (quota)             | Keep bytes in memory for the session; warn; retry persisting next run.   |
| GitHub release download lacks CORS        | Keep it behind HF; use its files through manual import. (§4.1)           |
| onnxruntime-web version bump              | Same-origin WASM copy updates automatically at build; re-run audit.      |

## 9. Non-goals

- No Cloudflare R2 bucket, no Workers AI, no proxying model bytes through Pages Functions —
  the model never touches the Cloudflare deployment.
- No automatic model updates; new models are deliberate manifest + release
  changes.
- No encryption of model files; they are public artifacts.
- No service worker; IndexedDB plus the custom cache adapter covers offline.
