export async function openStorage({ desktop, browser = window.localStorage, request = fetch, onError }) {
  if (!desktop) return browser;
  const response = await request('/api/desktop/storage');
  if (!response.ok) throw new Error('Could not open the desktop backup.');
  const entries = new Map((await response.json()).entries);
  const pending = new Map();
  let writing = null;
  async function flush() {
    if (writing) return writing;
    if (!pending.size) return;
    writing = (async () => {
      try {
      while (pending.size) {
        const [key, value] = pending.entries().next().value;
        const result = await request('/api/desktop/storage', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        });
        if (!result.ok) throw new Error('Desktop backup failed. Keep the app open and retry saving.');
        if (pending.get(key) === value) pending.delete(key);
      }
      } finally { writing = null; }
    })();
    return writing;
  }
  function change(key, value) {
    if (value === null) entries.delete(key); else entries.set(key, value);
    // Retain the current origin's browser backup too, for recovery.
    try { if (value === null) browser.removeItem(key); else browser.setItem(key, value); } catch {}
    pending.set(key, value);
    flush().catch(onError);
  }
  // Import once; an old origin must not resurrect keys deleted on disk.
  if (entries.size === 0) for (let i = 0; i < browser.length; i++) {
    const key = browser.key(i);
    if (/^(wa-|litura:)/.test(key) && !entries.has(key)) change(key, browser.getItem(key));
  }
  await flush();
  return {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => change(key, String(value)),
    removeItem: key => change(key, null),
    flush,
  };
}
