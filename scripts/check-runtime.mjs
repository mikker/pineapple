// Import only vendor SDKs: no client, credentials, sessions, or network requests.
// Also run this in production installs, where npm omits dev and automatic peers.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

for (const [workspace, dependency] of [
  ["firecrawl-search", "firecrawl"],
  ["subagents", "@anthropic-ai/claude-agent-sdk"],
]) {
  const require = createRequire(
    new URL(`../extensions/${workspace}/package.json`, import.meta.url),
  );
  await import(pathToFileURL(require.resolve(dependency)).href);
  console.log(`Runtime dependency: ${dependency} OK`);
}
