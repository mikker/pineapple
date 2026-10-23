import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { parseGitStatus, statusBorder } from "./status.ts";

test("git status handles clean, dirty, initial and tracking branches", () => {
  assert.deepEqual(parseGitStatus("## main...origin/main\n"), {
    branch: "main",
    changes: 0,
  });
  assert.deepEqual(
    parseGitStatus(
      "## feature...origin/feature [ahead 2]\n M file.ts\n?? new.ts\n",
    ),
    { branch: "feature", changes: 2 },
  );
  assert.deepEqual(parseGitStatus("## No commits yet on main\n?? first\n"), {
    branch: "main",
    changes: 1,
  });
});

test("status border fits narrow widths, Unicode and ANSI, with a dim rule", () => {
  const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;
  const left = "✌︎ project · main · clean";
  const right = dim("gpt-6.1-sol  fast  ◐medium");
  for (const width of [6, 7, 10, 20, 40, 80, 200]) {
    const line = statusBorder(width, left, right, dim);
    assert.equal(visibleWidth(line), width, stripTerminalSequences(line));
  }
  const line = stripTerminalSequences(statusBorder(100, left, right, dim));
  assert.ok(line.startsWith(` ${left} `));
  assert.ok(line.endsWith(" gpt-6.1-sol  fast  ◐medium "));
});
