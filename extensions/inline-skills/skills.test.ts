import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CombinedAutocompleteProvider,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import inlineSkills from "./index.ts";
import {
  createAutocompleteProvider,
  expandSkills,
  getSkills,
  MAX_SKILL_BYTES,
  parseReferences,
  recognizedReferences,
  selectedSkills,
  type Skill,
} from "./skills.ts";

const skills: Skill[] = ["first", "second", "first-a"].map((name) => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
}));
const options = { signal: new AbortController().signal };

test("one lexer recognizes both sigils at any prompt position with exact spans", () => {
  const text = '$first then (/skill:second),\n"$first-a" and `$first`.';
  const refs = parseReferences(text);
  assert.deepEqual(
    refs.map((ref) => [ref.name, text.slice(ref.start, ref.end)]),
    [
      ["first", "$first"],
      ["second", "/skill:second"],
      ["first-a", "$first-a"],
      ["first", "$first"],
    ],
  );
  assert.equal(parseReferences("please /skill:", true).at(-1)?.name, "");
  assert.equal(parseReferences("please $", true).at(-1)?.sigil, "$");
});

test("malformed, embedded, escaped, shell and path refs are not partially recognized", () => {
  for (const text of [
    "word$first",
    "\\$first",
    "$$first",
    "${first}",
    "$First",
    "$first_thing",
    "$first--a",
    "$first-",
    "$first.a",
    "$first/path",
    "$first\\file",
    "https://host/skill:first",
    "/skill:first/child",
    "/skill:",
    "$",
    "$first..",
    "/skills:first",
    "x/skill:first",
  ]) {
    assert.deepEqual(parseReferences(text), [], text);
  }
  assert.equal(parseReferences("$first.").length, 1);
  assert.deepEqual(recognizedReferences("$unknown /skill:missing", skills), []);
});

test("recognition/selection deduplicate in first-use order, never bare /names", () => {
  assert.deepEqual(
    selectedSkills("Use /skill:second $first $second /skill:first", skills).map(
      (skill) => skill.name,
    ),
    ["second", "first"],
  );
  for (const command of ["/first", "/help", "/review", "/unknown"]) {
    assert.deepEqual(
      recognizedReferences(`${command} $first /skill:second`, skills),
      [],
    );
  }
  assert.equal(
    recognizedReferences("Use /first and $second", skills).length,
    1,
  );
});

test("registry uses skill file directories, validates names, respects first command collisions", () => {
  const sourceInfo = {
    path: "/real/first/SKILL.md",
    source: "local" as const,
    scope: "user" as const,
    origin: "top-level" as const,
  };
  const commands: ReturnType<ExtensionAPI["getCommands"]> = [
    { name: "skill:first", source: "extension", sourceInfo },
    { name: "skill:first", source: "skill", sourceInfo },
    {
      name: "skill:second",
      source: "skill",
      sourceInfo: { ...sourceInfo, path: "/real/second/SKILL.md" },
    },
    { name: "skill:bad_name", source: "skill", sourceInfo },
    { name: "review", source: "prompt", sourceInfo },
  ];
  assert.deepEqual(
    getSkills(commands).map(({ name, baseDir }) => [name, baseDir]),
    [["second", "/real/second"]],
  );
});

test("expansion preserves unknown refs, punctuation, request, directories, and strips frontmatter", async () => {
  const reads: string[] = [];
  const result = await expandSkills(
    "/skill:first use ($second), $first. $unknown /skill:missing",
    skills,
    async (path) => {
      reads.push(path);
      return "---\nname: test\ndescription: Test\n---\nInstructions with ./references/a.md";
    },
  );
  assert.ok(result);
  assert.equal(reads.length, 2);
  assert.match(result, /References are relative to \/skills\/first\./);
  assert.match(result, /References are relative to \/skills\/second\./);
  assert.doesNotMatch(result, /description: Test/);
  assert.ok(
    result.endsWith("first use (second), first. $unknown /skill:missing"),
  );
  assert.equal((result.match(/<skill name="first"/g) ?? []).length, 1);
  assert.equal(await expandSkills("$unknown", skills), undefined);
  assert.equal(await expandSkills("/review $first", skills), undefined);
});

test("all leading skill invocations load directly (no native fail-open rewrite)", async () => {
  for (const text of ["$first task", "/skill:first task"]) {
    const result = await expandSkills(text, skills, async () => "Do this");
    assert.ok(result?.startsWith('<skill name="first"'));
    await assert.rejects(
      expandSkills(text, skills, async () => {
        throw new Error("read failed");
      }),
      /read failed/,
    );
  }
});

test("aggregate byte budget uses UTF-8 bytes and never returns a partial expansion", async () => {
  await assert.rejects(
    expandSkills("$first /skill:second", skills, async () =>
      "é".repeat(MAX_SKILL_BYTES / 3),
    ),
    /exceed/,
  );
  const exact = await expandSkills("$first", skills, async () =>
    "x".repeat(MAX_SKILL_BYTES),
  );
  assert.ok(exact);
});

