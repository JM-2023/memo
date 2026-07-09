import { webcrypto } from "node:crypto";
import { argv, exit } from "node:process";

const password = argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "1234"');
  exit(1);
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// Keep in sync with HASH_ITERATIONS in functions/api/_utils/auth.ts: the
// deployed Workers runtime rejects PBKDF2 above 100k iterations.
const iterations = 100000;
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const derived = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);

console.log(`pbkdf2_sha256$${iterations}$${base64Url(salt)}$${base64Url(new Uint8Array(derived))}`);
