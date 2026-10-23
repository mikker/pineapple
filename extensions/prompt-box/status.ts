import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const exec = promisify(execFile);

export function parseGitStatus(output: string) {
  const [head = "", ...files] = output.trimEnd().split("\n");
  const branch = head
    .replace(/^## (?:No commits yet on |Initial commit on )?/, "")
    .split("...")[0]!;
  const changes = files.filter(Boolean).length;
  return { branch, changes };
}

export async function readGitStatus(cwd: string) {
  try {
    const { stdout } = await exec(
      "git",
      ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
      {
        cwd,
        timeout: 2000,
        maxBuffer: 1024 * 1024,
      },
    );
    return parseGitStatus(stdout);
  } catch {
    return undefined;
  }
}

export function promptStatus(
  cwd: string,
  git: Awaited<ReturnType<typeof readGitStatus>>,
  model: string | undefined,
  thinking: string,
  priority: string | undefined,
  theme: Theme,
) {
  const left = [
    theme.fg("accent", "\uf25b"),
    theme.fg("muted", basename(cwd) || cwd),
  ];
  if (git) {
    left.push(theme.fg("accent", git.branch));
    left.push(
      theme.fg(
        git.changes ? "warning" : "success",
        git.changes ? `${git.changes} changed` : "clean",
      ),
    );
  }
  const right = [model ?? "no model"];
  if (priority)
    right.push(priority === "priority" ? "fast" : "fast unavailable");
  right.push(`◐ ${thinking}`);
  return {
    left: left.join(theme.fg("dim", " · ")),
    right: theme.fg("dim", right.join("  ")),
  };
}

export function statusBorder(
  width: number,
  left: string,
  right: string,
  dim: (text: string) => string,
) {
  const rightLabel = truncateToWidth(right, Math.max(0, width - 2), "…");
  const leftLabel = truncateToWidth(
    left,
    Math.max(0, width - visibleWidth(rightLabel) - 5),
    "…",
  );
  const start = leftLabel ? ` ${leftLabel} ` : "";
  const end = rightLabel ? ` ${rightLabel} ` : "";
  return (
    start +
    dim(
      "─".repeat(Math.max(0, width - visibleWidth(start) - visibleWidth(end))),
    ) +
    end
  );
}
