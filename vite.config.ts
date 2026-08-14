import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { version } from "./package.json";

// The semantic model's ONNX runtime must load its .mjs/.wasm pair from this
// origin — onnxruntime-web's default is a third-party CDN, which would be a
// hidden remote dependency in an otherwise self-contained app. The pair is
// copied out of the installed package at build time, under /assets/ so a
// missing file is a real 404 (public/assets/404.html) rather than the SPA
// fallback, and under the package's own version so a dependency bump can
// never serve stale cached WASM to newer JS. scripts/verify-pages-output.mjs
// asserts the copies exist and respect Pages' 25 MiB per-file limit.
const ortPackage = resolve(import.meta.dirname, "node_modules/onnxruntime-web");
const ortVersion: string = JSON.parse(readFileSync(resolve(ortPackage, "package.json"), "utf8")).version;
// The wasm execution provider picks its build at runtime: .jspi where the
// browser ships WebAssembly JSPI, .asyncify otherwise, plain as the legacy
// path — so all three pairs ship. The .jsep build (WebGPU) stays excluded:
// device is pinned to "wasm" and that file exceeds Pages' 25 MiB limit.
export const ORT_RUNTIME_FILES = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.jspi.mjs",
  "ort-wasm-simd-threaded.jspi.wasm"
] as const;
export const ORT_WASM_BASE = `/assets/ort/${ortVersion}/`;

function copyOrtRuntime(): Plugin {
  return {
    name: "memo-copy-ort-runtime",
    apply: "build",
    generateBundle(_options, bundle) {
      // onnxruntime-web's ESM references sibling WASM builds through
      // `new URL(…, import.meta.url)`, which makes Rollup emit them as
      // hashed assets (a stray 23 MB asyncify build, in practice). The
      // runtime never fetches those URLs — wasmPaths points at the copies
      // below — so drop every ORT artifact that is not ours.
      for (const fileName of Object.keys(bundle)) {
        if (/ort-wasm.*\.(wasm|mjs)$/.test(fileName) && !fileName.startsWith("assets/ort/")) {
          delete bundle[fileName];
        }
      }
      for (const file of ORT_RUNTIME_FILES) {
        this.emitFile({
          type: "asset",
          fileName: `${ORT_WASM_BASE.slice(1)}${file}`,
          source: readFileSync(resolve(ortPackage, "dist", file))
        });
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), copyOrtRuntime()],
  define: {
    __ORT_WASM_BASE__: JSON.stringify(ORT_WASM_BASE)
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-v${version}.js`,
        chunkFileNames: `assets/[name]-[hash]-v${version}.js`,
        assetFileNames: `assets/[name]-[hash]-v${version}[extname]`
      }
    }
  },
  server: {
    port: 5174
  }
});
