/** Annotation-only helpers adapted from Pi (@earendil-works/pi-tui) 1.4.0:
 * dist/components/editor.js (wordWrapLine) and dist/utils.js (ANSI tokenizer,
 * CJK/whitespace boundaries). Copyright (c) 2025 Mario Zechner, MIT.
 * See ../../THIRD_PARTY_NOTICES.md for the license.
 *
 * Native Editor owns layout. These helpers only project source annotations;
 * editor.ts verifies projected text against native rows before decorating.
 * No paste-marker segmentation: collapsed pastes bypass annotation entirely.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter();
const cjkBreakRegex =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

export function wordWrapLine(line: string, maxWidth: number) {
  if (!line || maxWidth <= 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
  if (visibleWidth(line) <= maxWidth)
    return [{ text: line, startIndex: 0, endIndex: line.length }];

  const chunks: { text: string; startIndex: number; endIndex: number }[] = [];
  const segments = [...graphemes.segment(line)];
  let currentWidth = 0;
  let chunkStart = 0;
  let wrapOppIndex = -1;
  let wrapOppWidth = 0;
  for (let i = 0; i < segments.length; i++) {
    const { segment, index } = segments[i]!;
    const width = visibleWidth(segment);
    const isWs = /\s/.test(segment);
    // No valid annotation projection when even one grapheme cannot fit.
    // Unlike native 1.4's atomic-marker recursion, never recurse on it.
    if (width > maxWidth) return [];
    if (currentWidth + width > maxWidth) {
      if (
        wrapOppIndex >= 0 &&
        currentWidth - wrapOppWidth + width <= maxWidth
      ) {
        chunks.push({
          text: line.slice(chunkStart, wrapOppIndex),
          startIndex: chunkStart,
          endIndex: wrapOppIndex,
        });
        chunkStart = wrapOppIndex;
        currentWidth -= wrapOppWidth;
      } else if (chunkStart < index) {
        chunks.push({
          text: line.slice(chunkStart, index),
          startIndex: chunkStart,
          endIndex: index,
        });
        chunkStart = index;
        currentWidth = 0;
      }
      wrapOppIndex = -1;
    }
    currentWidth += width;
    const next = segments[i + 1];
    if (
      next &&
      !/\s/.test(next.segment) &&
      (isWs || cjkBreakRegex.test(segment) || cjkBreakRegex.test(next.segment))
    ) {
      wrapOppIndex = next.index;
      wrapOppWidth = currentWidth;
    }
  }
  chunks.push({
    text: line.slice(chunkStart),
    startIndex: chunkStart,
    endIndex: line.length,
  });
  return chunks;
}

export function extractAnsiCode(str: string, pos: number) {
  const length = ansiCodeLength(str, pos);
  return length > 0 ? { code: str.substring(pos, pos + length), length } : null;
}

function ansiCodeLength(str: string, pos: number) {
  if (pos >= str.length || str.charCodeAt(pos) !== 0x1b) return 0;
  const next = str[pos + 1];
  if (next === "[") {
    for (let j = pos + 2; j < str.length; j++) {
      const c = str.charCodeAt(j);
      // Native SGR and cursor/erase CSI terminators.
      if (c === 0x6d || c === 0x47 || c === 0x4b || c === 0x48 || c === 0x4a)
        return j + 1 - pos;
    }
    return 0;
  }
  // OSC hyperlinks and APC cursor/IME markers, terminated by BEL or ST.
  if (next === "]" || next === "_") {
    for (let j = pos + 2; j < str.length; j++) {
      const c = str.charCodeAt(j);
      if (c === 0x07) return j + 1 - pos;
      if (c === 0x1b && str[j + 1] === "\\") return j + 2 - pos;
    }
  }
  return 0;
}
