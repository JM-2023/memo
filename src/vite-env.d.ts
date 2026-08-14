/// <reference types="vite/client" />

/**
 * Same-origin base path of the copied onnxruntime WASM runtime, stamped with
 * the installed onnxruntime-web version by vite.config.ts so a dependency
 * bump can never pair cached stale WASM with newer JS.
 */
declare const __ORT_WASM_BASE__: string;
