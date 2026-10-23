import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createTerminalManager,
  MAX_RUNNING,
  MAX_TRACKED,
  RETAINED_PER_STREAM,
  type TerminalManagerShape,
} from "./src/manager.ts";

const cwd = process.cwd();
const nodeCmd = (script: string) => `node -e '${script}'`;
const forever = nodeCmd("setInterval(() => {}, 1000)");
const resistant = `exec ${nodeCmd('process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);')}`;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function pollUntil(check: () => boolean, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition reached before deadline");
    await delay(25);
  }
}
function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
async function withManager(
  run: (manager: TerminalManagerShape) => Promise<void>,
) {
  const manager = createTerminalManager();
  try {
    await run(manager);
  } finally {
    await manager.dispose();
  }
}
async function settlement(manager: TerminalManagerShape, id: string) {
  await pollUntil(() => manager.view.get(id)?.status !== "running");
  const snap = manager.view.get(id);
  assert.ok(snap);
  return snap;
}

test("stdout/stderr captured separately; flushed private spills precede exactly one unconsumed hook", async () => {
  await withManager(async (m) => {
    const hooks: boolean[] = [];
    m.view.setOnSettled((s, consumed) => {
      hooks.push(consumed);
      assert.ok(s.stdout.spillPath);
      assert.equal(fs.readFileSync(s.stdout.spillPath, "utf8"), "out-line\n");
    });
    const s = await m.start({
      command: nodeCmd(
        'process.stdout.write("out-line\\n"); process.stderr.write("err-line\\n");',
      ),
      title: "happy",
      cwd,
    });
    assert.equal(s.status, "running");
    assert.ok(s.pid);
    const done = await settlement(m, s.id);
    assert.equal(done.status, "done");
    assert.equal(done.exitCode, 0);
    assert.equal(done.signal, undefined);
    assert.equal(done.stdout.text, "out-line\n");
    assert.equal(done.stderr.text, "err-line\n");
    assert.ok(done.settledAt);
    assert.deepEqual(hooks, [false]);
    assert.ok(done.stdout.spillPath);
    assert.ok(done.stderr.spillPath);
    assert.equal(fs.readFileSync(done.stderr.spillPath, "utf8"), "err-line\n");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(done.stdout.spillPath).mode & 0o777, 0o600);
      assert.equal(
        fs.statSync(dirname(done.stdout.spillPath)).mode & 0o777,
        0o700,
      );
    }
  });
});
test("nonzero exit is failed with the truthful code", async () => {
  await withManager(async (m) => {
    const s = await m.start({
      command: nodeCmd("process.exit(3)"),
      title: "fails",
      cwd,
    });
    const done = await settlement(m, s.id);
    assert.equal(done.status, "failed");
    assert.equal(done.exitCode, 3);
  });
});
test("background stdin is EOF, not an interactive input channel", async () => {
  await withManager(async (m) => {
    const s = await m.start({
      command: nodeCmd(
        'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("EOF\\n"));',
      ),
      title: "stdin",
      cwd,
    });
    await settlement(m, s.id);
    assert.equal(s.status, "done");
    assert.equal(s.stdout.text, "EOF\n");
  });
});
test("kill waits for settlement, repeat kill is a no-op, consumed hook fires once", async () => {
  await withManager(async (m) => {
    const hooks: boolean[] = [];
    m.view.setOnSettled((_s, c) => hooks.push(c));
    const s = await m.start({ command: forever, title: "immortal", cwd });
    const [first] = await m.kill([s.id]);
    assert.equal(first.status, "killed");
    assert.equal(first.killed, true);
    assert.equal(first.wasRunning, true);
    assert.match(first.exit, /^SIG/);
    assert.equal(m.view.get(s.id)?.status, "killed");
    const [second] = await m.kill([s.id]);
    assert.equal(second.killed, false);
    assert.equal(second.wasRunning, false);
    assert.equal(second.status, "killed");
    assert.deepEqual(hooks, [true]);
  });
});
test(
  "SIGTERM-resistant process escalates to SIGKILL within bound",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (m) => {
      const s = await m.start({ command: resistant, title: "resistant", cwd });
      await pollUntil(() => s.stdout.text.includes("ready"));
      const start = Date.now();
      const [result] = await m.kill([s.id]);
      assert.equal(result.status, "killed");
      assert.equal(s.signal, "SIGKILL");
      assert.match(s.stdout.text, /term/);
      assert.ok(Date.now() - start >= 1500);
      assert.ok(Date.now() - start < 4500);
    });
  },
);
test("overlapping multi-id kills observe each settlement exactly once", async () => {
  await withManager(async (m) => {
    const hooks: string[] = [];
    m.view.setOnSettled((s, c) => {
      assert.equal(c, true);
      hooks.push(s.id);
    });
    const [a, b] = await Promise.all(
      ["first", "second"].map((title) =>
        m.start({ command: forever, title, cwd }),
      ),
    );
    const reports = await Promise.all([
      m.kill([a.id, b.id, a.id]),
      m.kill([b.id, a.id]),
    ]);
    assert.deepEqual(
      reports.map((r) => r.map((s) => s.id)),
      [
        [a.id, b.id],
        [b.id, a.id],
      ],
    );
    assert.ok(reports.flat().every((s) => s.status === "killed"));
    assert.deepEqual(hooks.sort(), [a.id, b.id].sort());
  });
});
test(
  "kill reaps the whole tree and stops its unique heartbeat",
  { skip: process.platform === "win32" },
  async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "bt-tree-test-"));
    const file = join(dir, "heartbeat");
    try {
      await withManager(async (m) => {
        const s = await m.start({
          command: `node -e 'const fs = require("node:fs"); const file = ${JSON.stringify(file)}; let n = 0; fs.writeFileSync(file, String(n)); setInterval(() => fs.writeFileSync(file, String(++n)), 25)' & echo "child:$!"; wait`,
          title: "tree",
          cwd,
        });
        await pollUntil(
          () => s.stdout.text.includes("child:") && fs.existsSync(file),
        );
        const match = /child:(\d+)/.exec(s.stdout.text);
        assert.ok(match);
        const pid = Number(match[1]);
        assert.equal(processGone(pid), false);
        const before = fs.readFileSync(file, "utf8");
        await pollUntil(() => fs.readFileSync(file, "utf8") !== before);
        await m.kill([s.id]);
        await pollUntil(() => processGone(pid));
        const after = fs.readFileSync(file, "utf8");
        await delay(100);
        assert.equal(fs.readFileSync(file, "utf8"), after);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
for (const explicitKill of [false, true]) {
  test(
    `shell exit with inherited pipes: ${explicitKill ? "kill preserves natural status" : "automatic cleanup reaps descendants"}`,
    { skip: process.platform === "win32" },
    async () => {
      await withManager(async (m) => {
        const s = await m.start({
          command: `node -e "setInterval(()=>{},1e3)" & echo "child:$!"; exit 0`,
          title: "exited-shell",
          cwd,
        });
        await pollUntil(() => s.stdout.text.includes("child:"));
        assert.ok(s.pid);
        await pollUntil(() => processGone(s.pid!));
        assert.equal(s.status, "running");
        const match = /child:(\d+)/.exec(s.stdout.text);
        assert.ok(match);
        if (explicitKill) {
          const [r] = await m.kill([s.id]);
          assert.equal(r.wasRunning, true);
          assert.equal(r.killed, false);
          assert.equal(r.exit, "exit 0");
        }
        await settlement(m, s.id);
        assert.equal(s.status, "done");
        assert.equal(s.exitCode, 0);
        await pollUntil(() => processGone(Number(match[1])));
      });
    },
  );
}
test("max8 is race-free; failed command releases its slot", async () => {
  await withManager(async (m) => {
    const spawns = await Promise.all(
      Array.from({ length: MAX_RUNNING }, (_, n) =>
        m.start({ command: forever, title: `filler-${n}`, cwd }),
      ),
    );
    await assert.rejects(
      m.start({ command: "true", title: "extra", cwd }),
      /Max 8 background terminals/,
    );
    await m.kill([spawns[0].id]);
    const bogus = await m.start({
      command: "definitely-not-a-real-binary-12345",
      title: "bogus",
      cwd,
    });
    assert.equal((await settlement(m, bogus.id)).status, "failed");
    assert.equal(
      (await m.start({ command: forever, title: "refill", cwd })).status,
      "running",
    );
  });
});

for (const shellWaits of [false, true]) {
  test(
    `redirected TERM-resistant descendant is reaped after ${shellWaits ? "kill" : "natural exit"}`,
    { skip: process.platform === "win32" },
    async () => {
      const dir = fs.mkdtempSync(join(tmpdir(), "bt-redirected-test-"));
      const ready = join(dir, "ready");
      try {
        await withManager(async (m) => {
          const script = `const fs=require("node:fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(ready)},"ready"); setInterval(()=>{},1000);`;
          const s = await m.start({
            command: `${nodeCmd(script)} >/dev/null 2>&1 & echo "child:$!"; ${shellWaits ? "wait" : "exit 0"}`,
            title: "redirected",
            cwd,
          });
          await pollUntil(
            () => s.stdout.text.includes("child:") && fs.existsSync(ready),
          );
          const match = /child:(\d+)/.exec(s.stdout.text);
          assert.ok(match);
          const pid = Number(match[1]);
          if (shellWaits) await m.kill([s.id]);
          await pollUntil(() => processGone(pid));
          assert.equal(s.status, shellWaits ? "killed" : "done");
          if (!shellWaits) assert.equal(s.exitCode, 0);
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

test("UI kill is not consumed", async () => {
  await withManager(async (m) => {
    const hooks: boolean[] = [];
    m.view.setOnSettled((_s, c) => hooks.push(c));
    const s = await m.start({ command: forever, title: "ui-kill", cwd });
    m.view.requestKill(s.id);
    assert.equal((await settlement(m, s.id)).status, "killed");
    assert.deepEqual(hooks, [false]);
  });
});
test("dispose kills processes, suppresses hooks, removes private spills, is idempotent, and rejects late starts", async () => {
  const m = createTerminalManager();
  const hooks: string[] = [];
  m.view.setOnSettled((s) => hooks.push(s.id));
  const s = await m.start({ command: forever, title: "disposed", cwd });
  assert.ok(s.pid);
  assert.ok(s.stdout.spillPath);
  const dir = dirname(s.stdout.spillPath);
  await m.dispose();
  await m.dispose();
  await pollUntil(() => processGone(s.pid!));
  assert.deepEqual(hooks, []);
  assert.equal(fs.existsSync(dir), false);
  await assert.rejects(
    m.start({ command: "true", title: "late", cwd }),
    /shutting down/,
  );
});
test("pruning retains running and newest entries; historical kill remains truthful", async () => {
  await withManager(async (m) => {
    const keeper = await m.start({ command: forever, title: "keeper", cwd });
    const ids: string[] = [];
    for (let i = 0; i < MAX_TRACKED + 4; i++) {
      const s = await m.start({ command: "true", title: `quick-${i}`, cwd });
      ids.push(s.id);
      await settlement(m, s.id);
    }
    const remaining = m.view.list().map((s) => s.id);
    assert.ok(remaining.length <= MAX_TRACKED);
    assert.ok(remaining.includes(keeper.id));
    assert.ok(!remaining.includes(ids[0]));
    assert.ok(remaining.includes(ids.at(-1)!));
    const [r] = await m.kill([ids[0]]);
    assert.equal(r.title, "quick-0");
    assert.equal(r.status, "done");
    assert.equal(r.wasRunning, false);
    assert.equal(r.killed, false);
    // The earliest start is now the newest settlement. Pruning must follow
    // settlement order, not map insertion/start order.
    await m.kill([keeper.id]);
    const extra = await m.start({ command: "true", title: "extra", cwd });
    await settlement(m, extra.id);
    assert.ok(m.view.get(keeper.id));
  });
});
test("unknown command explains shell failure; spawn error has no bogus exit code", async () => {
  await withManager(async (m) => {
    const command = await m.start({
      command: "definitely-not-a-real-binary-12345",
      title: "bogus",
      cwd,
    });
    await settlement(m, command.id);
    assert.equal(command.status, "failed");
    assert.notEqual(command.exitCode, 0);
    assert.ok(command.stderr.text);
    const bad = await m.start({
      command: "true",
      title: "bad-cwd",
      cwd: "/definitely/not/a/real/dir-12345",
    });
    await settlement(m, bad.id);
    assert.equal(bad.status, "failed");
    assert.match(bad.errorText ?? "", /ENOENT/);
    assert.equal(bad.exitCode, undefined);
    assert.equal(bad.signal, undefined);
  });
});
test("firehose memory is bounded and full spill is flushed before hook", async () => {
  await withManager(async (m) => {
    const bytes = 3 * 1024 * 1024;
    let size = -1;
    m.view.setOnSettled((s) => {
      assert.ok(s.stdout.spillPath);
      size = fs.statSync(s.stdout.spillPath).size;
    });
    const s = await m.start({
      command: nodeCmd(
        `const s = "x".repeat(65536); for (let i=0;i<48;i++) process.stdout.write(s);`,
      ),
      title: "firehose",
      cwd,
    });
    await settlement(m, s.id);
    assert.equal(s.status, "done");
    assert.equal(s.stdout.totalBytes, bytes);
    assert.ok(s.stdout.truncatedBytes > 0);
    assert.ok(Buffer.byteLength(s.stdout.text) <= RETAINED_PER_STREAM);
    assert.equal(size, bytes);
  });
});
test("aborting kill wait does not cancel escalation and releases consumption interest", async () => {
  await withManager(async (m) => {
    const hooks: boolean[] = [];
    m.view.setOnSettled((_s, c) => hooks.push(c));
    const s = await m.start({
      command: process.platform === "win32" ? forever : resistant,
      title: "abort-race",
      cwd,
    });
    assert.ok(s.pid);
    if (process.platform !== "win32")
      await pollUntil(() => s.stdout.text.includes("ready"));
    const c = new AbortController();
    const work = m.kill([s.id], c.signal);
    c.abort();
    await assert.rejects(work, /aborted/);
    await settlement(m, s.id);
    assert.equal(s.status, "killed");
    if (process.platform !== "win32") {
      assert.equal(s.signal, "SIGKILL");
      assert.deepEqual(hooks, [false]);
    }
    await pollUntil(() => processGone(s.pid!));
  });
});
test("status returns snapshot and unknown error lists known ids", async () => {
  await withManager(async (m) => {
    const s = await m.start({ command: "true", title: "status", cwd });
    assert.equal(await m.status(s.id), s);
    await assert.rejects(
      m.status("bt-999"),
      /Unknown terminal id "bt-999"\. Known: bt-1\./,
    );
  });
});
