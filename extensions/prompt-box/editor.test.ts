import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  renderFakeCursor,
  stripTerminalSequences,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  createAutocompleteProvider,
  type Skill,
} from "../inline-skills/skills.ts";
import { decorateLine, projectReferences, PromptBoxEditor } from "./editor.ts";
import { ImagePathLabels } from "./images.ts";
import promptBox from "./index.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

const identity = (text: string) => text;
const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};
const skills: Skill[] = [
  "first",
  "first-a",
  "second",
  "a-very-long-skill-name",
].map((name) => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
}));
const red = (text: string) => `\x1b[31m${text}\x1b[39m`;
const green = (text: string) => `\x1b[32m${text}\x1b[39m`;

function fixture(
  chrome?: ConstructorParameters<typeof PromptBoxEditor>[6],
  images?: ImagePathLabels,
) {
  // Only the terminal size and render scheduler are used by native Editor.
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
  } as TUI;
  // The app's manager is type-only in the host's public entry point. Tests use
  // its real TUI base with explicit app actions; no config files are consulted.
  const keys = new TuiKeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape", description: "interrupt" },
    "app.exit": { defaultKeys: "ctrl+d", description: "exit" },
    "app.model.select": { defaultKeys: "ctrl+l", description: "model" },
  }) as KeybindingsManager;
  let accent = red;
  const editor = new PromptBoxEditor(
    tui,
    editorTheme,
    keys,
    () => skills,
    (text) => accent(text),
    5,
    chrome,
    images,
  );
  const native = new CustomEditor(tui, editorTheme, keys, { paddingX: 1 });
  return {
    editor,
    native,
    setAccent: (fn: typeof red) => {
      accent = fn;
    },
  };
}

const plain = (lines: string[]) => lines.map(stripTerminalSequences);

