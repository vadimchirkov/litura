// Minimal Markdown for chat replies.
//
// Safety comes from order: the source is HTML-escaped first, so nothing the
// model writes can become a tag. Only the fixed set of elements below is ever
// emitted, which is why this needs no sanitiser and no dependency.
//
// ponytail: covers what shows up in short answers — emphasis, code, lists,
// links. No tables, footnotes, or nested lists. Reach for a real parser if
// replies ever grow into documents.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = text => text.replace(/[&<>"']/g, char => ESCAPES[char]);

// NUL cannot appear in model output and survives escaping, so a stashed code
// block never collides with ordinary prose like "I have 3 apples".
const MARK = '\u0000';
const PLACEHOLDER = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
const IS_PLACEHOLDER = new RegExp(`^${MARK}\\d+${MARK}$`);

function inline(text) {
  return text
    // href is already escaped; the scheme check keeps out javascript: and data:
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) =>
      /^https?:\/\//i.test(href)
        ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : whole)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');
}

function block(text) {
  if (!text) return '';
  if (IS_PLACEHOLDER.test(text)) return text;  // a fenced block stands alone

  const lines = text.split('\n');
  if (lines.every(line => /^\s*[-*+]\s+/.test(line))) {
    return `<ul>${lines.map(line => `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('')}</ul>`;
  }
  if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) {
    return `<ol>${lines.map(line => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
  }
  const heading = lines.length === 1 && text.match(/^#{1,6}\s+(.+)$/);
  if (heading) return `<p class="md-heading">${inline(heading[1])}</p>`;

  return `<p>${inline(text)}</p>`;
}

export function renderMarkdown(source) {
  const stash = [];
  const keep = html => `${MARK}${stash.push(html) - 1}${MARK}`;

  // Lift code out before anything else, so emphasis rules never run inside it.
  const text = escapeHtml(String(source ?? ''))
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, body) => keep(`<pre><code>${body.replace(/\n$/, '')}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_, body) => keep(`<code>${body}</code>`));

  return text
    .split(/\n{2,}/)
    .map(part => block(part.trim()))
    .join('')
    .replace(PLACEHOLDER, (_, index) => stash[Number(index)]);
}
