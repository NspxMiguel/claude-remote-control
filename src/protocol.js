/**
 * Turns Claude Code's message stream into a flat, append-only "feed" of items
 * the phone can render and — crucially — re-fetch after a reconnect. Every item
 * carries a monotonic `seq`, so a client that dropped off resumes with
 * `?since=<lastSeq>` instead of reloading the whole conversation.
 */

let counter = 0;
const nextId = () => `i${(++counter).toString(36)}${Date.now().toString(36).slice(-4)}`;

/** Compact one-line labels for tool calls, so a phone screen stays readable. */
export function summarizeTool(name, input = {}) {
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  const base = (p) => (typeof p === 'string' ? p.split('/').slice(-2).join('/') : '');

  switch (name) {
    case 'Bash':
      return { title: 'Terminal', subtitle: str(input.command).split('\n')[0].slice(0, 200) };
    case 'Read':
      return { title: 'Read', subtitle: base(input.file_path) };
    case 'Write':
      return { title: 'Write', subtitle: base(input.file_path) };
    case 'Edit':
      return { title: 'Edit', subtitle: base(input.file_path) };
    case 'NotebookEdit':
      return { title: 'Edit notebook', subtitle: base(input.notebook_path) };
    case 'Glob':
      return { title: 'Find files', subtitle: str(input.pattern) };
    case 'Grep':
      return { title: 'Search', subtitle: str(input.pattern) };
    case 'WebFetch':
      return { title: 'Fetch', subtitle: str(input.url) };
    case 'WebSearch':
      return { title: 'Web search', subtitle: str(input.query) };
    case 'Task':
    case 'Agent':
      return { title: 'Subagent', subtitle: str(input.description) };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { title: 'Tasks', subtitle: str(input.subject || '') };
    default:
      if (name?.startsWith('mcp__')) {
        // mcp__Claude_Browser__navigate → "Claude Browser" / "navigate"
        const parts = name.split('__');
        return {
          title: (parts[1] || 'MCP').replace(/[_-]+/g, ' ').trim(),
          subtitle: parts.slice(2).join('.'),
        };
      }
      return { title: name || 'Tool', subtitle: '' };
  }
}

/**
 * How each tool counts towards a group's summary line. File writes contribute
 * to the +N/-M diffstat; commands and lookups are counted but have no diffstat.
 */
export const TOOL_KIND = {
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  NotebookRead: 'read',
  WebFetch: 'read',
  WebSearch: 'read',
};

export const toolKind = (name) => TOOL_KIND[name] || 'other';

const countLines = (text) => {
  if (typeof text !== 'string' || text === '') return 0;
  return text.replace(/\n$/, '').split('\n').length;
};

/**
 * Lines added and removed by a tool call.
 *
 * Claude Code returns a `structuredPatch` for edits — hunks whose lines are
 * prefixed with '+', '-' or ' ' — which is exact, including deletions when a
 * file is overwritten. Only when that is missing (a brand new file, or a live
 * stream where the result has not arrived) does this fall back to counting the
 * strings in the tool's own input.
 */
export function diffStat(name, input = {}, result) {
  if (toolKind(name) !== 'write') return null;

  const patch = result && typeof result === 'object' ? result.structuredPatch : null;
  if (Array.isArray(patch) && patch.length) {
    let added = 0;
    let removed = 0;
    for (const hunk of patch) {
      for (const line of hunk?.lines || []) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    }
    return { added, removed };
  }

  switch (name) {
    case 'Write':
      // A patch-less Write is a new file: everything in it is an addition.
      return { added: countLines(input.content), removed: 0 };
    case 'Edit':
      return { added: countLines(input.new_string), removed: countLines(input.old_string) };
    case 'MultiEdit': {
      let added = 0;
      let removed = 0;
      for (const edit of input.edits || []) {
        added += countLines(edit?.new_string);
        removed += countLines(edit?.old_string);
      }
      return { added, removed };
    }
    case 'NotebookEdit':
      return { added: countLines(input.new_source), removed: 0 };
    default:
      return { added: 0, removed: 0 };
  }
}

