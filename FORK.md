# Pineapple — Mikkel's Pi extensions

Fork of [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup),
based on upstream `5a0863f` and tested with Pi 1.4.0.

Install from this fork:

```sh
pi install git:github.com/mikker/pineapple
```

Update with `pi update git:github.com/mikker/pineapple`. Upstream changes are
merged deliberately; updating Pi packages follows this fork, not upstream.

## Dependency layout

Extensions are npm workspaces. Install once at the repository root; the root
`package-lock.json` is authoritative. Do not install each extension separately:
separate copies of Effect add seconds to every Pi startup.

The remaining Effect dependency is pinned for the subagent backend lifecycle. Its
old caret range also accepts newer stable releases with incompatible APIs. Questions,
background terminals, search and Firecrawl use native promises/Node APIs instead.
Non-host runtime peers are explicit dependencies because Pi's managed installer
suppresses automatic peer installation. There are no production compiler hooks.

Pi supplies its own `@earendil-works/pi-*` packages and `typebox`. These remain
optional host peers rather than installing a duplicate Pi runtime.

## Development

```sh
npm ci --ignore-scripts --legacy-peer-deps
```

For standalone type-checking and tests, link host peers from your installed Pi's
`node_modules` into this checkout's root `node_modules`. The managed install is
under `~/.pi/agent/install/releases/<version>/node_modules`; update links after
upgrading Pi. Normal extension loading resolves these peers through Pi itself.

Run `npm run check` and `npm run format:check`. The check includes a regression
guard that all workspaces resolve the same pinned Effect runtime.

`npm test` runs the offline regression suite. Live provider tests are separated
behind the explicit `npm run test:live` command; they can make billable requests.
