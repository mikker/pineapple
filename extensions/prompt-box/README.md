# Prompt box

A compact rounded frame around native `CustomEditor`, with theme-accented
recognized skill references and a deduplicated `first · second` selection label
in the lower rule. No custom colors, keyboard handlers, input state, or paste
implementation. Unknown references and native command arguments are not marked
as selected skills. Below eight columns the editor renders exactly as native
`CustomEditor`. Host-installed padding settings remain respected.

## Native API decisions

- `renderTopBorder` / `renderBottomBorder` delimit native content. A hook-owned
  bottom sentinel is replaced before returning output, so user-entered rule
  characters can never be mistaken for UI borders. No render-output rule regex.
- Native Editor owns wrapping, scrolling, focus, IME and fake cursor markers,
  menus, history, paste, keyboard shortcuts and all completion interactions.
  The frame adds one column per side and translates mouse coordinates back.
  Menus remain outside the box at their native row positions.
- Pi 1.4 has **no text-decoration hook**. Highlighting is a foreground-only
  annotation pass on content rows bounded by the border hooks. It projects the
  shared parser's source spans through a small vendored `wordWrapLine`, then
  verifies the projection against native output before decorating it. A local
  `extractAnsiCode` preserves CSI, OSC, APC, fake cursor and IME sequences
  in their original order. Neither text nor cursor positions are reconstructed.
  These annotation-only helpers are derived from Pi 1.4 (Mario Zechner, MIT;
  see `../../THIRD_PARTY_NOTICES.md`). Public `wrapTextWithAnsi` has different
  whitespace/wrap semantics and no source offsets. Managed installs supply only
  root host aliases, so runtime code uses no deep imports, physical host peers,
  or host path probing. This is a **Pi 1.4 compatibility boundary**; renderer
  tests guard it and mismatched rows skip decoration. A future native
  source-range styling hook should replace this small annotation layer.
- Collapsed paste markers keep their native atomic geometry. They are not
  decorated; their expanded content still contributes to the selection label.
- The label uses the live `ctx.ui.theme` on every render, and disappears when
  the native bottom scroll indicator needs the rule. It never hides that count.
- An existing editor factory is respected, and non-TUI sessions install nothing.
- Known upstream limit: Pi 1.4's native wrapping recurses when a two-column
  grapheme must fit a one-column viewport. The plain fallback deliberately does
  not patch the host's editor or alter its text to hide this limitation.

Load alongside inline-skills as described in
[`../inline-skills/README.md`](../inline-skills/README.md). The inline-skills
extension alone installs the completion provider, so loading both does not
double-wrap it. Loading prompt-box alone still shows references, but does not
expand them or install skill completion.

Offline verification:

```sh
npm --prefix extensions/prompt-box run check
npm --prefix extensions/prompt-box test
npm --prefix extensions/prompt-box run format:check
```

Tests instantiate the real host editor without a terminal process or network.
They cover ANSI/IME boundaries, wrapped source spans, both completion sigils,
native menus and app shortcuts, scrolling, narrow widths, Unicode, theme
invalidation, bracketed and collapsed paste, submission, and mouse geometry.
Physical IME placement and actual terminal appearance still merit an interactive
smoke test by the integrating owner.