/** Flatten a tool result payload into something displayable without blowing up the DOM. */
export function normalizeToolResult(raw, limit = 20000) {
  let text = '';
  let isError = false;

  const fromBlocks = (blocks) =>
    blocks
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text;
        if (b?.type === 'image') return '[image]';
        return '';
      })
      .join('\n');

  if (raw == null) text = '';
  else if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) text = fromBlocks(raw);
  else if (typeof raw === 'object') {
    if (raw.is_error) isError = true;
    if (typeof raw.content === 'string') text = raw.content;
    else if (Array.isArray(raw.content)) text = fromBlocks(raw.content);
    else if (typeof raw.stdout === 'string' || typeof raw.stderr === 'string') {
      text = [raw.stdout, raw.stderr].filter(Boolean).join('\n');
      if (raw.stderr && !raw.stdout) isError = Boolean(raw.is_error);
    } else text = JSON.stringify(raw, null, 2);
  }

  text = String(text ?? '');
  const truncated = text.length > limit;
  return { text: truncated ? `${text.slice(0, limit)}\n… (truncated)` : text, isError, truncated };
}

export class Feed {
  constructor({ maxItems = 2000, onPatch } = {}) {
    this.items = [];
    /** Bumped on every change; clients resume with `since=<last seq>`. */
    this.seq = 0;
    /** Creation order, never reassigned, so the transcript stays chronological. */
    this.ord = 0;
    this.maxItems = maxItems;
    /**
     * Consecutive tool calls share a group id so the client can collapse them
     * into one summary row. Prose from the assistant (or a new user turn) ends
     * the run; thinking and permission prompts belong to it and do not.
     */
    this.groupCounter = 0;
    this.currentGroup = null;
    this.onPatch = onPatch || (() => {});
    /** `${messageId}:${blockIndex}` -> item, for streaming deltas. */
    this.blockIndex = new Map();
    /** tool_use_id -> item, so results can find their call. */
    this.toolIndex = new Map();
  }

  /** Everything changed since `since`, still in creation order. */
  snapshot(since = 0) {
    return this.items.filter((item) => item.seq > since).sort((a, b) => a.ord - b.ord);
  }

  append(item) {
    // Reasoning arrives in separate blocks that read as one train of thought;
    // stacking a row of identical "Thinking" boxes is just noise.
    if (item.kind === 'thinking' && item.text?.trim()) {
      const previous = this.items.at(-1);
      if (previous?.kind === 'thinking' && !previous.streaming && !item.streaming) {
        return this.update(previous, { text: `${previous.text}\n\n${item.text}` });
      }
    }

    if (item.kind === 'tool') {
      if (!this.currentGroup) this.currentGroup = `g${++this.groupCounter}`;
      item = { ...item, group: this.currentGroup, toolKind: toolKind(item.name) };
    } else if (item.kind !== 'thinking' && item.kind !== 'permission') {
      this.currentGroup = null;
    }

    const full = {
      ...item,
      id: item.id || nextId(),
      seq: ++this.seq,
      ord: ++this.ord,
      at: item.at || Date.now(),
    };
    this.items.push(full);
    if (this.items.length > this.maxItems) {
      const dropped = this.items.splice(0, this.items.length - this.maxItems);
      for (const d of dropped) {
        if (d.toolUseId) this.toolIndex.delete(d.toolUseId);
      }
    }
    this.onPatch({ op: 'append', item: full });
    return full;
  }

  update(item, changes) {
    if (!item) return null;
    Object.assign(item, changes);
    // Only the version moves — the item keeps its place in the transcript.
    item.seq = ++this.seq;
    this.onPatch({ op: 'update', item });
    return item;
  }

  // ---- streaming assistant output -------------------------------------------------

