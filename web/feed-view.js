/**
 * Turns feed items into DOM nodes. Pure rendering: no application state, no
 * network — everything it needs arrives as an argument, so it can be reasoned
 * about (and reused) on its own.
 */

import { el } from './dom.js';
import { renderMarkdown } from './markdown.js';

const TOOL_GLYPH = {
  Bash: '›_',
  Read: '◇',
  Write: '✎',
  Edit: '✎',
  Glob: '⌕',
  Grep: '⌕',
  WebFetch: '↗',
  WebSearch: '⌕',
  Task: '⚙',
  Agent: '⚙',
};



/** Verb for each tool category, used to build a group's summary line. */
const KIND_VERB = { write: 'Edited', run: 'Ran', read: 'Read', other: 'Used' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The one-line summary for a run of tool calls, in the shape the Claude Code
 * desktop app uses: "Created 6 files", "Ran 2 commands, created e2e.mjs".
 * Clauses appear in the order their category first occurred, which is what
 * makes the sentence read like a narration of what happened.
 */
export function groupSummary(tools) {
  const buckets = new Map();
  for (const tool of tools) {
    const kind = tool.toolKind || 'other';
    if (!buckets.has(kind)) buckets.set(kind, []);
    buckets.get(kind).push(tool);
  }

  const clauses = [];
  for (const [kind, group] of buckets) {
    const only = group.length === 1 ? group[0] : null;

    if (kind === 'write') {
      // "Created" reads wrong for an in-place edit, so distinguish the two.
      const created = group.filter((t) => t.name === 'Write').length;
      const verb = created === group.length ? 'Created' : created === 0 ? 'Edited' : 'Changed';
      clauses.push(only ? `${verb} ${fileName(only)}` : `${verb} ${plural(group.length, 'file', 'files')}`);
    } else if (kind === 'run') {
      // One command is more useful named than counted.
      clauses.push(only ? `Ran ${shortCommand(only)}` : `Ran ${plural(group.length, 'command', 'commands')}`);
    } else if (kind === 'read') {
      clauses.push(only ? `Read ${fileName(only)}` : `Read ${plural(group.length, 'file', 'files')}`);
    } else {
      clauses.push(only ? `Used ${only.title || 'a tool'}` : `Used ${plural(group.length, 'tool', 'tools')}`);
    }
  }

  let added = 0;
  let removed = 0;
  for (const tool of tools) {
    added += tool.diff?.added || 0;
    removed += tool.diff?.removed || 0;
  }

  // Two clauses is the readable limit on a phone; the count badge already says
  // how much is inside, so trailing categories are dropped rather than listed.
  const text = clauses
    .slice(0, 2)
    .map((clause, index) => (index === 0 ? clause : clause.charAt(0).toLowerCase() + clause.slice(1)))
    .join(', ');

  return { text, added, removed, hasDiff: added > 0 || removed > 0 };
}

/** A tool's own subtitle is already a short path; take just the file name. */
function fileName(tool) {
  const path = tool.input?.file_path || tool.input?.notebook_path || tool.subtitle || '';
  return String(path).split('/').pop() || 'file';
}

/**
 * The recognisable head of a command — enough to know what ran without the
 * flags, redirects and heredocs that make real commands unreadable inline.
 */
function shortCommand(tool) {
  const command = String(tool.input?.command || tool.subtitle || '').trim();
  if (!command) return 'a command';

  // Real commands open with env assignments, subshells and redirects. Scan the
  // whole thing for the first token that names an actual program.
  const noise = /^([A-Za-z_][A-Za-z0-9_]*=|[(){}<>|&;]|cd$|then$|do$|if$|until$|while$)/;
  const tokens = command.split(/[\s\n]+/).filter(Boolean);
  const start = tokens.findIndex((t) => !noise.test(t));
  if (start === -1) return 'a command';

  const head = tokens
    .slice(start, start + 2)
    .filter((t) => !/^[<>|&]/.test(t))
    .join(' ');
  return head.length > 26 ? `${head.slice(0, 25)}…` : head || 'a command';
}

/** Worst-case status of a run, so the summary can show it without expanding. */
export function groupStatus(tools) {
  if (tools.some((t) => t.status === 'error')) return 'error';
  if (tools.some((t) => t.status === 'denied')) return 'denied';
  if (tools.some((t) => t.status === 'running' || t.status === 'pending' || t.status === 'building')) {
    return 'running';
  }
  return 'done';
}

/**
 * Items re-render whenever they change — a tool card is rebuilt when its result
 * lands. Without this, a card you opened to watch would snap shut at the exact
 * moment it got interesting.
 */
export function carryOverOpenState(oldNode, newNode) {
  const oldBody = oldNode.querySelector?.('.tool-body');
  const newBody = newNode.querySelector?.('.tool-body');
  if (oldBody && newBody) newBody.hidden = oldBody.hidden;

  if (oldNode.tagName === 'DETAILS' && newNode.tagName === 'DETAILS') {
    newNode.open = oldNode.open;
  }
}

/** Keep the transcript chronological even when patches arrive out of order. */
export function insertByOrder(container, node, ord) {
  const children = container.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.id === 'empty-state') continue;
    if (Number(child.dataset.ord || 0) <= ord) {
      child.after(node);
      return;
    }
  }
  container.prepend(node);
}

