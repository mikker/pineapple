# Inline skills

Use `$name` or `/skill:name` in plain prompts, at the beginning, middle, or on
later lines. Only discovered skill commands are recognized; ordinary `/name`
commands are not aliases. Unknown or malformed references stay untouched.
References have token boundaries, so shell variables, escaped sigils, URLs,
and path fragments do not accidentally invoke skills. Quoted, parenthesized,
and backticked references work.

The shared lexer in `skills.ts` drives expansion, completion and prompt-box
highlighting. Each selected skill is loaded once in first-use order, stripped
of frontmatter, and enclosed in its own native-style `<skill>` block with its
file location and actual skill directory. The original request follows, with
recognized references replaced by their names. Unknown references and the rest
of the request are preserved. All skill files must load successfully and fit
within a combined 100 KiB UTF-8 budget, or the input is consumed with an error
notification; no partial request is sent. A single leading invocation uses the
same loader, rather than delegating to native skill expansion (which fails open
on unreadable files in Pi 1.4).

## Commands and completion

- Leading non-skill slash commands are left entirely to Pi, including built-ins,
  extension commands, unknown commands and prompt templates. Their arguments
  are not reinterpreted as inline skills. Put skill references in a plain prompt
  instead. A bare `/name` is never stolen from another command.
- The first command with an exact `skill:name` name wins. A colliding extension
  or prompt command is never replaced by a skill alias.
- Programmatically generated `source: "extension"` input is not expanded again.
- Both sigils complete with **Tab**, using the native editor's menu and keys.
  `$` also auto-opens while typing at native token boundaries; leading slash
  commands use Pi's normal auto-opening behavior. Inline `/skill:` needs Tab:
  Pi 1.4 deliberately filters `/` out of provider trigger characters.
- Native Enter behavior is preserved: selecting a slash-prefixed completion
  with Enter also submits the prompt. Tab completes without submitting.
- Unrelated completion and file search delegate to the previous provider.

The registry is read from `pi.getCommands()` on demand. Keep skill commands
enabled (`enableSkillCommands`) so the host exposes them. No separate skill
scan, cache, or duplicated discovery policy is introduced.

## Integration

Load `extensions/inline-skills/index.ts` once and
`extensions/prompt-box/index.ts` once through root Pi resource configuration or
explicit `-e` options. Disable the old `.dotfiles` single-file extensions first.
Keep these sibling directories together: prompt-box imports this module by
relative path. No root manifest/configuration is changed by this migration.
Normal workspace discovery includes both packages after the root lockfile is
reconciled by the integrating owner. Host packages are peers, never bundled.

Offline verification (with host peer links available):

```sh
npm --prefix extensions/inline-skills run check
npm --prefix extensions/inline-skills test
npm --prefix extensions/inline-skills run format:check
```

There is no separate lint tool configured; `check` provides strict TypeScript
validation and `format:check` checks formatting. Add a dedicated lint script if
the project adopts a linter.