  handleStreamEvent(event) {
    const e = event?.event;
    if (!e) return;

    if (e.type === 'message_start') {
      this.currentMessageId = e.message?.id || `m${Date.now()}`;
      return;
    }
    const msgId = this.currentMessageId || 'msg';

    if (e.type === 'content_block_start') {
      const key = `${msgId}:${e.index}`;
      const block = e.content_block || {};
      if (block.type === 'text') {
        this.blockIndex.set(key, this.append({ kind: 'text', text: '', streaming: true }));
      } else if (block.type === 'thinking') {
        this.blockIndex.set(key, this.append({ kind: 'thinking', text: '', streaming: true }));
      } else if (block.type === 'tool_use') {
        const { title, subtitle } = summarizeTool(block.name, {});
        const item = this.append({
          kind: 'tool',
          name: block.name,
          toolUseId: block.id,
          input: {},
          rawInput: '',
          title,
          subtitle,
          status: 'building',
        });
        if (block.id) this.toolIndex.set(block.id, item);
        this.blockIndex.set(key, item);
      }
      return;
    }

    if (e.type === 'content_block_delta') {
      const item = this.blockIndex.get(`${msgId}:${e.index}`);
      if (!item) return;
      const d = e.delta || {};
      if (d.type === 'text_delta') this.update(item, { text: (item.text || '') + d.text });
      else if (d.type === 'thinking_delta') this.update(item, { text: (item.text || '') + d.thinking });
      else if (d.type === 'input_json_delta') {
        // Tool inputs stream as partial JSON; keep the raw string and parse at stop.
        item.rawInput = (item.rawInput || '') + (d.partial_json || '');
      }
      return;
    }

    if (e.type === 'content_block_stop') {
      const key = `${msgId}:${e.index}`;
      const item = this.blockIndex.get(key);
      if (!item) return;
      if (item.kind === 'tool' && item.rawInput) {
        try {
          const input = JSON.parse(item.rawInput);
          const { title, subtitle } = summarizeTool(item.name, input);
          this.update(item, { input, title, subtitle, status: 'pending', rawInput: undefined });
        } catch {
          this.update(item, { status: 'pending' });
        }
      } else {
        this.update(item, { streaming: false });
      }
      this.blockIndex.delete(key);
    }
  }

  /** Reconcile against the finished assistant message — the authoritative copy. */
  handleAssistant(message) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'text') {
        const existing = this.findTailMatch('text', block.text);
        if (existing) this.update(existing, { text: block.text, streaming: false });
        else if (block.text?.trim()) this.append({ kind: 'text', text: block.text });
      } else if (block.type === 'thinking') {
        const existing = this.findTailMatch('thinking', block.thinking);
        if (existing) this.update(existing, { text: block.thinking, streaming: false });
        else if (block.thinking?.trim()) this.append({ kind: 'thinking', text: block.thinking });
      } else if (block.type === 'tool_use') {
        const existing = this.toolIndex.get(block.id);
        const { title, subtitle } = summarizeTool(block.name, block.input || {});
        if (existing) {
          this.update(existing, {
            input: block.input || {},
            title,
            subtitle,
            status: existing.status === 'building' ? 'pending' : existing.status,
            rawInput: undefined,
            diff: existing.diff ?? diffStat(block.name, block.input || {}),
          });
        } else {
          const item = this.append({
            kind: 'tool',
            name: block.name,
            toolUseId: block.id,
            input: block.input || {},
            title,
            subtitle,
            status: 'pending',
            // Estimated from the input; replaced by the exact patch on result.
            diff: diffStat(block.name, block.input || {}),
          });
          this.toolIndex.set(block.id, item);
        }
      }
    }

    if (message.error) {
      this.append({ kind: 'error', text: `API error: ${message.error}`, code: message.error });
    }
  }

  /** Match a streamed block that ends up being the same block in the final message. */
  findTailMatch(kind, text) {
    for (let i = this.items.length - 1; i >= 0 && i > this.items.length - 12; i--) {
      const item = this.items[i];
      if (item.kind !== kind) continue;
      if (typeof text === 'string' && typeof item.text === 'string') {
        if (text.startsWith(item.text) || item.text.startsWith(text)) return item;
      }
    }
    return null;
  }

  /** Tool results arrive as user-role messages referencing a tool_use_id. */
  handleToolResults(message) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const item = this.toolIndex.get(block.tool_use_id);
      if (!item) continue;
      const payload = message.tool_use_result ?? block.content ?? block;
      const { text, isError, truncated } = normalizeToolResult(payload);
      this.update(item, {
        status: isError || block.is_error ? 'error' : 'done',
        result: text,
        resultTruncated: truncated,
        // The result carries the real patch, so the diffstat is exact now.
        diff: diffStat(item.name, item.input, payload),
      });
    }
  }

  markToolRunning(toolUseId) {
    const item = this.toolIndex.get(toolUseId);
    if (item && item.status !== 'done') this.update(item, { status: 'running' });
  }
}
