import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

type Commands = ReturnType<ExtensionAPI["getCommands"]>;
export type Skill = {
  name: string;
  description?: string;
  path: string;
  baseDir: string;
};
export const MAX_SKILL_BYTES = 100 * 1024;

// One lexer for complete references and cursor prefixes. Do not partially match
// malformed names, shell variables, paths, escapes, or URLs.
const TOKEN = /(?:\$|\/skill:)[a-zA-Z0-9_.:/\\$-]*/g;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARTIAL_NAME = /^[a-z0-9-]*$/;
const LEFT = /[\s([{"'`*<>=,:;!?]/;
const RIGHT = /[\s)\]}"'`*>,;!?]/;

export function parseReferences(text: string, partial = false) {
  const refs: {
    start: number;
    end: number;
    name: string;
    sigil: "$" | "/skill:";
  }[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    const raw = match[0];
    const sigil = raw.startsWith("$") ? "$" : "/skill:";
    // A trailing sentence period is punctuation, not part of a name.
    const token = raw.endsWith(".") && !partial ? raw.slice(0, -1) : raw;
    const name = token.slice(sigil.length);
    const end = start + token.length;
    if (start > 0 && !LEFT.test(text[start - 1]!)) continue;
    if (!(partial ? PARTIAL_NAME : NAME).test(name)) continue;
    if (
      partial
        ? end !== text.length
        : end < text.length && text[end] !== "." && !RIGHT.test(text[end]!)
    )
      continue;
    refs.push({ start, end, name, sigil });
  }
  return refs;
}

export function getSkills(commands: Commands) {
  const skills = new Map<string, Skill>();
  for (const command of commands) {
    if (command.source !== "skill" || !command.name.startsWith("skill:"))
      continue;
    // The host's first command wins; never shadow an extension/template command.
    if (
      commands.find((candidate) => candidate.name === command.name) !== command
    )
      continue;
    const name = command.name.slice(6);
    if (!NAME.test(name) || skills.has(name)) continue;
    skills.set(name, {
      name,
      description: command.description,
      path: command.sourceInfo.path,
      baseDir: dirname(command.sourceInfo.path),
    });
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function isNativeCommand(text: string) {
  // Bare slash commands are never shorthand for skills. This includes unknown
  // commands, built-ins (not returned by getCommands), and prompt templates.
  const leading = text.match(/^\/([^\s]+)/)?.[1];
  return leading !== undefined && !leading.startsWith("skill:");
}

export function recognizedReferences(text: string, skills: Skill[]) {
  if (isNativeCommand(text)) return [];
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return parseReferences(text).flatMap((ref) => {
    const skill = byName.get(ref.name);
    return skill ? [{ ...ref, skill }] : [];
  });
}

export function selectedSkills(text: string, skills: Skill[]) {
  return [
    ...new Map(
      recognizedReferences(text, skills).map((ref) => [ref.name, ref.skill]),
    ).values(),
  ];
}

const attribute = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export async function expandSkills(
  text: string,
  skills: Skill[],
  load = (path: string) => readFile(path, "utf8"),
) {
  const refs = recognizedReferences(text, skills);
  if (!refs.length) return undefined;
  const blocks: string[] = [];
  let bytes = 0;
  for (const skill of selectedSkills(text, skills)) {
    const content = await load(skill.path);
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SKILL_BYTES)
      throw new Error(`inline skills exceed ${MAX_SKILL_BYTES / 1024}KB`);
    blocks.push(
      `<skill name="${attribute(skill.name)}" location="${attribute(skill.path)}">\nReferences are relative to ${skill.baseDir}.\n\n${stripFrontmatter(content).trim()}\n</skill>`,
    );
  }
  // Replace only recognized spans, not a second pattern with different rules.
  let prompt = text;
  for (const ref of [...refs].reverse())
    prompt = prompt.slice(0, ref.start) + ref.name + prompt.slice(ref.end);
  return `${blocks.join("\n\n")}\n\n${prompt}`;
}

export function createAutocompleteProvider(
  getCurrentSkills: () => Skill[],
  current: AutocompleteProvider,
): AutocompleteProvider {
  function prefixAt(lines: string[], line: number, col: number) {
    if (isNativeCommand(lines.join("\n"))) return undefined;
    const text = (lines[line] ?? "").slice(0, col);
    const ref = parseReferences(text, true).at(-1);
    const suffix = (lines[line] ?? "").slice(col);
    // Do not replace half a name/path when the cursor is in its middle.
    if (suffix && !/^[\s.)\]}"'`*>,;!?]/.test(suffix)) return undefined;
    return ref;
  }
  return {
    triggerCharacters: [
      ...new Set([...(current.triggerCharacters ?? []), "$", "/", ":"]),
    ],
    async getSuggestions(lines, line, col, options) {
      const ref = prefixAt(lines, line, col);
      if (!ref) return current.getSuggestions(lines, line, col, options);
      const items = getCurrentSkills()
        .filter((skill) => skill.name.startsWith(ref.name))
        .map((skill) => ({
          value: `${ref.sigil}${skill.name}`,
          label: `${ref.sigil}${skill.name}`,
          description: skill.description,
        }));
      return items.length ? { items, prefix: `${ref.sigil}${ref.name}` } : null;
    },
    applyCompletion(lines, line, col, item, prefix) {
      const ref = prefixAt(lines, line, col);
      if (
        !ref ||
        prefix !== `${ref.sigil}${ref.name}` ||
        !getCurrentSkills().some(
          (skill) => item.value === `${ref.sigil}${skill.name}`,
        )
      )
        return current.applyCompletion(lines, line, col, item, prefix);
      const before = lines[line]!.slice(0, ref.start);
      const after = lines[line]!.slice(col);
      const suffix = after.length === 0 ? " " : "";
      const result = [...lines];
      result[line] = before + item.value + suffix + after;
      return {
        lines: result,
        cursorLine: line,
        cursorCol: before.length + item.value.length + suffix.length,
      };
    },
    shouldTriggerFileCompletion(lines, line, col) {
      // Native Editor uses this gate for explicit Tab outside a leading slash
      // command too. Allow it; getSuggestions above intercepts skill prefixes
      // before the filesystem provider can run.
      return prefixAt(lines, line, col)
        ? true
        : (current.shouldTriggerFileCompletion?.(lines, line, col) ?? true);
    },
  };
}
