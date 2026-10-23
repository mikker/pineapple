import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildFdArgs,
  buildRgArgs,
  FD_DEFAULT_LIMIT,
  normalizeSearchPath,
} from "./src/args.ts";
import { resolveBinary } from "./src/binaries.ts";
import { formatCapturedOutput } from "./src/output.ts";
import { discardCapturedOutput, executeSearchProcess } from "./src/process.ts";
import { runSearch } from "./index.ts";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-search-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("fd defaults and safe option translation", () => {
  assert.deepEqual(buildFdArgs({}), [
    "--color=never",
    "--max-results",
    String(FD_DEFAULT_LIMIT),
    "--",
    "",
  ]);
  assert.deepEqual(
    buildFdArgs({
      pattern: "-rf",
      path: "@src",
      type: "file",
      extension: ".ts",
      glob: true,
      hidden: true,
      max_depth: 3,
      limit: 50,
    }),
    [
      "--color=never",
      "--hidden",
      "--glob",
      "--type",
      "f",
      "--extension",
      "ts",
      "--max-depth",
      "3",
      "--max-results",
      "50",
      "--",
      "-rf",
      "src",
    ],
  );
  assert.deepEqual(buildFdArgs({ max_depth: 500, limit: 1e6 }), [
    "--color=never",
    "--max-depth",
    "64",
    "--max-results",
    "10000",
    "--",
    "",
  ]);
});
test("rg defaults and all options stay separate argv entries", () => {
  assert.deepEqual(buildRgArgs({ pattern: "--help" }), [
    "--line-number",
    "--color=never",
    "--no-heading",
    "--with-filename",
    "--smart-case",
    "--max-count",
    "100",
    "--",
    "--help",
  ]);
  assert.deepEqual(
    buildRgArgs({
      pattern: "TODO",
      path: "@lib",
      glob: "*.ts",
      file_type: "ts",
      case_sensitive: true,
      fixed_strings: true,
      hidden: true,
      context: 2,
      limit: 10,
    }),
    [
      "--line-number",
      "--color=never",
      "--no-heading",
      "--with-filename",
      "--case-sensitive",
      "--fixed-strings",
      "--hidden",
      "--context",
      "2",
      "--glob",
      "*.ts",
      "--type",
      "ts",
      "--max-count",
      "10",
      "--",
      "TODO",
      "lib",
    ],
  );
  const insensitive = buildRgArgs({ pattern: "x", case_sensitive: false });
  assert.ok(insensitive.includes("--ignore-case"));
  assert.ok(!insensitive.includes("--smart-case"));
});
test("path normalization strips @ and expands ~", () => {
  assert.equal(normalizeSearchPath("@src/lib"), "src/lib");
  assert.equal(normalizeSearchPath("~"), homedir());
  assert.equal(normalizeSearchPath("~/projects"), join(homedir(), "projects"));
  assert.equal(normalizeSearchPath(" plain "), "plain");
});
test("installed binary lookup is offline, supports fdfind, and reports missing executables independently", async () => {
  await fixture(async (dir) => {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const fake = async (name: string) => {
      const file = join(dir, name + suffix);
      await writeFile(file, "fake");
      await chmod(file, 0o700);
      return file;
    };
    assert.throws(() => resolveBinary("fd", dir), /not installed.*Install fd/);
    const rg = await fake("rg");
    assert.equal(resolveBinary("rg", dir), rg);
    assert.throws(() => resolveBinary("fd", dir), /never downloads/);
    const fdfind = await fake("fdfind");
    assert.equal(resolveBinary("fd", dir), fdfind);
    const fd = await fake("fd");
    assert.equal(resolveBinary("fd", dir), fd);
  });
});
test("streamed output has a bounded head and complete private spill before returning", async () => {
  const result = await executeSearchProcess({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("line\\n".repeat(3000))'],
    cwd: process.cwd(),
    tempPrefix: "pi-search-test-",
  });
  try {
    const formatted = formatCapturedOutput(result.output);
    assert.equal(result.code, 0);
    assert.equal(formatted.truncated, true);
    assert.equal(formatted.lineCount, 3000);
    assert.match(formatted.text, /2000 of 3000 lines/);
    assert.ok(formatted.fullOutputPath);
    assert.equal(
      await readFile(formatted.fullOutputPath, "utf8"),
      "line\n".repeat(3000),
    );
    if (process.platform !== "win32")
      assert.equal((await stat(formatted.fullOutputPath)).mode & 0o777, 0o600);
  } finally {
    await discardCapturedOutput(result.output);
  }
});
test("huge single lines and split UTF-8 are bounded without losing the full file", async () => {
  const result = await executeSearchProcess({
    command: process.execPath,
    args: [
      "-e",
      'const b=Buffer.from("🍍".repeat(30000)); process.stdout.write(b.subarray(0,3)); setTimeout(()=>process.stdout.write(b.subarray(3)),10)',
    ],
    cwd: process.cwd(),
    tempPrefix: "pi-search-test-",
  });
  try {
    assert.equal(result.output.totalBytes, 120000);
    assert.equal(result.output.lineCount, 1);
    assert.ok(Buffer.byteLength(result.output.preview) <= 50 * 1024);
    assert.ok(result.output.fullOutputPath);
    assert.equal(
      await readFile(result.output.fullOutputPath, "utf8"),
      "🍍".repeat(30000),
    );
    assert.ok(!result.output.preview.includes("�"));
  } finally {
    await discardCapturedOutput(result.output);
  }
});
test("spawn argv is literal, stdin is EOF, and small output needs no spill pointer", async () => {
  const args = [
    "--help",
    "$(touch nope)",
    "a b; echo nope",
    "quote'\"",
    "*.ts",
  ];
  const result = await executeSearchProcess({
    command: process.execPath,
    args: [
      "-e",
      'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write(JSON.stringify(process.argv.slice(1))))',
      "--",
      ...args,
    ],
    cwd: process.cwd(),
    tempPrefix: "pi-search-test-",
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.output.preview), args);
  assert.equal(result.output.fullOutputPath, undefined);
});
test("rg no-match is distinct from failures, diagnostics, and partial output", async () => {
  await fixture(async (dir) => {
    const script = join(dir, "fake.cjs");
    await writeFile(script, "process.exit(1)");
    const no = await runSearch(
      "rg",
      [script],
      dir,
      undefined,
      process.execPath,
    );
    assert.equal(no.noMatches, true);
    await assert.rejects(
      runSearch("fd", [script], dir, undefined, process.execPath),
      /fd failed.*exit code 1/,
    );
    await writeFile(
      script,
      'process.stderr.write("bad pattern"); process.exit(1)',
    );
    await assert.rejects(
      runSearch("rg", [script], dir, undefined, process.execPath),
      /rg failed: bad pattern/,
    );
    await writeFile(
      script,
      'process.stdout.write("partial\\n"); process.exit(2)',
    );
    await assert.rejects(
      runSearch("rg", [script], dir, undefined, process.execPath),
      /exit code 2/,
    );
    await writeFile(
      script,
      'process.stdout.write("partial\\n"); process.exit(1)',
    );
    await assert.rejects(
      runSearch("rg", [script], dir, undefined, process.execPath),
      /exit code 1/,
    );
    await writeFile(script, 'process.stdout.write("found\\n")');
    assert.equal(
      (await runSearch("fd", [script], dir, undefined, process.execPath)).text,
      "found",
    );
  });
});
test("missing command, timeout, pre-abort and in-flight cancellation reject", async () => {
  const options = {
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    tempPrefix: "pi-search-test-",
  };
  await assert.rejects(
    executeSearchProcess({
      ...options,
      command: "/definitely/not/a/real/command",
    }),
    /ENOENT/,
  );
  await assert.rejects(
    executeSearchProcess({ ...options, timeout: 40 }),
    /timed out/,
  );
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    executeSearchProcess({ ...options, signal: pre.signal }),
    /abort/i,
  );
  const controller = new AbortController();
  const work = executeSearchProcess({ ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(work, /cancelled/);
});
test(
  "cancellation kills the search process group including grandchildren",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(async (dir) => {
      const file = join(dir, "pid");
      const script = `const {spawn}=require("node:child_process"); const fs=require("node:fs"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); fs.writeFileSync(${JSON.stringify(file)},String(child.pid)); setInterval(()=>{},1000);`;
      const controller = new AbortController();
      const work = executeSearchProcess({
        command: process.execPath,
        args: ["-e", script],
        cwd: dir,
        tempPrefix: "pi-search-test-",
        signal: controller.signal,
      });
      const observed = assert.rejects(work, /cancelled/);
      const deadline = Date.now() + 5000;
      let pid: number | undefined;
      while (Date.now() < deadline) {
        try {
          pid = Number(await readFile(file, "utf8"));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      controller.abort();
      await observed;
      assert.ok(pid);
      let gone = false;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          gone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(gone, true);
    });
  },
);
test("captured output trims small results and consistently formats truncation pointers", () => {
  const small = formatCapturedOutput({
    preview: "a.ts\nb.ts\n",
    lineCount: 2,
    totalBytes: 10,
    truncated: false,
  });
  assert.equal(small.text, "a.ts\nb.ts");
  assert.equal(small.lineCount, 2);
  assert.equal(small.truncated, false);
  assert.equal(small.fullOutputPath, undefined);
  const formatted = formatCapturedOutput({
    preview: Array.from({ length: 2000 }, (_, i) => `file-${i}.ts`).join("\n"),
    lineCount: 3000,
    totalBytes: 40000,
    truncated: true,
    fullOutputPath: "/tmp/fake/output.txt",
  });
  assert.equal(formatted.truncated, true);
  assert.equal(formatted.fullOutputPath, "/tmp/fake/output.txt");
  assert.match(formatted.text, /2000 of 3000 lines/);
  assert.match(
    formatted.text,
    /Full output saved to: \/tmp\/fake\/output\.txt/,
  );
  assert.equal(formatted.text.split("\n")[0], "file-0.ts");
});