test("image labels survive paste, insertion, undo and submission without showing paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "prompt-images-"));
  try {
    const path = join(directory, "screenshot.png");
    writeFileSync(path, "test");
    const images = new ImagePathLabels();
    const { editor } = fixture(undefined, images);
    editor.setText(path);
    assert.equal(editor.getText(), "[Image #1]");
    assert.ok(!plain(editor.render(80)).join("").includes(path));
    editor.setText("");
    editor.insertTextAtCursor(path);
    assert.equal(editor.getText(), "[Image #1]");
    editor.handleInput("\x1f");
    assert.equal(editor.getText(), "");
    editor.handleInput(`\x1b[200~${path}\x1b[201~`);
    assert.equal(editor.getText(), "[Image #1]");
    let submitted = "";
    editor.onSubmit = (text) => {
      submitted = images.expand(text);
    };
    editor.handleInput("\r");
    assert.equal(submitted, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prompt telemetry occupies the top rule and every frame edge stays dim", () => {
  let right = "gpt-6.1-sol  fast  ◐medium";
  const { editor } = fixture({
    dim: green,
    status: () => ({ left: "✌︎ project · main · clean", right }),
  });
  editor.setText("hello");
  editor.borderColor = red; // The host changes this when thinking level changes.
  const lines = editor.render(100);
  assert.match(
    stripTerminalSequences(lines[0]!),
    /✌︎ project · main · clean.*gpt-6.1-sol  fast  ◐medium/,
  );
  assert.ok(
    lines.every((line) =>
      line.startsWith(
        green(line === lines[0] ? "╭" : line === lines.at(-1) ? "╰" : "│"),
      ),
    ),
  );
  assert.ok(!lines.join("").includes("\x1b[31m"));
  right = "new-model  ◐high";
  assert.ok(stripTerminalSequences(editor.render(100)[0]!).includes(right));
  for (const width of [8, 12, 30, 80]) {
    for (const line of editor.render(width))
      assert.ok(visibleWidth(line) <= width);
  }
});

test("runtime modules use only root host aliases, never physical host subpaths", () => {
  const directory = new URL("./", import.meta.url);
  const runtime = readdirSync(directory).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  assert.ok(runtime.includes("editor.ts"));
  assert.ok(runtime.includes("annotation.ts"));
  for (const name of runtime) {
    const source = readFileSync(new URL(name, directory), "utf8");
    // Includes static imports/re-exports and literal require/dynamic imports.
    assert.doesNotMatch(source, /["'`]@earendil-works\/pi-[^/"'`]+\//, name);
  }
});

test("annotation wrapping preserves native whitespace and CJK boundaries", () => {
  for (const text of [
    "  $first   /skill:second  ",
    "界 $first 中文 /skill:second",
    "é 🙂 $first\t /skill:second",
    "$first\u00a0\u2003/skill:second",
  ]) {
    for (const width of [14, 19, 28]) {
      const { editor, native } = fixture();
      editor.setText(text);
      native.setText(text);
      const rendered = editor.render(width);
      assert.deepEqual(
        plain(rendered.slice(1, -1)).map((line) => line.slice(1, -1)),
        plain(native.render(width - 2).slice(1, -1)),
      );
      const highlighted = [
        ...rendered
          .slice(1, -1)
          .join("")
          .matchAll(/\x1b\[31m([^\x1b]*)\x1b\[39m/g),
      ]
        .map((match) => match[1])
        .join("");
      assert.equal(highlighted, "$first/skill:second", `${width}: ${text}`);
    }
  }
});

test("foreground decoration preserves native IME, fake cursor, OSC and SGR boundaries", () => {
  const link = "\x1b]8;;https://example.test\x07";
  const source = `${link}$fi${CURSOR_MARKER}${renderFakeCursor("r")}st\x1b]8;;\x07 plain`;
  const result = decorateLine(source, [{ start: 0, end: 6 }], red);
  assert.equal(stripTerminalSequences(result), "$first plain");
  assert.equal(visibleWidth(result), visibleWidth(source));
  assert.ok(result.includes(CURSOR_MARKER));
  assert.ok(result.includes(link));
  assert.ok(result.includes(red("$")));
  assert.ok(!result.includes(red("p")));
  assert.deepEqual(decorateLine(source, [], red), source);
});

test("source projection highlights whole references across wrapping, never unknowns or malformed refs", () => {
  const text =
    "界🙂 use /skill:a-very-long-skill-name and $unknown\n$first_bad $second";
  const rows = projectReferences(text, skills, 8);
  const highlighted = rows
    .flatMap((row) =>
      row.ranges.map((range) => row.text.slice(range.start, range.end)),
    )
    .join("");
  assert.equal(highlighted, "/skill:a-very-long-skill-name$second");
  for (const row of rows)
    for (const range of row.ranges) {
      assert.ok(range.start >= 0);
      assert.ok(range.end <= row.text.length);
    }
});

test("wrapped highlighting decorates every visible reference fragment in real native rows", () => {
  const { editor } = fixture();
  editor.setText("$first /skill:a-very-long-skill-name");
  const rendered = editor.render(14);
  const content = rendered.slice(1, -1).join("");
  const highlighted = [...content.matchAll(/\x1b\[31m([^\x1b]*)\x1b\[39m/g)]
    .map((match) => match[1])
    .join("");
  assert.equal(highlighted, "$first/skill:a-very-long-skill-name");
});

test("native hooks frame text without guessing which lines are rules", () => {
  const { editor, native } = fixture();
  editor.setText("──────────────────────────\nordinary\n↓ 22 more");
  native.setText(editor.getText());
  const rendered = editor.render(30);
  const baseline = native.render(28);
  assert.equal(rendered.length, baseline.length);
  assert.ok(rendered[0]!.startsWith("╭"));
  assert.ok(rendered.at(-1)!.endsWith("╯"));
  assert.deepEqual(
    plain(rendered.slice(1, -1)).map((line) => line.slice(1, -1)),
    plain(baseline.slice(1, -1)),
  );
  assert.ok(!rendered.join("").includes("pineapple-prompt-box-bottom"));
});

test("recognized refs receive semantic accent and deduplicated selection, unknown/native commands do not", () => {
  const { editor } = fixture();
  editor.setText("Use $first and /skill:second, $first $unknown");
  const rendered = editor.render(80);
  assert.ok(rendered.slice(1, -1).join("").includes(red("$")));
  assert.ok(rendered.slice(1, -1).join("").includes(red("/")));
  assert.ok(!rendered.slice(1, -1).join("").includes(red("u")));
  assert.match(stripTerminalSequences(rendered.at(-1)!), / first · second /);
  for (const text of [
    "/help $first",
    "/review /skill:second",
    "$first_bad $unknown",
  ]) {
    editor.setText(text);
    assert.ok(
      !editor
        .render(80)
        .join("")
        .includes("\x1b[31m" + "$"),
    );
    assert.ok(
      !stripTerminalSequences(editor.render(80).at(-1)!).includes("first ·"),
    );
  }
});

test("narrow widths use an exact plain native editor fallback and resize restores frame", () => {
  const { editor, native } = fixture();
  const text = "Use /skill:first $unknown";
  editor.setText(text);
  native.setText(text);
  for (const width of [1, 2, 4, 7])
    assert.deepEqual(editor.render(width), native.render(width));
  // Pi 1.4's own wordWrapLine recurses on a width-2 grapheme in a
  // one-column viewport. Exercise Unicode above that native limitation.
  editor.setText("界🙂 é /skill:first $unknown");
  for (const width of [8, 9, 12, 20, 80]) {
    const rendered = editor.render(width);
    assert.ok(rendered[0]!.startsWith("╭"));
    for (const line of rendered)
      assert.ok(
        visibleWidth(line) <= width,
        `${width}: ${stripTerminalSequences(line)}`,
      );
  }
});

test("theme changes recolor refs and selection without stale ANSI in state", () => {
  const { editor, setAccent } = fixture();
  editor.setText("Use $first");
  assert.ok(editor.render(40).join("").includes("\x1b[31m"));
  setAccent(green);
  editor.invalidate();
  const rendered = editor.render(40).join("");
  assert.ok(rendered.includes("\x1b[32m"));
  assert.ok(!rendered.includes("\x1b[31m"));
  assert.equal(editor.getText(), "Use $first");
});

test("host-installed padding settings preserve native geometry and source highlighting", () => {
  for (const padding of [0, 1, 3, 8]) {
    const { editor, native } = fixture();
    editor.setPaddingX(padding);
    native.setPaddingX(padding);
    editor.setText("$first /skill:second");
    native.setText(editor.getText());
    const rendered = editor.render(40);
    const baseline = native.render(38);
    assert.deepEqual(
      plain(rendered.slice(1, -1)).map((line) => line.slice(1, -1)),
      plain(baseline.slice(1, -1)),
    );
    const highlighted = [
      ...rendered
        .slice(1, -1)
        .join("")
        .matchAll(/\x1b\[31m([^\x1b]*)\x1b\[39m/g),
    ]
      .map((match) => match[1])
      .join("");
    assert.equal(highlighted, "$first/skill:second");
  }
});

test("native scrolling is preserved and projection follows the native visible source offset", () => {
  const { editor, native } = fixture();
  const text = Array.from(
    { length: 30 },
    (_, index) => `line ${index} $first`,
  ).join("\n");
  editor.setText(text);
  native.setText(text);
  editor.focused = native.focused = true;
  const rendered = editor.render(32);
  const baseline = native.render(30);
  assert.match(stripTerminalSequences(rendered[0]!), /↑.*more/);
  assert.deepEqual(
    plain(rendered.slice(1, -1)).map((line) => line.slice(1, -1)),
    plain(baseline.slice(1, -1)),
  );
  assert.equal(
    rendered.filter((line) => line.includes(CURSOR_MARKER)).length,
    1,
  );
  // Move to the start to expose the native bottom scroll count unmodified.
  editor.handleInput("\x1b[H");
  editor.handleInput("\x1b[1;5H");
  editor.setText("$first\n" + "more\n".repeat(20));
  editor.handleInput("\x1b[H");
  for (let index = 0; index < 30; index++) editor.handleInput("\x1b[A");
  const atTop = plain(editor.render(32));
  assert.match(atTop.at(-1)!, /↓.*more/);
});

test("keyboard handling, paste, submit and cursor stay native", () => {
  const { editor, native } = fixture();
  let submitted = "";
  editor.onSubmit = (text) => {
    submitted = text;
  };
  for (const instance of [editor, native]) {
    instance.focused = true;
    instance.handleInput("hello");
    instance.handleInput("\x1b[D");
    instance.handleInput("!");
    instance.handleInput("\x7f");
    instance.handleInput("\x1b[200~use $first\nsecond line\x1b[201~");
  }
  assert.equal(editor.getExpandedText(), native.getExpandedText());
  assert.deepEqual(editor.getCursor(), native.getCursor());
  const rendered = editor.render(40);
  assert.equal(
    rendered.filter((line) => line.includes(CURSOR_MARKER)).length,
    1,
  );
  assert.equal(
    visibleWidth(rendered.find((line) => line.includes(CURSOR_MARKER))!),
    40,
  );
  const fullText = editor.getExpandedText();
  editor.handleInput("\r");
  assert.equal(submitted, fullText);
  assert.equal(editor.getText(), "");
});

test("native history navigation and atomic undo require no prompt-box interception", () => {
  const { editor, native } = fixture();
  for (const instance of [editor, native]) {
    instance.addToHistory("previous prompt");
    instance.handleInput("\x1b[A");
    assert.equal(instance.getText(), "previous prompt");
    instance.handleInput("\x1b[B");
    assert.equal(instance.getText(), "");
    instance.insertTextAtCursor("Use $first");
    instance.handleInput("\x1b[45;5u");
    assert.equal(instance.getText(), "");
  }
  assert.deepEqual(editor.getCursor(), native.getCursor());
});

test("large bracketed pastes retain native collapsed markers and selected skills", () => {
  const { editor, native } = fixture();
  const pasted = "$first\n" + "long paste\n".repeat(30);
  for (const instance of [editor, native])
    instance.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  assert.equal(editor.getExpandedText(), pasted);
  assert.equal(editor.getText(), native.getText());
  assert.match(editor.getText(), /paste #/);
  const rendered = editor.render(40);
  const baseline = native.render(38);
  assert.deepEqual(
    plain(rendered.slice(1, -1)).map((line) => line.slice(1, -1)),
    plain(baseline.slice(1, -1)),
  );
  assert.match(stripTerminalSequences(rendered.at(-1)!), /first/);
});

test("native escape, exit, app actions and extension shortcuts are inherited", () => {
  const { editor } = fixture();
  const calls: string[] = [];
  editor.onEscape = () => calls.push("escape");
  editor.onCtrlD = () => calls.push("exit");
  editor.onAction("app.model.select", () => calls.push("model"));
  editor.onExtensionShortcut = (data) => {
    if (data === "~") {
      calls.push("extension");
      return true;
    }
    return false;
  };
  editor.handleInput("\x1b");
  editor.handleInput("\x04");
  editor.handleInput("\x0c");
  editor.handleInput("~");
  assert.deepEqual(calls, ["escape", "exit", "model", "extension"]);
  assert.equal(editor.getText(), "");
});

test("both sigils complete through real native editor with an untouched menu and cursor", async () => {
  for (const sigil of ["$", "/skill:"]) {
    const { editor } = fixture();
    editor.focused = true;
    editor.setAutocompleteProvider(
      createAutocompleteProvider(
        () => skills,
        new CombinedAutocompleteProvider([], "/offline"),
      ),
    );
    editor.setText(`Use ${sigil}fi`);
    editor.handleInput("\t");
    await setTimeout(40);
    assert.ok(editor.isShowingAutocomplete(), sigil);
    const rendered = editor.render(50);
    const bottom = plain(rendered).findIndex((line) => line.startsWith("╰"));
    assert.ok(bottom >= 2);
    assert.ok(rendered.length > bottom + 1);
    assert.ok(
      rendered.slice(bottom + 1).every((line) => !line.startsWith("│")),
    );
    assert.equal(
      rendered.filter((line) => line.includes(CURSOR_MARKER)).length,
      1,
    );
    for (const line of rendered) assert.ok(visibleWidth(line) <= 50);
    editor.handleInput("\t");
    assert.ok(editor.getText().startsWith(`Use ${sigil}first`));
    assert.ok(!editor.getText().includes("//skill:"));
    assert.ok(!editor.isShowingAutocomplete());
  }
});

test("mouse coordinates account for the outer border, without changing native text geometry", () => {
  const { editor, native } = fixture();
  editor.setText("hello world");
  native.setText("hello world");
  editor.render(30);
  native.render(28);
  const event: TuiMouseEvent = {
    type: "click",
    button: "left",
    x: 5,
    y: 1,
    screenX: 5,
    screenY: 1,
    width: 30,
    height: 3,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
  assert.deepEqual(
    editor.handleMouse(event),
    native.handleMouse({ ...event, x: 4, width: 28 }),
  );
  assert.deepEqual(editor.getCursor(), native.getCursor());
  assert.equal(editor.handleMouse({ ...event, x: 0 }), undefined);
});

test("extension installs nothing outside TUI and respects another editor factory", () => {
  let start:
    ((event: SessionStartEvent, ctx: ExtensionContext) => void) | undefined;
  const pi = {
    on(name: string, handler: typeof start) {
      if (name === "session_start") start = handler;
    },
  } as unknown as ExtensionAPI;
  promptBox(pi);
  assert.ok(start);
  let installations = 0;
  const ctx = {
    mode: "print",
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: () => {
        installations++;
      },
    },
  } as unknown as ExtensionContext;
  start({ type: "session_start", reason: "startup" }, ctx);
  const occupied = {
    ...ctx,
    mode: "tui",
    ui: { ...ctx.ui, getEditorComponent: () => () => fixture().editor },
  } as ExtensionContext;
  start({ type: "session_start", reason: "startup" }, occupied);
  assert.equal(installations, 0);
});
