# Pineapple

Mikkel's Pi extensions, forked from
[Benjamin Davis's my-pi-setup](https://github.com/davis7dotsh/my-pi-setup).
Original attribution, history, and MIT license are preserved.

```sh
pi install git:github.com/mikker/pineapple
```

## Included

| Extension | Interface |
| --- | --- |
| Questions | `ask_user`: native Pi selection/free-form input, cancellation and RPC support. Eligible to run alongside independent tools; it still waits for the answer. |
| Background terminals | `bg_start`, `bg_status`, `bg_list`, `bg_kill`, and `/ps`. Bounded output, full logs, process-tree cleanup. |
| File search | `fd` and `rg` wrappers around installed binaries, with safe arguments and bounded output. No downloads or startup installation. |
| Firecrawl | `search`, `scrape`, `crawl`. SDK loaded only on use; cancelled/failed crawls attempt remote-job cleanup. |
| Subagents | Pi, Claude Code and Codex; spawn/check/wait/cancel/list tools and `/subagents`. No `/btw`. |
| Inline skills | `$name` or `/skill:name` anywhere in a prompt, with completion, deduplication and skill-relative references. |
| Prompt box | Native-editor-based skill highlighting and selected-skill UI. Native Pi shortcuts and completion are retained. |

No custom header/footer, theme override, Git/model telemetry loop, automatic
summaries, workflows, or copy-all command is installed. Those legacy extensions
have been removed rather than merely hidden behind configuration filters.

OpenAI-specific patching and optional priority service live separately in
[Codex Booster](https://github.com/mikker/codex-booster).

See [SETUP.md](./SETUP.md) for prerequisites, [FORK.md](./FORK.md) for maintenance,
and [docs/ask-user.md](./docs/ask-user.md) for the Pi/Codex question API research.

## License

This project is MIT-licensed, including prior commits. See [LICENSE](./LICENSE) and [issue #20](https://github.com/davis7dotsh/my-pi-setup/issues/20).