test("real offline file loading preserves each skill base and fails on missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "inline-skills-"));
  try {
    const actual = skills.slice(0, 2).map((skill) => ({
      ...skill,
      baseDir: join(root, skill.name),
      path: join(root, skill.name, "SKILL.md"),
    }));
    for (const skill of actual) {
      await mkdir(skill.baseDir);
      await writeFile(skill.path, `Instructions for ${skill.name}`);
    }
    const result = await expandSkills("Use $first /skill:second", actual);
    for (const skill of actual)
      assert.ok(
        result?.includes(`References are relative to ${skill.baseDir}.`),
      );
    await rm(actual[1]!.path);
    await assert.rejects(expandSkills("$first $second", actual), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completion supports both sigils inline, multiline, and at command position", async () => {
  const provider = createAutocompleteProvider(
    () => skills,
    new CombinedAutocompleteProvider([{ name: "help" }], tmpdir()),
  );
  for (const prefix of ["$", "$fi", "/skill:", "/skill:fi"]) {
    for (const before of ["", "Use (", "Use\n"]) {
      const lines = (before + prefix).split("\n");
      const line = lines.length - 1;
      const col = lines[line]!.length;
      const result = await provider.getSuggestions(lines, line, col, options);
      assert.ok(result, before + prefix);
      const item = result.items[0]!;
      assert.ok(item.value.startsWith(prefix[0] === "$" ? "$" : "/skill:"));
      const applied = provider.applyCompletion(
        lines,
        line,
        col,
        item,
        result.prefix,
      );
      assert.equal(applied.lines.join("\n"), before + item.value + " ");
      assert.equal(applied.cursorCol, applied.lines[line]!.length);
      assert.equal(
        provider.shouldTriggerFileCompletion?.(lines, line, col),
        true,
      );
    }
  }
});

test("completion preserves punctuation, suffix, other lines, and does not duplicate slash", async () => {
  const provider = createAutocompleteProvider(
    () => skills,
    new CombinedAutocompleteProvider([], tmpdir()),
  );
  const lines = ["intro", "Use (/skill:fi), then continue"];
  const col = lines[1]!.indexOf(")");
  const result = await provider.getSuggestions(lines, 1, col, options);
  assert.ok(result);
  const applied = provider.applyCompletion(
    lines,
    1,
    col,
    result.items[0]!,
    result.prefix,
  );
  assert.deepEqual(applied.lines, [
    "intro",
    "Use (/skill:first), then continue",
  ]);
  assert.equal(applied.cursorCol, "Use (/skill:first".length);
  assert.deepEqual(lines, ["intro", "Use (/skill:fi), then continue"]);
});

test("ordinary/native completion delegates unchanged, unknown sigils do not invoke file search", async () => {
  let suggestions = 0;
  let applications = 0;
  const base: AutocompleteProvider = {
    triggerCharacters: ["@"],
    async getSuggestions() {
      suggestions++;
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      applications++;
      return { lines, cursorLine, cursorCol };
    },
    shouldTriggerFileCompletion: () => true,
  };
  const provider = createAutocompleteProvider(() => skills, base);
  assert.deepEqual(provider.triggerCharacters, ["@", "$", "/", ":"]);
  for (const text of [
    "/help",
    "/review $fi",
    "/first",
    "@file",
    "word$fi",
    "\\$fi",
    "$fi/path",
    "$Fi",
  ]) {
    await provider.getSuggestions([text], 0, text.length, options);
  }
  assert.equal(suggestions, 8);
  assert.equal(
    await provider.getSuggestions(["$unknown"], 0, 8, options),
    null,
  );
  assert.equal(suggestions, 8);
  provider.applyCompletion(
    ["@file"],
    0,
    5,
    { label: "file", value: "file" },
    "@file",
  );
  assert.equal(applications, 1);
  // Cursor in an existing token is delegated, not partially replaced.
  await provider.getSuggestions(["$first"], 0, 3, options);
  assert.equal(suggestions, 9);
});

test("extension handler consumes failed requests, preserves images, skips generated inputs", async () => {
  let input:
    | ((event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult>)
    | undefined;
  const notifications: string[] = [];
  let path = "/missing/skill/SKILL.md";
  // Deliberately tiny host boundary double; implementation uses the real host types.
  const api = {
    getCommands: () => [
      { name: "skill:first", source: "skill", sourceInfo: { path } },
    ],
    on(name: string, handler: typeof input) {
      if (name === "input") input = handler;
    },
  } as unknown as ExtensionAPI;
  inlineSkills(api);
  assert.ok(input);
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  assert.deepEqual(
    await input({ type: "input", text: "$first", source: "interactive" }, ctx),
    { action: "handled" },
  );
  assert.match(notifications[0]!, /Could not load inline skills/);
  assert.deepEqual(
    await input({ type: "input", text: "$first", source: "extension" }, ctx),
    { action: "continue" },
  );
  assert.deepEqual(
    await input({ type: "input", text: "$unknown", source: "rpc" }, ctx),
    { action: "continue" },
  );
  const root = await mkdtemp(join(tmpdir(), "inline-skill-handler-"));
  try {
    path = join(root, "SKILL.md");
    await writeFile(path, "Instructions");
    const images = [
      { type: "image" as const, data: "AA==", mimeType: "image/png" },
    ];
    const result = await input(
      { type: "input", text: "Use /skill:first", images, source: "rpc" },
      ctx,
    );
    assert.equal(result.action, "transform");
    if (result.action === "transform") {
      assert.equal(result.images, images);
      assert.match(result.text, /Instructions/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
