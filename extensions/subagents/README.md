# Background subagents

Five tools run up to four background tasks across Pi, Claude Code, and Codex:
`subagent_spawn`, `subagent_check`, `subagent_wait`, `subagent_cancel`, and
`subagent_list`. Uncollected results become parent-session follow-ups at
`agent_settled`. Cancelling a wait leaves children running. Session shutdown
disposes children without delivering results into the closing parent.

`/subagents` uses Pi's built-in selection and editor dialogs to inspect a
snapshot of output and its transcript path. Edits in the inspection dialog are
discarded. Reopen an item to refresh it. There is no separate terminal/editor
lifecycle, takeover, or side-question command.

## Implementation

Pi children use the current SDK's `ModelRuntime` and `createAgentSession`,
trust-gated resources for their working directory, persistent session files,
headless extension binding, and a child-tool denylist. Acquisition registers
cleanup atomically so cancellation cannot leak a late-created session.
`AgentSession.abort()` waits for idle; cleanup emits child `session_shutdown`
before disposal.

Claude uses `@anthropic-ai/claude-agent-sdk`; Codex uses a Node child process
speaking app-server JSON-RPC. Codex teardown signals the process group and
escalates to SIGKILL. Transport events are folded into bounded snapshots by the
manager. The manager and transports still use Effect scopes/streams; this is
not an Effect-free implementation. Replacing that lifecycle is remaining work,
not a reason to add a second runtime adapter now.

The only shared source dependency is
`extensions/shared/tool-call-timeout.ts` (`createToolCallTimeoutGuard`), used by
Pi children. Its timeout/abort tests should remain in the root offline suite.
The extension directly needs only `effect`, `@anthropic-ai/claude-agent-sdk`,
and the host Pi/typebox packages. Claude's SDK owns its transitive Anthropic,
MCP, and Zod dependencies; none is directly imported here.

## Verification

- `npm --prefix extensions/subagents run check`
- `npm --prefix extensions/subagents test` — offline only, including a fake
  Codex executable that tests protocol output, cancellation, and process reaping
- `npm --prefix extensions/subagents run test:live` — explicitly opt-in;
  launches the real Claude/Codex backends and may incur provider costs

The root test command must exclude `claude.test.ts` and `codex.test.ts`, or
delegate to this package's `test` script, rather than globbing all test files.