/**
 * Build (or reuse) the collapsible container for a run of tool calls. Tool cards
 * live inside it; the summary row is rewritten whenever the run changes.
 */
export function ensureGroupNode(groups, feedEl, item, insert) {
  let group = groups.get(item.group);
  if (group) return group;

  const node = el('details', 'item tool-group');
  const summary = el('summary', 'group-summary');
  const list = el('div', 'group-list');
  node.append(summary, list);
  node.dataset.ord = item.ord;

  // Once you open or close a run yourself, it stays how you left it.
  node.addEventListener('toggle', () => {
    node.dataset.touched = '1';
  });

  insert(feedEl, node, item.ord);
  group = { node, summary, list, tools: new Map() };
  groups.set(item.group, group);
  return group;
}

/** Rewrite a group's summary row from the tools currently in it. */
export function refreshGroup(group) {
  const tools = [...group.tools.values()].sort((a, b) => a.ord - b.ord);
  const { text, added, removed, hasDiff } = groupSummary(tools);
  const status = groupStatus(tools);

  group.summary.innerHTML = '';
  group.node.dataset.status = status;

  const caret = el('span', 'group-caret', '›');
  const label = el('span', 'group-label', text);
  group.summary.append(caret, label);

  if (hasDiff) {
    const stat = el('span', 'group-diff');
    if (added) stat.appendChild(el('span', 'add', `+${added}`));
    if (removed) stat.appendChild(el('span', 'del', `−${removed}`));
    group.summary.appendChild(stat);
  }
  if (status === 'running') group.summary.appendChild(el('span', 'group-spinner'));
  else group.summary.appendChild(el('span', 'group-count', String(tools.length)));

  // Follow the work while it happens, then tuck it away — unless the reader
  // has already expressed a preference by toggling it.
  if (!group.node.dataset.touched) group.node.open = status === 'running';
}

export function renderItem(item) {
  switch (item.kind) {
    case 'user': {
      const bubble = el('div', 'item bubble-user', item.text || '');
      if (item.attachments) {
        const chip = el(
          'div',
          'bubble-attach',
          `🖼 ${item.attachments} image${item.attachments === 1 ? '' : 's'}`,
        );
        bubble.prepend(chip);
      }
      return withMeta(bubble, item);
    }

    case 'text': {
      if (!item.text?.trim()) return null;
      const node = el('div', `item assistant${item.streaming ? ' streaming' : ''}`);
      if (item.streaming) {
        // Mid-stream the markdown is half-written — an unclosed fence would
        // flicker, and re-parsing on every token is wasted work on a phone.
        node.textContent = item.text;
      } else {
        node.innerHTML = renderMarkdown(item.text);
      }
      return withMeta(node, item);
    }

    case 'thinking': {
      if (!item.text?.trim()) return null;
      const details = el('details', 'item thinking');
      details.appendChild(el('summary', null, 'Thinking'));
      details.appendChild(el('div', 'body', item.text));
      return withMeta(details, item);
    }

    case 'tool':
      return withMeta(renderTool(item), item);

    case 'permission': {
      if (item.state === 'pending') return null; // the sheet owns pending requests
      const label =
        item.state === 'allowed' || item.state === 'allowed_always'
          ? `Allowed ${item.title}`
          : item.state === 'denied'
            ? `Denied ${item.title}`
            : `${item.title} — ${item.state}`;
      const cls =
        item.state === 'allowed' || item.state === 'allowed_always'
          ? 'allowed'
          : item.state === 'denied'
            ? 'denied'
            : '';
      return withMeta(el('div', `item note perm-note ${cls}`, label), item);
    }

    case 'result': {
      const bits = [];
      if (item.durationMs) bits.push(`${(item.durationMs / 1000).toFixed(1)}s`);
      if (typeof item.costUsd === 'number') bits.push(`$${item.costUsd.toFixed(4)}`);
      if (item.numTurns) bits.push(`${item.numTurns} turn${item.numTurns === 1 ? '' : 's'}`);
      return withMeta(el('div', 'item note', bits.join(' · ') || 'Done'), item);
    }

    case 'error':
      return withMeta(el('div', 'item note error', item.text), item);

    case 'system':
      return withMeta(el('div', 'item note', item.text), item);

    default:
      return null;
  }
}

