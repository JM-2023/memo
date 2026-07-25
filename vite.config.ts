import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { version } from "./package.json";

export default defineConfig({
  plugins: [react()],
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
