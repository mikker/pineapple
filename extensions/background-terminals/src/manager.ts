/** Session-owned native processes. One close/flush/settle path, one stop promise. */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatExit,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./domain.ts";
import { OutputBuffer } from "./output.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
export const MAX_SPILL_BYTES_PER_STREAM = 256 * 1024 * 1024;

export interface StartOptions {
  command: string;
  title: string;
  cwd: string;
}
export interface KillResult {
  id: string;
  title: string;
  status: TerminalStatus;
  wasRunning: boolean;
  killed: boolean;
  exit: string;
}
export interface TerminalReadModel {
  list(): readonly TerminalSnapshot[];
  get(id: string): TerminalSnapshot | undefined;
  size(): number;
  subscribe(listener: () => void): () => void;
  requestKill(id: string): void;
  setOnSettled(
    hook: ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}
type MutableSnapshot = {
  -readonly [K in keyof TerminalSnapshot]: TerminalSnapshot[K];
};
interface Entry {
  snapshot: MutableSnapshot;
  child: ChildProcess;
  buffers: OutputBuffer[];
  spills: fs.WriteStream[];
  exited: boolean;
  closed: boolean;
  processErrored: boolean;
  killSignaled: boolean;
  interest: number;
  settled: Promise<void>;
  resolveSettled: () => void;
  finishing?: Promise<void>;
  stopping?: Promise<void>;
  stopped?: boolean;
  exitTimer?: ReturnType<typeof setTimeout>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function within(work: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill",
      [
        "/pid",
        String(child.pid),
        "/T",
        ...(signal === "SIGKILL" ? ["/F"] : []),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const fallback = () => {
      try {
        child.kill(signal);
      } catch {}
    };
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    killer.unref();
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* Already gone. */
    }
  }
}

function groupAlive(entry: Entry) {
  if (process.platform === "win32") return !entry.closed;
  if (!entry.child.pid) return false;
  try {
    process.kill(-entry.child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createTerminalManager() {
  const entries = new Map<string, Entry>();
  const history = new Map<
    string,
    Pick<KillResult, "title" | "status" | "exit">
  >();
  const listeners = new Set<() => void>();
  let counter = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let spillDir: string | undefined;
  let onSettled: Parameters<TerminalReadModel["setOnSettled"]>[0];

  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Rendering cannot break lifecycle state. */
      }
    }
  }
  function prune() {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (entry) =>
          entry.snapshot.status !== "running" &&
          !entry.interest &&
          !entry.exitTimer &&
          (!entry.stopping || entry.stopped),
      )
      .sort(
        (a, b) => (a.snapshot.settledAt ?? 0) - (b.snapshot.settledAt ?? 0),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
    }
  }
  function finish(entry: Entry) {
    return (entry.finishing ??= (async () => {
      const flushed = await within(
        Promise.all(
          entry.spills.map(
            (file) =>
              new Promise<void>((resolve) => {
                if (file.destroyed || file.writableFinished) return resolve();
                file.once("close", resolve);
                file.end(resolve);
              }),
          ),
        ),
        1500,
      );
      if (!flushed) {
        for (const buf of entry.buffers) buf.spillPath = undefined;
        entry.snapshot.errorText ??=
          "Full-log spill flush timed out; output may be incomplete";
        for (const file of entry.spills) file.destroy();
      }
      const s = entry.snapshot;
      s.settledAt = Date.now();
      s.status = entry.killSignaled
        ? "killed"
        : entry.processErrored
          ? "failed"
          : s.exitCode === 0
            ? "done"
            : "failed";
      history.set(s.id, {
        title: s.title,
        status: s.status,
        exit: formatExit(s),
      });
      while (history.size > MAX_TRACKED * 4)
        history.delete(history.keys().next().value!);
      entry.resolveSettled();
      notify();
      try {
        if (!disposed) onSettled?.(s, entry.interest > 0);
      } catch {
        /* Session gone. */
      }
      prune();
    })());
  }
  function stop(entry: Entry) {
    return (entry.stopping ??= (async () => {
      clearTimeout(entry.exitTimer);
      entry.exitTimer = undefined;
      if (!entry.stopped && (!entry.closed || groupAlive(entry))) {
        entry.killSignaled ||=
          !entry.exited && entry.snapshot.status === "running";
        killTree(entry.child, "SIGTERM");
        const deadline = Date.now() + 2000;
        // A descendant may close its pipes but ignore TERM. Pipe closure alone
        // is not proof that the process group has died.
        while (Date.now() < deadline && (!entry.closed || groupAlive(entry)))
          await delay(25);
        if (!entry.closed || groupAlive(entry))
          killTree(entry.child, "SIGKILL");
        if (!entry.closed) await within(entry.settled, 500);
      }
      if (!entry.closed) {
        entry.snapshot.errorText ??=
          "stdio did not close after termination; output may be incomplete";
        entry.child.stdout?.destroy();
        entry.child.stderr?.destroy();
      }
      await finish(entry);
      clearTimeout(entry.exitTimer);
      entry.exitTimer = undefined;
      entry.stopped = true;
      prune();
    })());
  }

