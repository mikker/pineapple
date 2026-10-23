/**
 * Shared output shaping for the fd and rg tools: standard pi truncation
 * (2000 lines / 50KB) with the full output persisted to a temp file when
 * anything is cut off.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export interface FormattedOutput {
  readonly text: string;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface CapturedOutput {
  readonly preview: string;
  readonly lineCount: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

function truncationNotice(options: {
  content: string;
  outputLines: number;
  totalLines: number;
  outputBytes: number;
  totalBytes: number;
  fullOutputPath: string;
}) {
  return (
    `${options.content}\n\n[Output truncated: ${options.outputLines} of ${options.totalLines} lines ` +
    `(${formatSize(options.outputBytes)} of ${formatSize(options.totalBytes)}). ` +
    `Full output saved to: ${options.fullOutputPath}]`
  );
}

/** Format output already captured by a bounded-memory streaming process. */
export function formatCapturedOutput(captured: CapturedOutput) {
  const trimmed = captured.preview.replace(/\n+$/, "");
  if (!captured.truncated || !captured.fullOutputPath) {
    return {
      text: trimmed,
      lineCount: captured.lineCount,
      truncated: false,
    } satisfies FormattedOutput;
  }

  const truncation = truncateHead(trimmed, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const content = truncation.content;
  const outputLines = content === "" ? 0 : content.split("\n").length;
  const outputBytes = Buffer.byteLength(content);
  return {
    text: truncationNotice({
      content,
      outputLines,
      totalLines: captured.lineCount,
      outputBytes,
      totalBytes: captured.totalBytes,
      fullOutputPath: captured.fullOutputPath,
    }),
    lineCount: captured.lineCount,
    truncated: true,
    fullOutputPath: captured.fullOutputPath,
  } satisfies FormattedOutput;
}
