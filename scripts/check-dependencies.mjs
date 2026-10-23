import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const require = createRequire(new URL("package.json", root));
const manifest = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);

for (const entry of readdirSync(new URL("extensions/", root), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  const workspaceManifest = new URL(
    `extensions/${entry.name}/package.json`,
    root,
  );
  let workspace;
  try {
    workspace = JSON.parse(readFileSync(workspaceManifest, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  const workspaceRequire = createRequire(workspaceManifest);
  for (const dependency of ["effect", "@effect/platform-node"]) {
    if (!workspace.dependencies?.[dependency]) continue;
    assert.equal(
      workspaceRequire.resolve(dependency),
      require.resolve(dependency),
      `${entry.name} must share ${dependency}; run npm ci at the repository root`,
    );
    assert.equal(
      workspace.dependencies[dependency],
      manifest.dependencies[dependency],
      `${entry.name} must use the root's pinned ${dependency} version`,
    );
  }
}

console.log("Workspace Effect dependencies share one pinned runtime.");
