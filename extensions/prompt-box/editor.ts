import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { extractAnsiCode, wordWrapLine } from "./annotation.ts";
import {
  recognizedReferences,
  selectedSkills,
  type Skill,
} from "../inline-skills/skills.ts";

const BOTTOM_BOUNDARY = "\x1b]777;pineapple-prompt-box-bottom\x07";
const MIN_BOX_WIDTH = 8;

/** Apply foreground only; preserve all native control sequences (including IME
 * and reverse-video cursor markers) byte for byte, in their original order. */
export function decorateLine(
  line: string,
  ranges: { start: number; end: number }[],
  accent: (text: string) => string,
) {
  let result = "";
  let plainOffset = 0;
  for (let index = 0; index < line.length;) {
    const ansi = extractAnsiCode(line, index);
    if (ansi) {
      result += ansi.code;
      index += ansi.length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index)!);
    result += ranges.some(
      (range) => plainOffset >= range.start && plainOffset < range.end,
    )
      ? accent(char)
      : char;
    plainOffset += char.length;
    index += char.length;
  }
  return result;
}

/** Annotation projection only. Native Editor still owns layout, scrolling,
 * paste segmentation and cursor positioning. Reject a projection if its text
 * doesn't agree with native output; never "repair" native rendered content. */
export function projectReferences(
  text: string,
  skills: Skill[],
  contentWidth: number,
) {
  const refs = recognizedReferences(text, skills);
  let offset = 0;
  return text.split("\n").flatMap((line) => {
    const chunks =
      visibleWidth(line) <= contentWidth
        ? [{ text: line, startIndex: 0, endIndex: line.length }]
        : wordWrapLine(line, contentWidth);
    const projected = chunks.map((chunk) => ({
      text: chunk.text,
      ranges: refs
        .filter(
          (ref) =>
            ref.start < offset + chunk.endIndex &&
            ref.end > offset + chunk.startIndex,
        )
        .map((ref) => ({
          start: Math.max(0, ref.start - offset - chunk.startIndex),
          end: Math.min(chunk.text.length, ref.end - offset - chunk.startIndex),
        })),
    }));
    offset += line.length + 1;
    return projected;
  });
}

export class PromptBoxEditor extends CustomEditor {
  private boxed = false;
  private hiddenAbove = 0;
  private bottomRule = "";
  private bottomHidden = 0;
  private currentWidth = 0;
  private getSkills: () => Skill[];
  private accent: (text: string) => string;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    getSkills: () => Skill[],
    accent: (text: string) => string,
    autocompleteMaxVisible = 5,
  ) {
    super(tui, theme, keybindings, { paddingX: 1, autocompleteMaxVisible });
    this.getSkills = getSkills;
    this.accent = accent;
  }

  protected override renderTopBorder(width: number, hidden: number) {
    this.hiddenAbove = hidden;
    return super.renderTopBorder(width, hidden);
  }

  protected override renderBottomBorder(width: number, hidden: number) {
    const native = super.renderBottomBorder(width, hidden);
    if (!this.boxed) return native;
    this.bottomRule = native;
    this.bottomHidden = hidden;
    // A hook-owned sentinel identifies the boundary unambiguously, even if
    // user text is a row of rules. It never reaches the terminal.
    return BOTTOM_BOUNDARY;
  }

  override render(width: number) {
    this.currentWidth = width;
    this.boxed = width >= MIN_BOX_WIDTH;
    if (!this.boxed) return super.render(width);
    const innerWidth = width - 2;
    const native = super.render(innerWidth);
    const bottom = native.indexOf(BOTTOM_BOUNDARY);
    if (bottom < 2) {
      this.boxed = false;
      return super.render(width);
    }
    const skills = this.getSkills();
    const text = this.getText();
    // InteractiveMode copies the user's padding setting onto custom editors
    // after construction. Mirror native geometry for annotation only, rather
    // than assuming the constructor's default survived that installation.
    const padding = Math.min(
      this.getPaddingX(),
      Math.max(0, Math.floor((innerWidth - 1) / 2)),
    );
    const contentWidth = Math.max(1, innerWidth - padding * 2);
    const layoutWidth = Math.max(1, contentWidth - (padding ? 0 : 1));
    // Collapsed paste markers have native atomic wrapping. Do not expand them
    // visually or guess their geometry. The selection label uses expanded text.
    const projection =
      text === this.getExpandedText()
        ? projectReferences(text, skills, layoutWidth)
        : [];
    const border = (value: string) => this.borderColor(value);
    const result = [border("╭") + native[0]! + border("╮")];
    for (let index = 1; index < bottom; index++) {
      let line = native[index]!;
      const chunk = projection[this.hiddenAbove + index - 1];
      if (
        chunk &&
        stripTerminalSequences(line).slice(
          padding,
          padding + chunk.text.length,
        ) === chunk.text
      ) {
        line = decorateLine(
          line,
          chunk.ranges.map((range) => ({
            start: range.start + padding,
            end: range.end + padding,
          })),
          this.accent,
        );
      }
      result.push(border("│") + line + border("│"));
    }
    const selected = selectedSkills(this.getExpandedText(), skills);
    // Leave room for the native scroll count. No cached theme-colored strings.
    const available = this.bottomHidden ? 0 : innerWidth - 2;
    const label = selected.length
      ? truncateToWidth(
          ` ${selected.map((skill) => skill.name).join(" · ")} `,
          available,
          "…",
        )
      : "";
    result.push(
      border("╰") +
        truncateToWidth(this.bottomRule, innerWidth - visibleWidth(label), "") +
        this.accent(label) +
        border("╯"),
    );
    // Autocomplete belongs to native Editor and remains outside the box. The
    // row count is unchanged, so its mouse and keyboard hit-testing still fits.
    result.push(...native.slice(bottom + 1).map((line) => ` ${line} `));
    return result;
  }

  override handleMouse(event: TuiMouseEvent) {
    if (!this.boxed) return super.handleMouse(event);
    if (event.x === 0 || event.x >= this.currentWidth - 1) return undefined;
    return super.handleMouse({
      ...event,
      x: event.x - 1,
      width: Math.max(1, event.width - 2),
    });
  }
}
