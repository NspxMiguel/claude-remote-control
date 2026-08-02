/**
 * Assistant output regularly quotes files, web pages and command output, so the
 * renderer is treated as a security boundary. These tests exist to keep it one.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { escapeHtml, renderMarkdown } from '../web/markdown.js';

describe('escaping hostile content', () => {
  const hostile = [
    ['<script>alert(1)</script>', '<script'],
    ['<img src=x onerror="alert(1)">', '<img'],
    ['<svg onload="alert(1)">', '<svg'],
    ['<iframe src="evil"></iframe>', '<iframe'],
    ['<a href="javascript:alert(1)">x</a>', '<a href="javascript'],
    ['<style>body{display:none}</style>', '<style'],
    ['<body onload="alert(1)">', '<body'],
  ];

  for (const [input, forbidden] of hostile) {
    test(`neutralises ${forbidden}`, () => {
      const html = renderMarkdown(input);
      assert.ok(!html.includes(forbidden), `rendered output must not contain ${forbidden}: ${html}`);
      assert.ok(html.includes('&lt;'), 'the tag survives as visible text');
    });
  }

  test('escapes inside code spans and fences too', () => {
    assert.ok(!renderMarkdown('`<script>x</script>`').includes('<script'));
    assert.ok(!renderMarkdown('```\n<script>x</script>\n```').includes('<script'));
  });

  test('escapes inside emphasis and headings', () => {
    assert.ok(!renderMarkdown('**<img src=x onerror=y>**').includes('<img'));
    assert.ok(!renderMarkdown('# <img src=x onerror=y>').includes('<img'));
    assert.ok(!renderMarkdown('- <img src=x onerror=y>').includes('<img'));
  });

  test('escapes quotes so injected attributes cannot break out', () => {
    const html = renderMarkdown('[x](https://a.com") onload="alert(1)')
    assert.ok(!html.includes('onload="alert'), html);
  });
});

describe('links', () => {
  test('renders http(s) links with safe rel attributes', () => {
    const html = renderMarkdown('[example](https://example.com/page?a=1)');
    assert.match(html, /<a href="https:\/\/example\.com\/page\?a=1"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /target="_blank"/);
  });

  test('refuses javascript:, data: and file: URLs', () => {
    for (const scheme of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd']) {
      const html = renderMarkdown(`[click](${scheme})`);
      assert.ok(!html.includes('<a '), `${scheme} must not become a link: ${html}`);
    }
  });
});

describe('formatting', () => {
  test('paragraphs, bold, italic and inline code', () => {
    const html = renderMarkdown('Plain **bold** and *italic* and `code`.');
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<em>italic</em>'));
    assert.ok(html.includes('<code>code</code>'));
  });

  test('bullet and numbered lists', () => {
    const ul = renderMarkdown('- one\n- two');
    assert.equal((ul.match(/<li>/g) || []).length, 2);
    assert.ok(ul.startsWith('<ul>') && ul.endsWith('</ul>'));

    const ol = renderMarkdown('1. one\n2. two');
    assert.ok(ol.startsWith('<ol>') && ol.endsWith('</ol>'));
  });

  test('a list is closed before following prose', () => {
    const html = renderMarkdown('- item\n\nAfter the list');
    assert.ok(html.indexOf('</ul>') < html.indexOf('After the list'));
  });

  test('fenced code keeps its language and content verbatim', () => {
    const html = renderMarkdown('```js\nconst a = 1 < 2;\n```');
    assert.match(html, /<pre class="code-block" data-lang="js">/);
    assert.ok(html.includes('const a = 1 &lt; 2;'));
  });

  test('headings shift down one level so they never outrank the page', () => {
    assert.match(renderMarkdown('# Title'), /<h2>Title<\/h2>/);
    assert.match(renderMarkdown('### Deep'), /<h4>Deep<\/h4>/);
  });

  test('blockquotes render after escaping', () => {
    assert.match(renderMarkdown('> quoted'), /<blockquote>quoted<\/blockquote>/);
  });

  test('handles empty and whitespace input without throwing', () => {
    assert.equal(renderMarkdown(''), '');
    assert.equal(renderMarkdown('\n\n\n').trim(), '');
  });

  test('multiple code fences stay in order', () => {
    const html = renderMarkdown('```\nfirst\n```\ntext\n```\nsecond\n```');
    assert.ok(html.indexOf('first') < html.indexOf('text'));
    assert.ok(html.indexOf('text') < html.indexOf('second'));
  });

  test('an unclosed fence does not swallow the document', () => {
    const html = renderMarkdown('before\n```\nnever closed');
    assert.ok(html.includes('before'));
  });
});

describe('escapeHtml', () => {
  test('escapes the five characters that matter', () => {
    assert.equal(escapeHtml('<>&"'), '&lt;&gt;&amp;&quot;');
  });

  test('coerces non-strings instead of throwing', () => {
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(null), 'null');
  });
});
