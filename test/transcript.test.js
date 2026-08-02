import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Feed } from '../src/protocol.js';
import { applyTranscriptLine, foldToolResult, parseLines } from '../src/mirror/transcript.js';

describe('parseLines', () => {
  test('holds back a half-written trailing line', () => {
    const { lines, remainder } = parseLines('{"type":"a"}\n{"type":"b"}\n{"type":"c');
    assert.deepEqual(lines.map((l) => l.type), ['a', 'b']);
    assert.equal(remainder, '{"type":"c');
  });

  test('completes a line across two chunks', () => {
    const first = parseLines('{"ty');
    const second = parseLines('pe":"done"}\n', first.remainder);
    assert.deepEqual(second.lines, [{ type: 'done' }]);
  });

  test('skips unparseable lines instead of throwing', () => {
    const { lines } = parseLines('not json\n{"type":"ok"}\n');
    assert.deepEqual(lines, [{ type: 'ok' }]);
  });

  test('ignores blank lines', () => {
    const { lines } = parseLines('\n\n{"type":"ok"}\n\n');
    assert.equal(lines.length, 1);
  });
});

describe('applyTranscriptLine', () => {
  test('records a human prompt and its metadata', () => {
    const feed = new Feed();
    const meta = applyTranscriptLine(feed, {
      type: 'user',
      cwd: '/Users/x/proj',
      gitBranch: 'main',
      entrypoint: 'claude-desktop',
      timestamp: '2026-08-02T03:31:45.477Z',
      message: { role: 'user', content: 'do the thing' },
    });

    assert.equal(feed.items[0].kind, 'user');
    assert.equal(feed.items[0].text, 'do the thing');
    assert.equal(meta.cwd, '/Users/x/proj');
    assert.equal(meta.entrypoint, 'claude-desktop');
    assert.equal(meta.lastActivityAt, Date.parse('2026-08-02T03:31:45.477Z'));
  });

  test('treats a tool_result user line as a result, not a prompt', () => {
    const feed = new Feed();
    applyTranscriptLine(feed, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
    });
    applyTranscriptLine(feed, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }] },
      toolUseResult: { stdout: 'a.txt', stderr: '' },
    });

    assert.equal(feed.items.filter((i) => i.kind === 'user').length, 0, 'no phantom user bubble');
    const tool = feed.items.find((i) => i.kind === 'tool');
    assert.equal(tool.status, 'done');
    assert.equal(tool.result, 'a.txt');
  });

  test('splits an assistant message into text, thinking and tool items', () => {
    const feed = new Feed();
    applyTranscriptLine(feed, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'considering' },
          { type: 'text', text: 'Here you go' },
          { type: 'tool_use', id: 'tu9', name: 'Read', input: { file_path: '/tmp/a' } },
        ],
      },
    });
    assert.deepEqual(feed.items.map((i) => i.kind), ['thinking', 'text', 'tool']);
  });

  test('skips subagent sidechain lines', () => {
    const feed = new Feed();
    applyTranscriptLine(feed, {
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: 'subagent chatter' },
    });
    applyTranscriptLine(feed, {
      type: 'assistant',
      isSidechain: true,
      message: { content: [{ type: 'text', text: 'subagent reply' }] },
    });
    assert.equal(feed.items.length, 0);
  });

  test('says which kind of title a line carried', () => {
    // The distinction is the whole point: a transcript holds one custom-title
    // near the top and a stream of ai-titles after it, and the app was naming
    // conversations differently from the Claude Desktop it mirrors.
    const feed = new Feed();
    assert.equal(applyTranscriptLine(feed, { type: 'ai-title', aiTitle: 'Generated' }).titleKind, 'ai');
    assert.equal(
      applyTranscriptLine(feed, { type: 'custom-title', customTitle: 'Mine' }).titleKind,
      'custom',
    );
  });

  test('picks up titles from either title line type', () => {
    const feed = new Feed();
    assert.equal(applyTranscriptLine(feed, { type: 'ai-title', aiTitle: 'Generated' }).title, 'Generated');
    assert.equal(applyTranscriptLine(feed, { type: 'custom-title', customTitle: 'Mine' }).title, 'Mine');
  });

  test('ignores line types it does not model', () => {
    const feed = new Feed();
    assert.deepEqual(applyTranscriptLine(feed, { type: 'something-new', payload: 1 }), {});
    assert.equal(feed.items.length, 0);
  });

  test('empty user content produces no bubble', () => {
    const feed = new Feed();
    applyTranscriptLine(feed, { type: 'user', message: { role: 'user', content: '   ' } });
    assert.equal(feed.items.length, 0);
  });
});

describe('foldToolResult', () => {
  test('uses the sidecar field when the block itself carries no content', () => {
    const feed = new Feed();
    applyTranscriptLine(feed, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
    });
    foldToolResult(feed, {
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
      toolUseResult: { stdout: 'from sidecar' },
    });
    assert.equal(feed.items.find((i) => i.kind === 'tool').result, 'from sidecar');
  });

  test('does nothing without a sidecar', () => {
    const feed = new Feed();
    assert.doesNotThrow(() => foldToolResult(feed, { message: { content: [] } }));
  });
});
