import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { diffStat, Feed, normalizeToolResult, summarizeTool, toolKind } from '../src/protocol.js';

const streamText = (feed, text, { index = 0, messageId = 'm1' } = {}) => {
  feed.handleStreamEvent({ event: { type: 'message_start', message: { id: messageId } } });
  feed.handleStreamEvent({ event: { type: 'content_block_start', index, content_block: { type: 'text' } } });
  for (const chunk of text) {
    feed.handleStreamEvent({
      event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } },
    });
  }
  feed.handleStreamEvent({ event: { type: 'content_block_stop', index } });
};

describe('Feed streaming', () => {
  test('assembles text from deltas into one item', () => {
    const feed = new Feed();
    streamText(feed, ['Hel', 'lo ', 'world']);
    const texts = feed.items.filter((i) => i.kind === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].text, 'Hello world');
    assert.equal(texts[0].streaming, false);
  });

  test('parses a tool_use whose input arrives as partial JSON', () => {
    const feed = new Feed();
    feed.handleStreamEvent({ event: { type: 'message_start', message: { id: 'm1' } } });
    feed.handleStreamEvent({
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } },
    });
    for (const part of ['{"comm', 'and":"ls ', '-la"}']) {
      feed.handleStreamEvent({
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: part } },
      });
    }
    feed.handleStreamEvent({ event: { type: 'content_block_stop', index: 0 } });

    const tool = feed.items.find((i) => i.kind === 'tool');
    assert.deepEqual(tool.input, { command: 'ls -la' });
    assert.equal(tool.title, 'Terminal');
    assert.equal(tool.subtitle, 'ls -la');
    assert.equal(tool.status, 'pending');
  });

  test('survives malformed partial JSON without throwing', () => {
    const feed = new Feed();
    feed.handleStreamEvent({ event: { type: 'message_start', message: { id: 'm1' } } });
    feed.handleStreamEvent({
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } },
    });
    feed.handleStreamEvent({
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"broken' } },
    });
    feed.handleStreamEvent({ event: { type: 'content_block_stop', index: 0 } });
    assert.equal(feed.items.find((i) => i.kind === 'tool').status, 'pending');
  });

  test('ignores deltas for blocks it never saw start', () => {
    const feed = new Feed();
    feed.handleStreamEvent({
      event: { type: 'content_block_delta', index: 7, delta: { type: 'text_delta', text: 'orphan' } },
    });
    assert.equal(feed.items.length, 0);
  });
});

describe('Feed reconciliation', () => {
  test('final assistant message replaces the streamed draft rather than duplicating it', () => {
    const feed = new Feed();
    streamText(feed, ['par', 'tial']);
    feed.handleAssistant({ message: { content: [{ type: 'text', text: 'partial and final' }] } });

    const texts = feed.items.filter((i) => i.kind === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].text, 'partial and final');
  });

  test('adds text that was never streamed', () => {
    const feed = new Feed();
    feed.handleAssistant({ message: { content: [{ type: 'text', text: 'only final' }] } });
    assert.equal(feed.items.filter((i) => i.kind === 'text').length, 1);
  });

  test('attaches a tool result to its call', () => {
    const feed = new Feed();
    feed.handleAssistant({
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a/b.txt' } }] },
    });
    feed.handleToolResults({
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' }] },
    });

    const tool = feed.items.find((i) => i.kind === 'tool');
    assert.equal(tool.status, 'done');
    assert.equal(tool.result, 'file contents');
  });

  test('marks a failed tool result as an error', () => {
    const feed = new Feed();
    feed.handleAssistant({ message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } });
    feed.handleToolResults({
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'boom' }] },
    });
    assert.equal(feed.items.find((i) => i.kind === 'tool').status, 'error');
  });

  test('a result for an unknown tool id is ignored', () => {
    const feed = new Feed();
    feed.handleToolResults({ message: { content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] } });
    assert.equal(feed.items.length, 0);
  });
});