  function spill(entry: Entry, buf: OutputBuffer, stream: "stdout" | "stderr") {
    try {
      spillDir ??= fs.mkdtempSync(join(tmpdir(), "pi-background-terminals-"));
      const filePath = join(spillDir, `${entry.snapshot.id}.${stream}.log`);
      const file = fs.createWriteStream(filePath, { flags: "wx", mode: 0o600 });
      entry.spills.push(file);
      buf.spillPath = filePath;
      let bytes = 0;
      let broken = false;
      file.on("error", (error) => {
        broken = true;
        buf.spillPath = undefined;
        entry.snapshot.errorText ??=
          `Full-log spill failed: ${error.message}`.slice(0, 4096);
        entry.child[stream]?.resume();
      });
      return (chunk: string) => {
        if (broken || file.writableEnded) return true;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_SPILL_BYTES_PER_STREAM) {
          broken = true;
          buf.spillPath = undefined;
          entry.snapshot.errorText ??= `${stream} full-log spill reached the ${MAX_SPILL_BYTES_PER_STREAM}-byte safety limit`;
          file.end();
          return true;
        }
        const accepted = file.write(chunk);
        if (!accepted) file.once("drain", () => entry.child[stream]?.resume());
        return accepted;
      };
    } catch (error) {
      entry.snapshot.errorText ??=
        `Full-log spill unavailable: ${String(error)}`.slice(0, 4096);
      return undefined;
    }
  }

  async function start(options: StartOptions) {
    // No await until registered: parallel calls cannot overbook or lose a child
    // between spawn and shutdown. An aborted start is checked by the tool edge.
    if (disposed)
      throw new Error("Background terminal manager is shutting down.");
    if (
      [...entries.values()].filter((e) => e.snapshot.status === "running")
        .length >= MAX_RUNNING
    ) {
      throw new Error(
        `Max ${MAX_RUNNING} background terminals can run concurrently. Stop one with bg_kill before starting another.`,
      );
    }
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      windows ? ["/d", "/s", "/c", options.command] : ["-c", options.command],
      {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !windows,
      },
    );
    const s: MutableSnapshot = {
      ...options,
      id: `bt-${++counter}`,
      pid: child.pid,
      status: "running",
      createdAt: Date.now(),
      get stdout() {
        return entry.buffers[0].view();
      },
      get stderr() {
        return entry.buffers[1].view();
      },
    };
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const entry: Entry = {
      snapshot: s,
      child,
      buffers: [],
      spills: [],
      exited: false,
      closed: false,
      processErrored: false,
      killSignaled: false,
      interest: 0,
      settled,
      resolveSettled,
    };
    for (const stream of ["stdout", "stderr"] as const) {
      let write: ((chunk: string) => boolean) | undefined;
      const buf = new OutputBuffer(RETAINED_PER_STREAM, (chunk) =>
        write?.(chunk),
      );
      entry.buffers.push(buf);
      write = spill(entry, buf, stream);
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (chunk: string) => {
        if (entry.finishing) return;
        if (!buf.push(chunk)) child[stream]?.pause();
      });
    }
    child.once("error", (error) => {
      entry.processErrored = entry.exited = true;
      s.errorText = error.message.slice(0, 4096);
      void finish(entry);
    });
    child.once("exit", (code, signal) => {
      entry.exited = true;
      s.exitCode = code ?? undefined;
      s.signal = signal ?? undefined;
      // Also reap descendants with redirected stdio after a natural shell exit.
      entry.exitTimer = setTimeout(() => {
        void stop(entry);
      }, 1000);
    });
    child.once("close", (code, signal) => {
      entry.closed = true;
      if (!groupAlive(entry)) {
        clearTimeout(entry.exitTimer);
        entry.exitTimer = undefined;
        // Remember that this group is gone; never signal a recycled pid when
        // disposing an old settled snapshot much later in the session.
        entry.stopped = true;
      }
      if (!entry.processErrored) {
        s.exitCode ??= code ?? undefined;
        s.signal ??= signal ?? undefined;
      }
      if (!entry.stopping) void finish(entry);
    });
    entries.set(s.id, entry);
    notify();
    prune();
    return s as TerminalSnapshot;
  }

  async function kill(ids: readonly string[], signal?: AbortSignal) {
    const unique = [...new Set(ids)];
    const captured = unique.map((id) => entries.get(id));
    const running = captured.filter(
      (e): e is Entry => !!e && e.snapshot.status === "running",
    );
    for (const entry of running) entry.interest++;
    // Termination owns itself. Cancellation releases only this caller's interest,
    // so its eventual settlement is still delivered automatically.
    const work = Promise.all(running.map(stop));
    try {
      await waitFor(
        work,
        signal,
        "Kill wait aborted; termination continues in the background.",
      );
      return unique.map((id, i): KillResult => {
        const s = captured[i]?.snapshot;
        const old = history.get(id);
        const status = s?.status ?? old?.status ?? "failed";
        const wasRunning = running.includes(captured[i]!);
        return {
          id,
          title: s?.title ?? old?.title ?? "?",
          status,
          wasRunning,
          killed: wasRunning && status === "killed",
          exit: s ? formatExit(s) : (old?.exit ?? "unknown"),
        };
      });
    } finally {
      for (const entry of running) entry.interest--;
      prune();
    }
  }
  const view: TerminalReadModel = {
    list: () => [...entries.values()].map((e) => e.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestKill: (id) => {
      const e = entries.get(id);
      if (e) void stop(e);
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };
  return {
    start,
    kill,
    view,
    async status(id: string) {
      const s = view.get(id);
      if (!s)
        throw new Error(
          `Unknown terminal id "${id}". Known: ${[...entries.keys()].join(", ") || "none"}.`,
        );
      return s;
    },
    dispose() {
      disposed = true;
      return (disposal ??= (async () => {
        await Promise.all([...entries.values()].map(stop));
        entries.clear();
        if (spillDir) fs.rmSync(spillDir, { recursive: true, force: true });
        notify();
        listeners.clear();
        onSettled = undefined;
      })());
    },
  };
}
export type TerminalManagerShape = ReturnType<typeof createTerminalManager>;

/** Abortable observation, not abortable ownership of the underlying operation. */
export async function waitFor<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  message = "Operation was aborted.",
) {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        if (!signal) return;
        abort = () => reject(new Error(message));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
