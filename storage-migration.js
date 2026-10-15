// Copy old entries into the current format; callers retain originals for recovery.
export function migrateStorageEntries(entries) {
  const current = new Map(entries.filter(([key]) => !key.startsWith('litura:')));
  if (current.get('wa-storage-format') === 'stilura') return current;
  let migrated = false;
  for (const [key, value] of entries) {
    if (!key.startsWith('litura:')) continue;
    const renamed = 'stilura:' + key.slice('litura:'.length);
    if (!current.has(renamed)) current.set(renamed, value);
    migrated = true;
  }
  for (const [key, value] of current) {
    if (!key.endsWith(':wa-chat')) continue;
    const chat = value.replaceAll('<litura-edits>', '<stilura-edits>').replaceAll('</litura-edits>', '</stilura-edits>');
    if (chat !== value) { current.set(key, chat); migrated = true; }
  }
  // Written last: interrupted copies retry, deleted current keys never resurrect.
  if (migrated) current.set('wa-storage-format', 'stilura');
  return current;
}
