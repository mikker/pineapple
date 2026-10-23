import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const imageExtension = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|heic)$/i;
// Shell word separators are ASCII whitespace, not the narrow nonbreaking space
// used inside macOS screenshot filenames.
const pathTokens =
  /(?<![^ \t\r\n])(?:"(?:\\.|[^"\\])*"|'[^']*'|(?:\\.|[^ \t\r\n"'\\])+)(?![^ \t\r\n])/g;

function isCommand(text: string) {
  // A leading slash followed by a command name is not an absolute file path.
  return /^(?:!|\/[\w:-]+(?:\s|$))/.test(text.trimStart());
}

function unquote(text: string) {
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return text.replace(/\\(.)/g, "$1");
}

/**
 * Keep one instance for the session (including editor history). Paths are keyed
 * by their resolved absolute spelling, not by file contents. Expansion restores
 * the first spelling seen, including quotes/escapes, so it remains valid input
 * for the host. Neither method reads image contents or executes shell syntax.
 */
export class ImagePathLabels {
  private readonly cwd: string;
  private readonly home: string;
  private readonly labels = new Map<string, string>();
  private readonly originals = new Map<string, string>();

  constructor(options: { cwd?: string; home?: string } = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.home = options.home ?? homedir();
  }

  collapse(text: string) {
    if (isCommand(text)) return text;
    return text
      .split(/(\r?\n)/)
      .map((line) => {
        if (isCommand(line)) return line;
        // Try a whole line first: unquoted paths dragged from some apps contain
        // literal spaces. Keep indentation and trailing whitespace untouched.
        const trimmed = line.trim();
        const label = this.labelFor(trimmed);
        if (label) return line.replace(trimmed, () => label);
        return line.replace(
          pathTokens,
          (token) => this.labelFor(token) ?? token,
        );
      })
      .join("");
  }

  expand(text: string) {
    if (isCommand(text)) return text;
    return text
      .split(/(\r?\n)/)
      .map((line) =>
        isCommand(line)
          ? line
          : line.replace(
              /\[Image #\d+\]/g,
              (label) => this.originals.get(label) ?? label,
            ),
      )
      .join("");
  }

  private labelFor(original: string) {
    const path = unquote(original);
    if (!imageExtension.test(path) || /[\r\n\0]/.test(path)) return;
    // Only ~/ is expanded; ~other-user, URLs, and environment variables are
    // deliberately not interpreted as local paths.
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return;
    if (path.startsWith("~") && !path.startsWith("~/")) return;
    const absolute = path.startsWith("~/")
      ? resolve(this.home, path.slice(2))
      : isAbsolute(path)
        ? resolve(path)
        : resolve(this.cwd, path);

    try {
      if (!statSync(absolute).isFile()) return;
    } catch {
      return;
    }
    const known = this.labels.get(absolute);
    if (known) return known;
    const label = `[Image #${this.labels.size + 1}]`;
    this.labels.set(absolute, label);
    this.originals.set(label, original);
    return label;
  }
}
