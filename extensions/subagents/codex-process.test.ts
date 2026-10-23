import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { codexBackend } from "./src/backends/codex.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

// A local protocol fixture, never the installed Codex executable or a provider.
const server = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync('server.pid', String(process.pid));
process.on('SIGTERM', () => {}); // Exercise the force-kill deadline on disposal.
const send = (message) => console.log(JSON.stringify(message));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') send({ id, result: {} });
  if (method === 'thread/start') send({ id, result: { thread: { id: 'thread' }, model: 'offline' } });
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'turn' } } });
    if (params.input[0].text === 'complete') {
      send({ method: 'item/completed', params: { turnId: 'turn', item: { type: 'agentMessage', text: 'offline output' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
    }
  }
  if (method === 'turn/interrupt') {
    send({ id, result: {} });
    send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'interrupted' } } });
  }
});
`;

test(
  "offline Codex transport returns output, cancels, and reaps its process",
  {
    skip: process.platform === "win32",
    timeout: 15_000,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagents-codex-offline-"));
    const previousPath = process.env.PATH;
    const runtime = ManagedRuntime.make(
      SubagentManagerLive.pipe(
        Layer.provide(
          Layer.succeed(BackendRegistry, new Map([["codex", codexBackend]])),
        ),
      ),
    );
    const pids: number[] = [];
    try {
      await writeFile(join(dir, "codex"), server, { mode: 0o755 });
      process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
      const manager = await runtime.runPromise(SubagentManager);
      for (const prompt of ["complete", "keep running"]) {
        const snap = await runTool(
          runtime,
          manager.spawn("codex", {
            prompt,
            title: prompt,
            cwd: dir,
            parent: { parentCwd: dir, projectTrusted: false },
          }),
        );
        pids.push(Number(await readFile(join(dir, "server.pid"), "utf8")));
        if (prompt === "complete") {
          await runTool(runtime, manager.waitFor([snap.id]));
          assert.equal(snap.status, "done");
          assert.equal(snap.finalText, "offline output");
        } else {
          const report = await runTool(runtime, manager.cancel([snap.id]));
          assert.equal(report[0]?.cancelled, true);
          assert.equal(snap.errorText, "Run was aborted");
        }
      }
      await runtime.dispose();
      for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    } finally {
      await runtime.dispose();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
