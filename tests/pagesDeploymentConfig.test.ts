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
  it("keeps deployment identifiers in an ignored local config", () => {
    const config = read("wrangler.example.toml");
    const ignore = read(".gitignore");
    const database = tomlArrayBlock(config, "d1_databases");

    expect(ignore).toMatch(/^wrangler\.toml$/m);
    expect(database).toContain('binding = "DB"');
    expect(database).toContain('database_name = "your-d1-database"');
    expect(database).toContain('database_id = "00000000-0000-0000-0000-000000000000"');
    expect(config).toContain('CANONICAL_HOST = "notes.example"');
    expect(config).toContain('PRODUCTION_PAGES_HOST = "your-pages-project.pages.dev"');
    expect(config).not.toContain("[[env.preview.d1_databases]]");

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