export function withMeta(node, item) {
  node.dataset.itemId = item.id;
  decorateCodeBlocks(node);
  return node;
}

/**
 * Give every code block a copy button. Reading a command off a phone screen and
 * retyping it is exactly the friction this app exists to remove.
 */
export function decorateCodeBlocks(root) {
  for (const pre of root.querySelectorAll?.('pre.code-block') ?? []) {
    if (pre.parentElement?.classList.contains('code-wrap')) continue;
    const wrap = el('div', 'code-wrap');
    pre.replaceWith(wrap);
    wrap.appendChild(pre);

    const button = el('button', 'code-copy', 'Copy');
    button.type = 'button';
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const ok = await copyText(pre.textContent);
      button.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1600);
    });
    wrap.appendChild(button);
  }
}

/**
 * navigator.clipboard is unavailable over plain HTTP, which is exactly how this
 * app is served on a LAN or tailnet — so fall back to the legacy path.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function renderTool(item) {
  const card = el('div', 'item tool');
  card.dataset.status = item.status || 'pending';

  const head = el('button', 'tool-head');
  head.type = 'button';
  const glyph = el('span', 'tool-icon', TOOL_GLYPH[item.name] || '•');
  const textWrap = el('div', 'tool-text');
  textWrap.appendChild(el('div', 'tool-title', item.title || item.name));
  if (item.subtitle) textWrap.appendChild(el('div', 'tool-sub', item.subtitle));

  const statusLabel = {
    building: '…',
    pending: 'queued',
    running: 'running',
    done: '✓',
    error: 'failed',
    denied: 'denied',
  }[item.status] || '';

  head.append(glyph, textWrap, el('span', 'tool-status', statusLabel));
  card.appendChild(head);

  const body = el('div', 'tool-body');
  body.hidden = true;
  renderToolBody(body, item);
  card.appendChild(body);

  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
  });

  return card;
}

export function renderToolBody(body, item) {
  const input = item.input || {};

  if (item.name === 'Edit' && (input.old_string || input.new_string)) {
    body.appendChild(el('p', 'label', input.file_path || 'Edit'));
    const diff = el('div', 'diff');
    for (const line of String(input.old_string || '').split('\n')) {
      diff.appendChild(el('span', 'del', `- ${line}`));
    }
    for (const line of String(input.new_string || '').split('\n')) {
      diff.appendChild(el('span', 'add', `+ ${line}`));
    }
    body.appendChild(diff);
  } else if (item.name === 'Bash' && input.command) {
    body.appendChild(el('p', 'label', 'Command'));
    body.appendChild(el('pre', 'code-block', input.command));
  } else if (item.name === 'Write' && input.content != null) {
    body.appendChild(el('p', 'label', input.file_path || 'Contents'));
    body.appendChild(el('pre', 'code-block', String(input.content).slice(0, 4000)));
  } else if (Object.keys(input).length) {
    body.appendChild(el('p', 'label', 'Input'));
    body.appendChild(el('pre', 'code-block', JSON.stringify(input, null, 2).slice(0, 4000)));
  }

  if (item.result) {
    body.appendChild(el('p', 'label', item.status === 'error' ? 'Error' : 'Output'));
    body.appendChild(el('pre', 'code-block', item.result));
  }
}

