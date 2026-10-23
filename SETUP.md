# Setup

Install as a Pi package, not by copying over your agent directory:

```sh
pi install git:github.com/mikker/pineapple
```

Reload or restart Pi after updating.

## Prerequisites

- Install `fd` (`fdfind` on Debian/Ubuntu) and `rg` through your package manager.
  File search reports missing tools when called; it does not download binaries.
- Firecrawl needs `FIRECRAWL_API_KEY` in the environment or `~/.pi/agent/.env`.
  There is no API call or SDK initialization until a web tool is used.
- Claude Code and Codex subagents need their respective authentication/configuration.
  Pi children inherit the parent's model registry and explicit trust configuration.

## Skills and editor

Use `$name` or `/skill:name` in a prompt. Both syntaxes expand the same discovered
skills and support completion. Unknown names are left untouched. Referenced skill
files are loaded before submission; load failures stop the request.

The prompt box highlights recognized references. Pineapple leaves Pi's header,
footer, and theme alone. To use the native editor, exclude
`extensions/prompt-box/index.ts` from this package's extension filter.

## Questions

`ask_user` uses Pi's native selection and free-form input dialogs in TUI or RPC.
Independent tools can share its batch when Pi's execution mode permits it, but the
next model turn waits until the batch finishes. It does not create detached
questions or silently invent answers. See `docs/ask-user.md`.

## Maintenance

```sh
pi update git:github.com/mikker/pineapple
```

Keep OpenAI priority/patching separately with
`pi install git:github.com/mikker/codex-booster`.
