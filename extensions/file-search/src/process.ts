import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { CapturedOutput } from "./output.ts";

/** Native streaming capture keeps memory bounded even for multi-GB searches.
 * The file stream applies backpressure; close + finish precede publishing a path.
 */
export async function executeSearchProcess(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  tempPrefix: string;
  signal?: AbortSignal;
  timeout?: number;
}) {
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), options.tempPrefix));
  const fullOutputPath = join(directory, "output.txt");
  let retain = false;
  try {
    options.signal?.throwIfAborted();
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const file = createWriteStream(fullOutputPath, {
      flags: "wx",
      mode: 0o600,
    });
    let failure: Error | undefined;
    let preview = "";
    let totalBytes = 0;
    let lineBreaks = 0;
    let trailingLineBreaks = 0;
    let truncated = false;
    let stderr = Buffer.alloc(0);
    const decoder = new TextDecoder();
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.on("error", () => child.kill("SIGKILL"));
        killer.unref();
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
      // Do not wait forever for pipes inherited by a detached descendant.
      child.stdout.destroy();
      child.stderr.destroy();
      file.destroy();
    };
    const fail = (error: Error) => {
      failure ??= error;
      kill();
    };
    const aborted = () => fail(new Error("Search was cancelled."));
    const timer = setTimeout(
      () => fail(new Error("Search timed out.")),
      options.timeout ?? 60000,
    );
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
    const flushed = new Promise<void>((resolve) => {
      file.once("finish", resolve);
      file.once("close", resolve);
      file.once("error", (error) => {
        fail(error);
        resolve();
      });
    });
    file.on("drain", () => child.stdout.resume());
    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      for (const byte of chunk) {
        if (byte === 10) {
          lineBreaks++;
          trailingLineBreaks++;
        } else trailingLineBreaks = 0;
      }
      if (!truncated) {
        preview += decoder.decode(chunk, { stream: true });
        const cut = truncateHead(preview, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        if (cut.truncated) {
          preview = cut.content;
          truncated = true;
        }
      }
      if (!file.destroyed && !file.write(chunk)) child.stdout.pause();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8 * 1024)
        stderr = Buffer.concat([
          stderr,
          chunk.subarray(0, 8 * 1024 - stderr.length),
        ]);
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve) =>
        child.once("close", resolve),
      );
      file.end();
      await flushed;
      if (failure) throw failure;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      if (!file.writableFinished) file.destroy();
    }
    if (!truncated) preview += decoder.decode();
    const bytes = totalBytes - trailingLineBreaks;
    const output: CapturedOutput = {
      preview,
      lineCount: bytes === 0 ? 0 : lineBreaks - trailingLineBreaks + 1,
      totalBytes: bytes,
      truncated,
      fullOutputPath: truncated ? fullOutputPath : undefined,
    };
    retain = truncated;
    return { code, stderr: stderr.toString("utf8"), output };
  } finally {
    if (!retain) await rm(directory, { recursive: true, force: true });
  }
}

export async function discardCapturedOutput(output: CapturedOutput) {
  if (output.fullOutputPath)
    await rm(dirname(output.fullOutputPath), { recursive: true, force: true });
}