describe('Feed ordering and replay', () => {
  test('updates bump seq but never reorder the transcript', () => {
    const feed = new Feed();
    const tool = feed.append({ kind: 'tool', name: 'Bash', status: 'pending' });
    feed.append({ kind: 'text', text: 'after the tool' });
    feed.update(tool, { status: 'done' });

    assert.deepEqual(
      feed.items.map((i) => i.kind),
      ['tool', 'text'],
    );
    assert.ok(feed.items[0].seq > feed.items[1].seq, 'updated item has the newer seq');
    assert.ok(feed.items[0].ord < feed.items[1].ord, 'creation order is preserved');
  });

  test('snapshot(since) returns only changes, still in creation order', () => {
    const feed = new Feed();
    const first = feed.append({ kind: 'text', text: 'one' });
    feed.append({ kind: 'text', text: 'two' });
    const mark = feed.seq;
    feed.append({ kind: 'text', text: 'three' });
    feed.update(first, { text: 'one (edited)' });

    const delta = feed.snapshot(mark);
    assert.deepEqual(
      delta.map((i) => i.text),
      ['one (edited)', 'three'],
      'edited-but-old item still sorts before the newer one',
    );
  });

  test('trims to maxItems without losing the newest', () => {
    const feed = new Feed({ maxItems: 5 });
    for (let i = 0; i < 20; i++) feed.append({ kind: 'text', text: `m${i}` });
    assert.equal(feed.items.length, 5);
    assert.equal(feed.items.at(-1).text, 'm19');
  });

  test('emits a patch for every append and update', () => {
    const patches = [];
    const feed = new Feed({ onPatch: (p) => patches.push(p.op) });
    const item = feed.append({ kind: 'text', text: 'x' });
    feed.update(item, { text: 'y' });
    assert.deepEqual(patches, ['append', 'update']);
  });
});

describe('tool grouping', () => {
  test('consecutive tool calls share a group', () => {
    const feed = new Feed();
    feed.append({ kind: 'tool', name: 'Write' });
    feed.append({ kind: 'tool', name: 'Bash' });
    const groups = new Set(feed.items.filter((i) => i.kind === 'tool').map((i) => i.group));
    assert.equal(groups.size, 1);
  });

  test('assistant prose ends a run', () => {
    const feed = new Feed();
    feed.append({ kind: 'tool', name: 'Write' });
    feed.append({ kind: 'text', text: 'Now the next part:' });
    feed.append({ kind: 'tool', name: 'Bash' });

    const [first, second] = feed.items.filter((i) => i.kind === 'tool');
    assert.notEqual(first.group, second.group);
  });

  test('a new user turn ends a run', () => {
    const feed = new Feed();
    feed.append({ kind: 'tool', name: 'Bash' });
    feed.append({ kind: 'user', text: 'also do this' });
    feed.append({ kind: 'tool', name: 'Bash' });

    const [first, second] = feed.items.filter((i) => i.kind === 'tool');
    assert.notEqual(first.group, second.group);
  });

  test('thinking and permission prompts belong to the run and do not split it', () => {
    const feed = new Feed();
    feed.append({ kind: 'tool', name: 'Write' });
    feed.append({ kind: 'thinking', text: 'considering' });
    feed.append({ kind: 'permission', title: 'Run Bash', state: 'pending' });
    feed.append({ kind: 'tool', name: 'Bash' });

    const groups = new Set(feed.items.filter((i) => i.kind === 'tool').map((i) => i.group));
    assert.equal(groups.size, 1, 'the run survives thinking and an approval');
  });

  test('every tool carries its category for the summary line', () => {
    const feed = new Feed();
    feed.append({ kind: 'tool', name: 'Edit' });
    feed.append({ kind: 'tool', name: 'Bash' });
    feed.append({ kind: 'tool', name: 'Grep' });
    feed.append({ kind: 'tool', name: 'mcp__thing__do' });

    assert.deepEqual(
      feed.items.map((i) => i.toolKind),
      ['write', 'run', 'read', 'other'],
    );
  });

  test('consecutive thinking blocks merge into one', () => {
    const feed = new Feed();
    feed.append({ kind: 'thinking', text: 'first thought' });
    feed.append({ kind: 'thinking', text: 'second thought' });

    const thinking = feed.items.filter((i) => i.kind === 'thinking');
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].text, 'first thought\n\nsecond thought');
  });

  test('thinking separated by other content stays separate', () => {
    const feed = new Feed();
    feed.append({ kind: 'thinking', text: 'before' });
    feed.append({ kind: 'tool', name: 'Bash' });
    feed.append({ kind: 'thinking', text: 'after' });
    assert.equal(feed.items.filter((i) => i.kind === 'thinking').length, 2);
  });
});

