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
// block never collides with ordinary prose like "I have 3 apples". If a model
// ever does emit one, fall back to a private-use character that is absent.
const MARKS = ['\u0000', '\uE000', '\uE001', '\uE002'];

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

function block(text, isPlaceholder) {
  if (!text) return '';
  if (isPlaceholder.test(text)) return text;  // a fenced block stands alone

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
  const raw = String(source ?? '');
  const mark = MARKS.find(candidate => !raw.includes(candidate)) ?? MARKS[0];
  const stash = [];
  const keep = html => `${mark}${stash.push(html) - 1}${mark}`;
  const isPlaceholder = new RegExp(`^${mark}\\d+${mark}$`);
  const placeholder = new RegExp(`${mark}(\\d+)${mark}`, 'g');

  // Lift code out before anything else, so emphasis rules never run inside it.
  const text = escapeHtml(raw)
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, body) => keep(`<pre><code>${body.replace(/\n$/, '')}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_, body) => keep(`<code>${body}</code>`));

  return text
    .split(/\n{2,}/)
    .map(part => block(part.trim(), isPlaceholder))
    .join('')
    .replace(placeholder, (_, index) => stash[Number(index)]);
}
