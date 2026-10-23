import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ImagePathLabels } from "./images.ts";

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "prompt-images-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const image = (name: string) => {
    const path = join(cwd, name);
    writeFileSync(path, "fixture");
    return path;
  };
  return { cwd, image, labels: new ImagePathLabels({ cwd, home: cwd }) };
}

test("collapses local images and expands their original input spelling", (t) => {
  const { image, labels } = fixture(t);
  const first = image("first.png");
  const second = image("second.JPG");
  const text = `Compare ${first} with ${second}\nKeep this text.`;
  assert.equal(
    labels.collapse(text),
    "Compare [Image #1] with [Image #2]\nKeep this text.",
  );
  assert.equal(labels.expand(labels.collapse(text)), text);
});

test("handles CleanShot shell-escaped spaces, including Unicode spaces", (t) => {
  const { image, labels } = fixture(t);
  const path = image("CleanShot 2026-06-30 at 10.20.30@2x.png");
  const escaped = path.replaceAll(" ", "\\ ");
  const unicode = image("CleanShot 10.20.30\u202fAM.png").replaceAll(
    " ",
    "\\ ",
  );
  const text = `Look at ${escaped} and ${unicode}`;
  assert.equal(labels.collapse(text), "Look at [Image #1] and [Image #2]");
  assert.equal(labels.expand(labels.collapse(text)), text);
});

test("accepts whole-line paths with spaces and preserves line whitespace", (t) => {
  const { image, labels } = fixture(t);
  const path = image("a screenshot with spaces.png");
  const text = `Before\r\n  ${path}  \r\nAfter\n`;
  assert.equal(labels.collapse(text), "Before\r\n  [Image #1]  \r\nAfter\n");
  assert.equal(labels.expand(labels.collapse(text)), text);
});

test("handles quoted, relative, and tilde paths", (t) => {
  const { image, labels } = fixture(t);
  image("one picture.webp");
  image("two pictures.gif");
  image("three.png");
  const text = `Compare "./one picture.webp" with '~/two pictures.gif' and three.png`;
  assert.equal(
    labels.collapse(text),
    "Compare [Image #1] with [Image #2] and [Image #3]",
  );
  assert.equal(labels.expand(labels.collapse(text)), text);
});

test("numbering survives repeated collapse, expansion, and history reordering", (t) => {
  const { image, labels, cwd } = fixture(t);
  const first = image("one.png");
  const second = image("two.png");
  assert.equal(labels.collapse(first), "[Image #1]");
  assert.equal(labels.collapse(second), "[Image #2]");
  assert.equal(labels.collapse("./one.png"), "[Image #1]");
  assert.equal(labels.collapse(`${cwd}/./one.png`), "[Image #1]");
  assert.equal(
    labels.collapse(`${second}\n${first}`),
    "[Image #2]\n[Image #1]",
  );
  assert.equal(labels.collapse("[Image #1]"), "[Image #1]");
  assert.equal(labels.expand("[Image #2] [Image #1]"), `${second} ${first}`);
  assert.equal(labels.collapse(labels.expand("[Image #1]")), "[Image #1]");
});

test("unknown labels, nonexistent paths, nonimages, and directories are unchanged", (t) => {
  const { image, labels, cwd } = fixture(t);
  const document = image("notes.txt");
  const directory = join(cwd, "directory.png");
  mkdirSync(directory);
  const text = `${document}\n${directory}\nmissing.png\nhttps://example.com/a.png\n~someone/a.png\nplain words`;
  assert.equal(labels.collapse(text), text);
  assert.equal(
    labels.expand("[Image #99] [Image #0] [Image #x]"),
    "[Image #99] [Image #0] [Image #x]",
  );
  assert.equal(labels.collapse(image("real.png")), "[Image #1]");
});

test("bash and slash commands are never transformed", (t) => {
  const { image, labels } = fixture(t);
  const path = image("one.png");
  labels.collapse(path);
  for (const text of [
    `!open ${path}`,
    `  !!echo ${path}`,
    `/test ${path}`,
    `/my-command ${path}\n${path}`,
    `!echo [Image #1]\n${path}`,
    "/test [Image #1]",
  ]) {
    assert.equal(labels.collapse(text), text);
    assert.equal(labels.expand(text), text);
  }
  assert.equal(
    labels.collapse(`Text\n!open ${path}\n/test ${path}`),
    `Text\n!open ${path}\n/test ${path}`,
  );
});

test("history labels still expand after the original image is deleted", (t) => {
  const { image, labels } = fixture(t);
  const path = image("old.png");
  assert.equal(labels.collapse(path), "[Image #1]");
  rmSync(path);
  assert.equal(labels.expand("[Image #1]"), path);
  assert.equal(labels.collapse(path), path);
});

test("instances do not share numbering", (t) => {
  const { image, labels, cwd } = fixture(t);
  labels.collapse(image("one.png"));
  const second = image("two.png");
  assert.equal(labels.collapse(second), "[Image #2]");
  assert.equal(new ImagePathLabels({ cwd }).collapse(second), "[Image #1]");
});
