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

