# Drivers

A driver knows how to talk to one coding agent. The session layer above it is
agent-agnostic: it owns the feed, the status, and the pending permissions, and
it never knows whether the thing on the other end is Claude Code, Cursor or
Antigravity.

## The contract

`createDriver(options)` returns an object with:

| Method | Required | Meaning |
| --- | --- | --- |
| `start()` | yes | Launch the agent. Emits events from then on. |
| `send(text, images)` | yes | Send a user turn. `images` is `[{mediaType, data}]` base64. |
| `interrupt()` | no | Stop the current turn. Absent means the UI hides the stop button. |
| `setModel(model)` | no | Switch model mid-session. |
| `setPermissionMode(mode)` | no | Switch permission mode mid-session. |
| `supportedModels()` | no | `[{id, name}]` for the picker. |
| `close()` | yes | Terminate the agent and release resources. |

`options` carries `{ cwd, model, permissionMode, resumeFrom, forkSession, config, emit, requestPermission }`.

- `emit(event)` — push one normalised event upward (see below).
- `requestPermission(toolName, input, meta)` — returns a promise resolving to
  `{ behavior: 'allow' | 'deny', message?, updatedInput? }`. A driver whose agent
  cannot ask for permission simply never calls this.

## Events

Every driver emits the same shapes, so one renderer serves all agents:

```js
{ type: 'init', sessionId, version, model, tools, cwd, permissionMode }
{ type: 'text', text }                 // a complete assistant message
{ type: 'thinking', text }
{ type: 'tool', id, name, input }      // a tool call started
{ type: 'tool_result', id, result, isError }
{ type: 'result', durationMs, costUsd, numTurns, usage }
{ type: 'error', text }
```

Two extra shapes exist for agents that stream at token granularity, and are
passed straight to the feed builder:

```js
{ type: 'raw_stream', event }          // Anthropic streaming event
{ type: 'raw_assistant', message }     // a full SDK assistant message
{ type: 'raw_tool_results', message }
```

A driver that cannot stream token-by-token just emits `text` once per message;
the UI shows the message when it lands instead of as it is typed.

## Capabilities

Each driver module exports a `capabilities` object so the UI can adapt rather
than offer buttons that do nothing:

```js
export const capabilities = {
  streaming: true,      // token-level output
  permissions: true,    // can ask the phone before running a tool
  interrupt: true,
  models: true,         // can list and switch models
  resume: true,         // can continue a previous session
  images: true,
}
```

## Adding one

1. Write `src/agent/drivers/<name>.js` exporting `id`, `label`, `capabilities`,
   `detect()` and `createDriver()`.
2. Register it in `src/agent/drivers/index.js`.
3. Add a fixture under `test/fixtures/` that speaks the real protocol, and a
   test that drives a full turn through it. Every driver here is covered that
   way — no test in this repo requires the real agent to be installed.
