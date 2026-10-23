import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);

test("Pineapple exposes only the seven retained extensions", () => {
  assert.deepEqual(manifest.pi.extensions, [
    "./extensions/ask-user/index.ts",
    "./extensions/background-terminals/index.ts",
    "./extensions/file-search/index.ts",
    "./extensions/firecrawl-search/index.ts",
    "./extensions/subagents/index.ts",
    "./extensions/inline-skills/index.ts",
    "./extensions/prompt-box/index.ts",
  ]);
  for (const path of manifest.pi.extensions)
    assert.ok(existsSync(new URL(path, root)));
});

test("legacy extensions are removed, not just disabled", () => {
  for (const name of [
    "copy-all",
    "git-info",
    "model-info",
    "ui-customization",
    "spark-strict-tools",
    "summaries",
    "workflows",
  ]) {
    assert.equal(
      existsSync(new URL(`extensions/${name}/index.ts`, root)),
      false,
      name,
    );
  }
  for (const dependency of ["acorn", "@effect/platform-node", "ioredis"]) {
    assert.equal(manifest.dependencies[dependency], undefined, dependency);
  }
});

test("original attribution and license remain intact", () => {
  assert.match(
    readFileSync(new URL("LICENSE", root), "utf8"),
    /Copyright \(c\) 2026 Benjamin Davis/,
  );
  assert.match(
    readFileSync(new URL("README.md", root), "utf8"),
    /https:\/\/github.com\/davis7dotsh\/my-pi-setup/,
  );
});
