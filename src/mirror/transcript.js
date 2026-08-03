/**
 * Claude Desktop and the `claude` CLI both append the same JSONL transcript
 * format under ~/.claude/projects. Reading it is how the phone can watch a
 * session that is running on the desktop, live, without touching it.
 */
import { diffStat, normalizeToolResult, summarizeTool } from '../protocol.js';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Claude Code writes `<synthetic>` as the model on lines it generated itself —
 * an error notice, a cancellation. Those are not a model anyone chose, and
 * showing one as the session's model is worse than showing none.
 */
export const isRealModel = (model) =>
  typeof model === 'string' && model.length > 0 && !model.startsWith('<');

/** Apply one transcript line to a feed. Returns metadata found on the line. */
export function applyTranscriptLine(feed, line) {
  const meta = {};

  switch (line.type) {
    case 'user': {
      if (line.isSidechain) return meta; // subagent chatter, not the main thread

      // Claude Code writes its own notices as user-role lines flagged isMeta —
      // "[Image: original 3024x1964, displayed at …]", the local-command
      // caveat, "Continue from where you left off." Rendering those as user
      // turns puts words in your mouth: they show up in the accent bubble as
      // if you had typed them. A prompt the SDK injected is a real turn, and
      // those carry promptSource, so they still come through.
      if (line.isMeta && !line.promptSource) {
        if (line.timestamp) meta.lastActivityAt = Date.parse(line.timestamp);
        return meta;
      }

      const content = line.message?.content;

      // A user line carrying tool_result blocks is a tool completing, not a human typing.
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
        feed.handleToolResults({
          message: line.message,
          tool_use_result: line.toolUseResult,
        });
        return meta;
      }

      const text = textFromContent(content);
      if (text.trim()) feed.append({ kind: 'user', text });
      if (line.cwd) meta.cwd = line.cwd;
      if (line.gitBranch) meta.gitBranch = line.gitBranch;
      if (line.version) meta.version = line.version;
      if (line.entrypoint) meta.entrypoint = line.entrypoint;
      if (line.timestamp) meta.lastActivityAt = Date.parse(line.timestamp);
      return meta;
    }

    case 'assistant': {
      if (line.isSidechain) return meta;
      // Every assistant line names the model that produced it. Without this the
      // UI had nothing to show for a mirrored session and fell back to the
      // first entry in a hardcoded list — telling you Sonnet about an Opus
      // conversation.
      if (isRealModel(line.message?.model)) meta.model = line.message.model;
      const content = line.message?.content;
      if (!Array.isArray(content)) return meta;

      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          feed.append({ kind: 'text', text: block.text });
        } else if (block.type === 'thinking' && block.thinking?.trim()) {
          feed.append({ kind: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          const { title, subtitle } = summarizeTool(block.name, block.input || {});
          const item = feed.append({
            kind: 'tool',
            name: block.name,
            toolUseId: block.id,
            input: block.input || {},
            title,
            subtitle,
            status: 'pending',
            diff: diffStat(block.name, block.input || {}),
          });
          if (block.id) feed.toolIndex.set(block.id, item);
        }
      }
      if (line.timestamp) meta.lastActivityAt = Date.parse(line.timestamp);
      if (line.cwd) meta.cwd = line.cwd;
      if (line.entrypoint) meta.entrypoint = line.entrypoint;
      return meta;
    }

    case 'attachment': {
      const a = line.attachment || {};
      if (a.type === 'file' && a.filename) {
        feed.append({ kind: 'system', text: `Attached ${a.filename}` });
      }
      return meta;
    }

    // Two kinds, and which one wins is not "the latest": see store.js.
    case 'ai-title':
      meta.title = line.aiTitle;
      meta.titleKind = 'ai';
      return meta;

    case 'custom-title':
      meta.title = line.customTitle;
      meta.titleKind = 'custom';
      return meta;

    case 'queue-operation':
      if (line.operation === 'enqueue' && line.content) meta.queued = line.content;
      return meta;

    default:
      return meta;
  }
}

/**
 * Some tool results only exist in the `toolUseResult` sidecar field. Fold those
 * into a shape `Feed.handleToolResults` understands.
 */
export function foldToolResult(feed, line, { onImage } = {}) {
  if (!line.toolUseResult) return;
  const content = line.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const item = feed.toolIndex.get(block.tool_use_id);
    if (!item) continue;
    const { text, isError, truncated } = normalizeToolResult(line.toolUseResult);
    // An image the agent read is in the transcript as base64. It is far too
    // big to travel in a feed patch, so the caller keeps the bytes and hands
    // back an address to fetch them from.
    const picture = onImage && imageFromLine(line);
    feed.update(item, {
      status: isError ? 'error' : 'done',
      result: text,
      resultTruncated: truncated,
      ...(picture ? { imageUrl: onImage(block.tool_use_id, picture) } : {}),
      // structuredPatch lives here, so this is the exact diffstat.
      diff: diffStat(item.name, item.input, line.toolUseResult),
    });
  }
}

/**
 * The picture behind an image tool result, if there is one.
 *
 * Claude Code stores it twice — once as an API-shaped content block and once
 * in the sidecar. The sidecar is checked first because it also carries the
 * media type without digging.
 */
export function imageFromLine(line) {
  const file = line.toolUseResult?.type === 'image' ? line.toolUseResult.file : null;
  if (file?.base64) return { mediaType: file.type || 'image/png', base64: file.base64 };

  for (const block of line.message?.content || []) {
    for (const inner of block?.content || []) {
      const source = inner?.type === 'image' ? inner.source : null;
      if (source?.type === 'base64' && source.data) {
        return { mediaType: source.media_type || 'image/png', base64: source.data };
      }
    }
  }
  return null;
}

/** Split a raw chunk into parsed JSON lines, returning any trailing partial line. */
export function parseLines(chunk, carry = '') {
  const text = carry + chunk;
  const parts = text.split('\n');
  const remainder = parts.pop() ?? '';
  const lines = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // A half-flushed line; the writer will finish it on the next append.
    }
  }
  return { lines, remainder };
}
