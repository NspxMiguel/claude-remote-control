/**
 * Inline SVG icons. Everything the UI draws is a shape, not a character:
 * emoji and typographic glyphs render differently on every platform, change
 * size unpredictably, and cannot take the accent colour.
 */

const svg = (paths, { size = 16, stroke = 1.8, fill = false } = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('fill', 'none');

  for (const d of [].concat(paths)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    if (fill) {
      path.setAttribute('fill', 'currentColor');
    } else {
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', String(stroke));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    }
    node.appendChild(path);
  }
  return node;
};

const SHAPES = {
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  terminal: ['M4 7l4 4-4 4', 'M12 15h7'],
  pencil: ['M4 20l4-1 10-10a2.1 2.1 0 00-3-3L5 16l-1 4z'],
  file: ['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5'],
  search: ['M11 19a8 8 0 100-16 8 8 0 000 16z', 'M21 21l-4.3-4.3'],
  globe: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M3 12h18', 'M12 3a15 15 0 010 18a15 15 0 010-18z'],
  gear: [
    'M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
    'M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 009 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 9a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
  ],
  dot: ['M12 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z'],
  plug: ['M9 3v6', 'M15 3v6', 'M7 9h10v3a5 5 0 01-10 0z', 'M12 17v4'],
  folder: ['M4 6h7l2 2h7v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z'],
  plus: ['M12 5v14', 'M5 12h14'],
  chevron: ['M9 6l6 6-6 6'],
  mic: ['M12 4a3 3 0 013 3v5a3 3 0 01-6 0V7a3 3 0 013-3z', 'M5 11a7 7 0 0014 0M12 18v3'],
  // Two arcs and a cone: a speaker, for reading a reply out loud.
  speaker: ['M4 10v4h3l4 3V7L7 10H4z', 'M15.5 9.5a3.5 3.5 0 010 5', 'M18 7a7 7 0 010 10'],
  speakerOff: ['M4 10v4h3l4 3V7L7 10H4z', 'M16 10l4 4M20 10l-4 4'],
};

export function icon(name, options) {
  const shape = SHAPES[name] || SHAPES.dot;
  return svg(shape, options);
}

/** The mark shown on a tool card, chosen by what the tool does. */
export function toolIcon(name) {
  switch (name) {
    case 'Bash':
    case 'run_command':
      return icon('terminal');
    case 'Write':
    case 'write_to_file':
    case 'Edit':
    case 'MultiEdit':
    case 'edit_file':
    case 'replace_file_content':
    case 'NotebookEdit':
      return icon('pencil');
    case 'Read':
    case 'view_file':
    case 'read_file':
    case 'NotebookRead':
      return icon('file');
    case 'Glob':
    case 'Grep':
    case 'grep_search':
    case 'codebase_search':
    case 'find_by_name':
    case 'WebSearch':
    case 'search_web':
      return icon('search');
    case 'WebFetch':
    case 'read_url_content':
      return icon('globe');
    case 'Task':
    case 'Agent':
      return icon('gear');
    default:
      return icon('dot', { fill: true });
  }
}
