'use strict';

/**
 * Small, dependency-free Markdown renderer for assistant messages.
 * Everything is escaped before formatting; only http(s) links survive.
 */
(function markdownModule() {
  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const escapeAttribute = (value) => escapeHtml(value).replace(/`/g, '&#96;');

  function renderInline(raw) {
    let text = escapeHtml(raw);
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
      return `<a href="${escapeAttribute(url)}" data-external="${escapeAttribute(url)}">${label}</a>`;
    });
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_match, prefix, url) => {
      return `${prefix}<a href="${escapeAttribute(url)}" data-external="${escapeAttribute(url)}">${url}</a>`;
    });
    return text;
  }

  function renderCode(code, language, open) {
    const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : '';
    const copy = open ? '' : '<button type="button" class="code-copy" title="Copy code">Copy</button>';
    return `<div class="code-block"><div class="code-head">${label}${copy}</div><pre><code>${escapeHtml(code)}</code></pre></div>`;
  }

  function render(raw, options = {}) {
    const source = String(raw ?? '').replace(/\r\n/g, '\n');
    if (!source.trim()) return '';
    const lines = source.split('\n');
    const output = [];
    let paragraph = [];
    let list = null;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      output.push(`<${list.tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph();
        flushList();
        const language = fence[1] || '';
        const codeLines = [];
        let closed = false;
        index += 1;
        for (; index < lines.length; index += 1) {
          if (/^\s*```\s*$/.test(lines[index])) {
            closed = true;
            break;
          }
          codeLines.push(lines[index]);
        }
        output.push(renderCode(codeLines.join('\n'), language, !closed));
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushParagraph();
        flushList();
        output.push('<hr>');
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length + 1;
        output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }

      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        flushList();
        output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
        continue;
      }

      const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph();
        const tag = unordered ? 'ul' : 'ol';
        if (!list || list.tag !== tag) {
          flushList();
          list = {tag, items: []};
        }
        list.items.push((unordered || ordered)[1]);
        continue;
      }

      if (list) flushList();
      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    if (options.streaming && !source.endsWith('\n') && output.length) {
      output.push('<span class="stream-caret" aria-hidden="true"></span>');
    }
    return output.join('');
  }

  window.JarvisMarkdown = {render, escapeHtml};
})();
