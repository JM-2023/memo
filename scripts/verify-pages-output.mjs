import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

/** Cloudflare Pages rejects any single asset at or above 25 MiB. */
const MAX_PAGES_FILE_BYTES = 25 * 1024 * 1024;

function assertFile(path, description) {
  try {
    if (!statSync(path).isFile()) throw new Error();
  } catch {
    throw new Error(`Pages build is missing ${description}: ${path}`);
  }
}

const indexPath = resolve(dist, "index.html");
const asset404Path = resolve(dist, "assets", "404.html");
const routesPath = resolve(dist, "_routes.json");
const headersPath = resolve(dist, "_headers");

assertFile(indexPath, "the SPA entry");
assertFile(asset404Path, "the nested asset 404");
assertFile(routesPath, "the Functions route manifest");
assertFile(headersPath, "the static header manifest");

try {
  if (statSync(resolve(dist, "404.html")).isFile()) {
    throw new Error("Pages build must not contain a root 404.html because it disables the SPA fallback.");
  }
} catch (error) {
  if (error instanceof Error && error.message.includes("must not contain")) throw error;
}

const routes = JSON.parse(readFileSync(routesPath, "utf8"));
if (!Array.isArray(routes.exclude) || !routes.exclude.includes("/assets/*")) {
  throw new Error("Pages _routes.json must keep /assets/* outside Functions.");
}

const headers = readFileSync(headersPath, "utf8");
if (/^\s*cache-control\s*:/im.test(headers)) {
  throw new Error("Pages _headers must not override Cloudflare's status-specific Cache-Control defaults.");
}

// The semantic model's ONNX runtime must ship with the app (same origin, no
// CDN), versioned by the installed onnxruntime-web so cached WASM can never
// go stale against newer JS. The model itself must never ship — it lives in
// release assets and IndexedDB, not in this bundle.
const ortVersion = JSON.parse(readFileSync(resolve(root, "node_modules/onnxruntime-web/package.json"), "utf8")).version;
for (const variant of ["", ".asyncify", ".jspi"]) {
  for (const extension of [".mjs", ".wasm"]) {
    assertFile(
      resolve(dist, "assets", "ort", ortVersion, `ort-wasm-simd-threaded${variant}${extension}`),
      "the self-hosted ONNX runtime"
    );
  }
}

for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  if (entry.name.endsWith(".onnx")) {
    throw new Error(`Pages build must not contain model weights (found ${path}); the model is distributed via release assets.`);
  }
  if (/ort-wasm/.test(entry.name) && !path.startsWith(join(dist, "assets", "ort") + "/")) {
    throw new Error(`Pages build contains a stray ORT artifact outside assets/ort/ (${path}); the copy plugin should have pruned it.`);
  }
  const { size } = statSync(path);
  if (size >= MAX_PAGES_FILE_BYTES) {
    throw new Error(`Pages build contains ${path} at ${size} bytes, at or above the 25 MiB per-file limit.`);
  }
}

console.log("Verified Pages SPA, static-asset fallback, and ONNX runtime output.");
