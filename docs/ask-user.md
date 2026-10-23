# ask_user: native dialogs and question lifecycle

## Implementation

`extensions/ask-user/index.ts` still registers `ask_user` with the existing
`{ question, options: [{ label, description? }] }` input (2–5 options).
It remains directly callable, including through existing orchestration code;
this change does not restrict it to `model-only` exposure.

`extensions/ask-user/question.ts` uses only native `ctx.ui.select` and
`ctx.ui.input`. Both work in TUI and RPC and accept the tool's `AbortSignal`.
The native components own terminal width, wrapping, focus, theme, keybindings,
dialog disposal, and the TUI dialog stack. There is no custom component,
Effect runtime, abort listener, session state, timer, or background question queue
in the extension.

- Descriptions appear beside numbered labels. Numbers disambiguate duplicate
  labels; answers still contain the original label, not its display decoration.
- The appended “Write my own answer…” action opens Pi's native text input.
  Nonempty answers are trimmed; cancelling or submitting whitespace returns to
  the choices. Cancelling the selector dismisses the question.
- Native input is deliberately used instead of `editor`: Pi 1.4.0's `editor`
  has no signal option. The tradeoff is native single-line editing instead of
  the old custom multiline editor, and native selection keybindings instead of
  the old immediate number-key shortcuts.
- An aborted signal produces `cancelled`, not a dismissal or an answer. Abort
  wins if it arrives with a dialog result. No UI produces the existing plain-text
  fallback message. Unknown RPC selections fail instead of inventing answers.
- Original result details (`question`, `options`, `answer`, `wasCustom`,
  `cancelled`) are retained. An additive `outcome` distinguishes selected,
  custom, dismissed, cancelled, and no-ui. Rendering uses result text so old
  session details and errors require no migration.

## Pi 1.4.0 contracts and limits

Reviewed the installed docs in full:

`/Users/mikker/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/`

- `extensions.md`: tool execution, modes, exposure, result details, lifecycle.
- `tui.md`: prefer native dialogs; custom UI focus/rendering/disposal contracts.
- `rpc-extension-ui.md`: supported select/input dialogs and unsupported custom UI.
- `packages.md`: host-provided imports and dependency declarations.

Also reviewed `examples/extensions/hello.ts` and the relevant installed API/source:

- `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`:
  `ExtensionUIDialogOptions`, `ExtensionUIContext`, `ToolDefinition.executionMode`.
- `@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`:
  `pushExtensionDialog`, `showExtensionSelector`, `showExtensionInput`,
  `showExtensionEditor`. Native dialogs stack rather than orphaning prior ones.
- `@earendil-works/pi-coding-agent/dist/modes/interactive/components/extension-selector.js`:
  native selection, text wrapping via `Text`, and keybindings.
- `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`:
  `createDialogPromise`, `createExtensionUIContext`. Signal abort cleans pending
  requests and resolves with no value. The protocol has no outgoing dialog-close
  notification: RPC clients must handle their own stale visual prompts when a
  turn aborts; the extension cannot add a new protocol message.
- `@earendil-works/pi-agent-core/dist/agent-loop.js`:
  `executeToolCalls`, `executeToolCallsParallel`, `executeToolCallsSequential`.

`executionMode: "parallel"` makes ask_user eligible to share a tool batch with
independent work. **It does not permit the next model turn to run while an answer
is pending.** The parallel executor awaits the entire batch with `Promise.all`.
A global sequential setting **or any sequential sibling tool** makes the whole
batch sequential, even with ask_user's parallel declaration. The prompt says
independent sibling tools *may* run, not that they always will.

No detached tool result, synthetic answer, input interception, or delayed
`sendUserMessage` is used. A genuinely asynchronous question protocol would need
separate request IDs, persistence, late-answer delivery and session/branch
cleanup in addition to UI; that is intentionally outside this lean change.

## Codex reference research

Fetched using the librarian checkout script, not a one-off download:

- Checkout: `~/.cache/checkouts/github.com/openai/codex`
- Revision: `e6ebdfe00b520e21ed50ac0362656f32dd64d2fc`
- Source paths below are relative to that checkout.

### Waiting `request_user_input`

- `codex-rs/core/src/tools/handlers/request_user_input_spec.rs`:
  schema supports 1–3 questions with IDs/headers and option labels/descriptions;
  normalization requires options and sets `is_other = true` so free-form input
  belongs to the UI, not model-generated options.
- `codex-rs/core/src/tools/handlers/request_user_input.rs`:
  rejects non-root agents and unavailable collaboration modes, normalizes input,
  sets `is_blocking` for Plan mode, **awaits** `session.request_user_input`, then
  returns serialized answers. Cancellation is an error, not a guessed answer.
- `codex-rs/protocol/src/request_user_input.rs`:
  request/event fields include call/turn identity, questions, `isBlocking`;
  response maps question IDs to answer arrays. `autoResolutionMs` is deprecated.
- `codex-rs/core/src/session/mod.rs`:
  `request_user_input` registers an elicitation and oneshot response sender in
  active turn state, emits the event, and awaits its receiver.
  `notify_user_input_response` removes the sender, reserves acceptance order,
  and completes the response once.
- `codex-rs/core/src/session/handlers.rs`:
  `request_user_input_response` forwards the client response to that session.
- `codex-rs/core/src/state/turn.rs`:
  pending input senders are held in turn state and cleared with that state.
- `codex-rs/tui/src/bottom_pane/request_user_input/mod.rs`:
  owns question navigation, notes/free-form drafts, submission and queued
  requests. A nonblocking request can auto-resolve with empty answers after
  a 60-second hidden grace plus 60-second visible countdown; interaction can
  snooze that policy. `isBlocking: false` is **not** evidence that this waiting
  tool returns before the response.

### Separate asynchronous question tool

- `codex-rs/core/src/tools/handlers/request_user_input_async.rs`:
  `request_user_input_async` emits an async `AgentMessage` item containing
  questions, then immediately returns `{"accepted":true}` rather than answers.
- `codex-rs/tui/src/chatwidget/questions.rs`:
  retains unanswered questions and delivers submitted answers through ordinary
  user input (or its queue) with `UserMessageSource::QuestionAnswer`. Only accepted
  sends/queues consume the answer.

This is a different lifecycle and contract, not a flag to copy onto Pi's
answer-returning tool. We borrow native ownership of selection/free-form input,
not Codex's broader retained-question infrastructure or timeout policy.

## Dependencies and validation

Removed ask-user's `effect` dependency, `@effect/tsgo` dev dependency,
`patch-types` script, and Effect language-service configuration. No root manifest
or lockfile was edited. A maintainer should refresh the root workspace lockfile
after integration to reflect these workspace removals. Do not remove root Effect
dependencies merely for ask-user; other workspaces still use them.

Offline tests cover native select/input interaction, free-form back/cancel,
whitespace, duplicate labels, no UI, pre-abort, in-flight abort, resolution races,
invalid RPC selections, failures, option counts, and current tool registration
metadata. These are stubbed-dialog tests plus an installed-Pi import smoke test,
not a live terminal or RPC client end-to-end test.

Validation commands:

- `npm --prefix extensions/ask-user run format`
- `npm --prefix extensions/ask-user run check`
- `npm --prefix extensions/ask-user test`
- `npm --prefix extensions/ask-user run format:check`
- `npm run check` (attempted; fails outside ask-user in concurrent
  background-terminals tests and inline-skills' `toReversed` target requirement).

There is no separate lint command; local type/format checks pass. If the project
wants linting beyond those checks, add a dedicated lint script in a separate
repository-wide change.
