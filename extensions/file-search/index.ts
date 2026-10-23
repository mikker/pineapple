/** Installed fd/rg, argv (never a shell), bounded head preview + complete spill. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  buildFdArgs,
  buildRgArgs,
  FD_MAX_DEPTH_LIMIT,
  FD_MAX_LIMIT,
  RG_MAX_CONTEXT,
  RG_MAX_COUNT_LIMIT,
} from "./src/args.ts";
import { resolveBinary } from "./src/binaries.ts";
import { formatCapturedOutput } from "./src/output.ts";
import { discardCapturedOutput, executeSearchProcess } from "./src/process.ts";
import {
  FD_PARAMETER_DESCRIPTIONS as fd,
  RG_PARAMETER_DESCRIPTIONS as rg,
  FD_TOOL_DESCRIPTION,
  FD_PROMPT_SNIPPET,
  FD_PROMPT_GUIDELINES,
  RG_TOOL_DESCRIPTION,
  RG_PROMPT_SNIPPET,
  RG_PROMPT_GUIDELINES,
} from "./src/prompt.ts";

/** Exit 1 means no matches only for rg and only with no output or diagnostic. */
export async function runSearch(
  tool: "fd" | "rg",
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  command = resolveBinary(tool, undefined, cwd),
) {
  const result = await executeSearchProcess({
    command,
    args,
    cwd,
    signal,
    tempPrefix: `pi-${tool}-`,
  });
  const noMatches = result.output.lineCount === 0;
  if (
    result.code !== 0 &&
    !(tool === "rg" && result.code === 1 && noMatches && !result.stderr.trim())
  ) {
    await discardCapturedOutput(result.output);
    throw new Error(
      `${tool} failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
    );
  }
  return { ...formatCapturedOutput(result.output), noMatches };
}

export default function fileSearchTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fd",
    label: "Find Files",
    description: FD_TOOL_DESCRIPTION,
    promptSnippet: FD_PROMPT_SNIPPET,
    promptGuidelines: FD_PROMPT_GUIDELINES,
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: fd.pattern })),
      path: Type.Optional(Type.String({ description: fd.path })),
      type: Type.Optional(
        StringEnum(["file", "directory", "symlink"] as const, {
          description: fd.type,
        }),
      ),
      extension: Type.Optional(Type.String({ description: fd.extension })),
      glob: Type.Optional(Type.Boolean({ description: fd.glob })),
      hidden: Type.Optional(Type.Boolean({ description: fd.hidden })),
      max_depth: Type.Optional(
        Type.Integer({
          description: fd.max_depth,
          minimum: 1,
          maximum: FD_MAX_DEPTH_LIMIT,
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          description: fd.limit,
          minimum: 1,
          maximum: FD_MAX_LIMIT,
        }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const output = await runSearch(
        "fd",
        buildFdArgs(params),
        ctx.cwd,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: output.noMatches ? "No files found" : output.text,
          },
        ],
        details: {
          binarySource: "system",
          matchCount: output.lineCount,
          truncated: output.truncated,
          fullOutputPath: output.fullOutputPath,
        },
      };
    },
  });
  pi.registerTool({
    name: "rg",
    label: "Search Content",
    description: RG_TOOL_DESCRIPTION,
    promptSnippet: RG_PROMPT_SNIPPET,
    promptGuidelines: RG_PROMPT_GUIDELINES,
    parameters: Type.Object({
      pattern: Type.String({ description: rg.pattern }),
      path: Type.Optional(Type.String({ description: rg.path })),
      glob: Type.Optional(Type.String({ description: rg.glob })),
      file_type: Type.Optional(Type.String({ description: rg.file_type })),
      case_sensitive: Type.Optional(
        Type.Boolean({ description: rg.case_sensitive }),
      ),
      fixed_strings: Type.Optional(
        Type.Boolean({ description: rg.fixed_strings }),
      ),
      hidden: Type.Optional(Type.Boolean({ description: rg.hidden })),
      context: Type.Optional(
        Type.Integer({
          description: rg.context,
          minimum: 0,
          maximum: RG_MAX_CONTEXT,
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          description: rg.limit,
          minimum: 1,
          maximum: RG_MAX_COUNT_LIMIT,
        }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const output = await runSearch(
        "rg",
        buildRgArgs(params),
        ctx.cwd,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: output.noMatches ? "No matches found" : output.text,
          },
        ],
        details: {
          binarySource: "system",
          outputLines: output.lineCount,
          truncated: output.truncated,
          fullOutputPath: output.fullOutputPath,
        },
      };
    },
  });
}
