// Shared by the CodeMirror editor and native Chrome fields.
export const SUGGEST_DELAY = 200;
export const SUGGEST_MIN = 15;

export function paragraphEnd(text, cursor) {
  if (cursor < 0 || cursor > text.length || (cursor < text.length && text[cursor] !== '\n')) return false;
  const next = text.indexOf('\n', cursor + 1);
  return cursor === text.length || !text.slice(cursor + 1, next < 0 ? text.length : next).trim();
}

export function slashCommand(line, offset = 0) {
  const match = /(?:^|\s)\/(?!\/)(.*)$/u.exec(line);
  if (!match) return null;
  const start = match.index + match[0].indexOf('/');
  return { from: offset + start, to: offset + line.length, text: line.slice(start),
    instruction: match[1].trim(), inline: !!line.slice(0, start).trim() };
}

export function ghostRemainder(text, typed) {
  return typed && text.startsWith(typed) ? text.slice(typed.length) : null;
}

export function distinctVariants(variants, quote, previous) {
  if (!Array.isArray(variants) || variants.some(text => typeof text !== 'string' || !text.trim())) throw Error('The model returned invalid replacements.');
  const normalize = text => text.trim().replace(/\s+/g, ' ').toLowerCase();
  const seen = new Set([normalize(quote), ...(previous ? [normalize(previous)] : [])]);
  const result = variants.map(text => text.trim()).filter(text => {
    const key = normalize(text); if (seen.has(key)) return false; seen.add(key); return true;
  });
  if (!result.length) throw Error('The model returned no different replacements.');
  return result;
}
