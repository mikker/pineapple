import assert from "node:assert/strict";
import test from "node:test";
import { inspectionText } from "./src/ui/ps.ts";
import { createTerminalManager } from "./src/manager.ts";
import { sanitizeText } from "./src/ui/output-view.ts";

test("minimal inspection handles empty and unknown ids", async () => {
  const manager = createTerminalManager();
  try {
    assert.equal(inspectionText(manager.view), "No background terminals.");
    assert.equal(
      inspectionText(manager.view, "bt-7"),
      'Unknown terminal id "bt-7".',
    );
  } finally {
    await manager.dispose();
  }
});
test("sanitizeText strips ANSI, tabs, and control characters", () => {
  assert.equal(sanitizeText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeText("\u001b[12345Cshifted"), "shifted");
  assert.equal(sanitizeText("\u001b]0;window title\u0007output"), "output");
  assert.equal(
    sanitizeText("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\"),
    "link",
  );
  assert.equal(sanitizeText("\u001b]0;title\u009coutput"), "output");
  assert.equal(sanitizeText("\u009d0;title\u0007output"), "output");
  assert.equal(sanitizeText("a\u0085b"), "ab");
  assert.equal(sanitizeText("a\tb"), "a  b");
  assert.equal(sanitizeText("a\u0007b\u0000c"), "abc");
});
