import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

/** Installed commands only. No network, release metadata, or session initialization. */
export function resolveBinary(
  tool: "fd" | "rg",
  searchPath = process.env.PATH ?? "",
  cwd = process.cwd(),
) {
  const names = tool === "fd" ? ["fd", "fdfind"] : ["rg"];
  const suffixes = process.platform === "win32" ? [".exe"] : [""];
  for (const name of names) {
    for (const directory of searchPath.split(delimiter)) {
      for (const suffix of suffixes) {
        const command = resolve(cwd, directory, name + suffix);
        try {
          accessSync(command, constants.X_OK);
          if (statSync(command).isFile()) return command;
        } catch {
          /* Try next PATH entry. */
        }
      }
    }
  }
  throw new Error(
    `${tool} is not installed or not executable on PATH. Install ${tool === "fd" ? "fd (or fdfind)" : "ripgrep (rg)"} and retry. file-search never downloads binaries.`,
  );
}
