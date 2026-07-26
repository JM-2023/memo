import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

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

console.log("Verified Pages SPA and static-asset fallback output.");
