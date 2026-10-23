import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const live = new Set(["claude.test.ts", "codex.test.ts"]);
const files = [
  "tests/package.test.mjs",
  ...readdirSync(`${root}/extensions`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(`${root}/extensions/${entry.name}`)
        .filter((name) => name.endsWith(".test.ts") && !live.has(name))
        .map((name) => `extensions/${entry.name}/${name}`),
    ),
].sort();

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