describe('toolKind', () => {
  test('classifies writes, commands, lookups and everything else', () => {
    assert.equal(toolKind('Write'), 'write');
    assert.equal(toolKind('Edit'), 'write');
    assert.equal(toolKind('MultiEdit'), 'write');
    assert.equal(toolKind('Bash'), 'run');
    assert.equal(toolKind('Read'), 'read');
    assert.equal(toolKind('Grep'), 'read');
    assert.equal(toolKind('WebSearch'), 'read');
    assert.equal(toolKind('mcp__server__tool'), 'other');
    assert.equal(toolKind('TodoWrite'), 'other');
  });
});

describe('diffStat', () => {
  test('prefers the structuredPatch, which is exact', () => {
    const result = {
      structuredPatch: [
        { lines: [' context', '+added one', '+added two', '-removed one'] },
        { lines: ['+added three', ' context'] },
      ],
    };
    assert.deepEqual(diffStat('Edit', {}, result), { added: 3, removed: 1 });
  });

  test('a new file counts its whole contents as additions', () => {
    assert.deepEqual(diffStat('Write', { content: 'a\nb\nc' }), { added: 3, removed: 0 });
  });

  test('a trailing newline does not invent a line', () => {
    assert.deepEqual(diffStat('Write', { content: 'a\nb\n' }), { added: 2, removed: 0 });
  });

  test('nothing to count means no diffstat, not a misleading zero', () => {
    // Antigravity reports only the path of a file it wrote, so there is no
    // content to measure — the summary row should stay silent rather than
    // claim "+0".
    assert.equal(diffStat('Write', { content: '' }), null);
    assert.equal(diffStat('write_to_file', { TargetFile: '/tmp/x.txt' }), null);
  });

  test('an edit counts both sides', () => {
    assert.deepEqual(
      diffStat('Edit', { old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' }),
      { added: 3, removed: 2 },
    );
  });

  test('MultiEdit sums its edits', () => {
    const input = {
      edits: [
        { old_string: 'a', new_string: 'a\nb' },
        { old_string: 'c\nd', new_string: 'c' },
      ],
    };
    assert.deepEqual(diffStat('MultiEdit', input), { added: 3, removed: 3 });
  });

  test('non-write tools have no diffstat at all', () => {
    assert.equal(diffStat('Bash', { command: 'ls' }), null);
    assert.equal(diffStat('Read', { file_path: '/a' }), null);
  });

  test('an empty patch falls back to the input rather than reporting nothing', () => {
    // Claude Code sends structuredPatch: [] when it writes a brand new file.
    assert.deepEqual(
      diffStat('Write', { content: 'x\ny' }, { structuredPatch: [] }),
      { added: 2, removed: 0 },
    );
  });
});

describe('summarizeTool', () => {
  test('labels the common tools for a small screen', () => {
    assert.deepEqual(summarizeTool('Bash', { command: 'git status\nsecond line' }), {
      title: 'Terminal',
      subtitle: 'git status',
    });
    assert.equal(summarizeTool('Read', { file_path: '/a/b/c/file.ts' }).subtitle, 'c/file.ts');
    assert.equal(summarizeTool('WebSearch', { query: 'tailscale' }).subtitle, 'tailscale');
  });

  test('splits MCP tool names into server and tool', () => {
    assert.deepEqual(summarizeTool('mcp__github__create_issue', {}), {
      title: 'github',
      subtitle: 'create_issue',
    });
  });

  test('falls back to the raw name', () => {
    assert.equal(summarizeTool('SomethingNew', {}).title, 'SomethingNew');
    assert.equal(summarizeTool(undefined, undefined).title, 'Tool');
  });
});

describe('normalizeToolResult', () => {
  test('handles strings, block arrays and stdout objects', () => {
    assert.equal(normalizeToolResult('plain').text, 'plain');
    assert.equal(normalizeToolResult([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]).text, 'a\nb');
    assert.equal(normalizeToolResult({ stdout: 'out', stderr: 'err' }).text, 'out\nerr');
  });

  test('flags errors and truncates runaway output', () => {
    assert.equal(normalizeToolResult({ is_error: true, content: 'nope' }).isError, true);
    const big = normalizeToolResult('x'.repeat(50), 10);
    assert.equal(big.truncated, true);
    assert.ok(big.text.endsWith('… (truncated)'));
  });

  test('never throws on null or odd shapes', () => {
    assert.equal(normalizeToolResult(null).text, '');
    assert.equal(typeof normalizeToolResult({ weird: true }).text, 'string');
  });
});
