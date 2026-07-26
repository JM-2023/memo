import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function tomlArrayBlock(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`\\[\\[${escaped}\\]\\]\\s*([\\s\\S]*?)(?=\\n\\[|$)`));
  if (!match) throw new Error(`Missing [[${name}]] block`);
  return match[1];
}

describe("Pages deployment configuration", () => {
  it("binds the main deployment to the production D1 database only", () => {
    const config = read("wrangler.toml");
    const production = tomlArrayBlock(config, "d1_databases");

    expect(production).toContain('binding = "DB"');
    expect(production).toContain('database_name = "your-d1-database"');
    expect(production).toContain('database_id = "00000000-0000-0000-0000-000000000000"');
    expect(config).not.toContain("[[env.preview.d1_databases]]");
    expect(config).not.toContain('database_name = "your-preview-d1-database"');

    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["db:migrate:preview"]).toBeUndefined();
  });

  it("keeps assets static while giving asset misses a nested 404", () => {
    const routes = JSON.parse(read("public/_routes.json"));
    const headers = read("public/_headers");

    expect(routes.exclude).toContain("/assets/*");
    expect(existsSync(resolve(root, "public/assets/404.html"))).toBe(true);
    expect(existsSync(resolve(root, "public/404.html"))).toBe(false);
    expect(headers).not.toMatch(/^\s*cache-control\s*:/im);
  });
});
