import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import { inspectSubagents } from "./src/ui/inspect.ts";

test("inspection exits when the native picker is dismissed", async () => {
  let selections = 0;
  await inspectSubagents(
    {
      select: async (_title, options) => {
        selections++;
        assert.deepEqual(options, []);
        return undefined;
      },
      editor: async () => {
        throw new Error("must not open an editor");
      },
    },
    {
      list: () => [],
      get: () => undefined,
    },
  );
  assert.equal(selections, 1);
});

test("inspection shows a snapshot and discards editor input without sending it", async () => {
  const snap: SubagentSnapshot = {
    id: "sa-1",
    backend: "pi",
    title: "inspect me",
    prompt: "task",
    cwd: "/workspace",
    status: "done",
    createdAt: 0,
    meta: { backend: "pi", sessionFilePath: "/transcript.jsonl" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "final output",
    turns: 1,
  };
  let selections = 0;
  let inspections = 0;
  await inspectSubagents(
    {
      select: async (_title, options) =>
        ++selections === 1 ? options[0] : undefined,
      editor: async (_title, text) => {
        inspections++;
        assert.match(text ?? "", /final output/);
        assert.match(text ?? "", /\/transcript.jsonl/);
        return "this must not become a prompt";
      },
    },
    {
      list: () => [snap],
      get: (id) => (id === snap.id ? snap : undefined),
    },
  );
  assert.equal(inspections, 1);
  assert.equal(selections, 2);
  assert.equal(snap.finalText, "final output");
});
