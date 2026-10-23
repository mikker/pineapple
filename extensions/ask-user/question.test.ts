import assert from "node:assert/strict";
import test from "node:test";
import { askQuestion } from "./question.ts";
import { buildAskUserResultMessage } from "./prompt.ts";

const params = {
  question: "Which approach?",
  options: [
    { label: "Small", description: "Less work" },
    { label: "Thorough" },
  ],
};

type QuestionContext = Parameters<typeof askQuestion>[1];

function scriptedUI(
  selections: (number | string | undefined)[],
  answers: (string | undefined)[] = [],
) {
  const calls: { method: string; title: string; signal?: AbortSignal }[] = [];
  const ui: QuestionContext["ui"] = {
    async select(title, options, opts) {
      calls.push({ method: "select", title, signal: opts?.signal });
      assert.ok(selections.length, "unexpected select dialog");
      assert.deepEqual(options, [
        "1. Small — Less work",
        "2. Thorough",
        "Write my own answer…",
      ]);
      const selection = selections.shift();
      return typeof selection === "number" ? options[selection] : selection;
    },
    async input(title, _placeholder, opts) {
      calls.push({ method: "input", title, signal: opts?.signal });
      assert.ok(answers.length, "unexpected input dialog");
      return answers.shift();
    },
  };
  return { hasUI: true, ui, calls };
}

test("returns the original label and one-based index, not the display description", async () => {
  const ctx = scriptedUI([0]);
  const outcome = await askQuestion(params, ctx);
  assert.deepEqual(outcome, { kind: "selected", answer: "Small", index: 1 });
  assert.equal(
    buildAskUserResultMessage(outcome),
    "User selected option 1: Small",
  );
  assert.equal(ctx.calls[0].title, params.question);
});

test("supports free-form answers through the same native dialogs in TUI and RPC", async () => {
  const ctx = scriptedUI([2], ["  Something else\nwith details  "]);
  assert.deepEqual(await askQuestion(params, ctx), {
    kind: "custom",
    answer: "Something else\nwith details",
  });
  assert.deepEqual(
    ctx.calls.map((call) => call.method),
    ["select", "input"],
  );
});

for (const answer of [undefined, "", " \n "]) {
  test(`free-form ${JSON.stringify(answer)} returns to choices`, async () => {
    const ctx = scriptedUI([2, 1], [answer]);
    assert.deepEqual(await askQuestion(params, ctx), {
      kind: "selected",
      answer: "Thorough",
      index: 2,
    });
    assert.equal(ctx.calls.length, 3);
  });
}

test("dismissing the selector does not assume an answer", async () => {
  assert.deepEqual(await askQuestion(params, scriptedUI([undefined])), {
    kind: "dismissed",
  });
  assert.match(
    buildAskUserResultMessage({ kind: "dismissed" }),
    /Do not assume/,
  );
});

test("non-interactive modes do not open dialogs", async () => {
  const ctx = scriptedUI([]);
  ctx.hasUI = false;
  assert.deepEqual(await askQuestion(params, ctx), { kind: "no-ui" });
  assert.equal(ctx.calls.length, 0);
});

test("an already-aborted call opens no dialogs, even without UI", async () => {
  const ctx = scriptedUI([]);
  ctx.hasUI = false;
  assert.deepEqual(await askQuestion(params, ctx, AbortSignal.abort()), {
    kind: "cancelled",
  });
  assert.equal(ctx.calls.length, 0);
});

for (const stage of ["select", "input"] as const) {
  test(`abort during ${stage} uses the native signal and never reopens choices`, async () => {
    const controller = new AbortController();
    const ctx = scriptedUI([2]);
    let opened!: () => void;
    const started = new Promise<void>((resolve) => {
      opened = resolve;
    });
    ctx.ui[stage] = async (_title, _value, opts) => {
      assert.equal(opts?.signal, controller.signal);
      opened();
      return new Promise<undefined>((resolve) => {
        opts?.signal?.addEventListener("abort", () => resolve(undefined), {
          once: true,
        });
      });
    };
    const pending = askQuestion(params, ctx, controller.signal);
    await started;
    controller.abort();
    assert.deepEqual(await pending, { kind: "cancelled" });
  });
}

test("abort wins over a selection or custom answer resolving in the same tick", async () => {
  for (const stage of ["select", "input"] as const) {
    const controller = new AbortController();
    const ctx = scriptedUI([2]);
    ctx.ui[stage] = async () => {
      controller.abort();
      return stage === "select" ? "1. Small — Less work" : "Too late";
    };
    assert.deepEqual(await askQuestion(params, ctx, controller.signal), {
      kind: "cancelled",
    });
  }
});

test("duplicate labels and a label matching the free-form action stay unambiguous", async () => {
  const input = {
    question: "Pick one",
    options: [
      { label: "Same" },
      { label: "Same" },
      { label: "Write my own answer…" },
    ],
  };
  const ctx = scriptedUI([]);
  ctx.ui.select = async (_title, choices) => choices[1];
  assert.deepEqual(await askQuestion(input, ctx), {
    kind: "selected",
    answer: "Same",
    index: 2,
  });
  ctx.ui.select = async (_title, choices) => choices[2];
  assert.deepEqual(await askQuestion(input, ctx), {
    kind: "selected",
    answer: "Write my own answer…",
    index: 3,
  });
});

test("unknown RPC selections fail rather than being treated as custom answers", async () => {
  await assert.rejects(
    askQuestion(params, scriptedUI(["invented answer"])),
    /unknown selection/,
  );
});

test("dialog failures propagate without Effect wrapping or swallowing errors", async () => {
  const ctx = scriptedUI([]);
  const error = new Error("dialog unavailable");
  ctx.ui.select = async () => {
    throw error;
  };
  await assert.rejects(askQuestion(params, ctx), (actual) => actual === error);
});

test("invalid option counts fail before opening a dialog", async () => {
  for (const count of [0, 1, 6]) {
    const ctx = scriptedUI([]);
    await assert.rejects(
      askQuestion(
        {
          ...params,
          options: Array.from({ length: count }, () => ({ label: "x" })),
        },
        ctx,
      ),
      /between 2 and 5 options/,
    );
    assert.equal(ctx.calls.length, 0);
  }
});

test("a pending question does not prevent independent promise work", async () => {
  const ctx = scriptedUI([]);
  let answer!: (value: string) => void;
  ctx.ui.select = async () =>
    new Promise<string>((resolve) => {
      answer = resolve;
    });
  const pending = askQuestion(params, ctx);
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  await Promise.resolve(); // independent work; not a new model turn
  assert.equal(finished, false);
  answer("2. Thorough");
  assert.deepEqual(await pending, {
    kind: "selected",
    answer: "Thorough",
    index: 2,
  });
});
