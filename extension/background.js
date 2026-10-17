const protectedStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const defaults = { server: 'http://127.0.0.1:3000', enabled: true, suggestions: true, agent: null };

function localServer(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Use a local address, for example http://127.0.0.1:3000');
  return url.origin;
}

async function settings() {
  await protectedStorage;
  return { ...defaults, ...await chrome.storage.local.get() };
}

async function notifySettings() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'settings-changed' })));
}

async function request(route, body, signal) {
  const config = await settings();
  if (!config.token) throw Error('Open Stilura settings in the Chrome toolbar and connect to the local app.');
  const response = await fetch(localServer(config.server) + route, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal,
    headers: { 'X-Stilura-Extension': config.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ ...body, agent: config.agent ?? undefined }) } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Error(data.error || `Stilura returned HTTP ${response.status}`);
  }
  return response;
}

async function connect(server) {
  const origin = localServer(server);
  const tab = await chrome.tabs.create({ url: origin + '/extension', active: false });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(updated); reject(Error('Local app did not respond. Start Stilura and check the address.')); }, 10000);
      const updated = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.get(tab.id).then(current => updated(tab.id, current), error => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); reject(error); });
    });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, args: [origin],
      func: async expected => {
        if (location.origin !== expected || location.pathname !== '/extension') throw Error('Unexpected connection page');
        const response = await fetch('/api/extension/connection', { cache: 'no-store' });
        if (!response.ok) throw Error('Update and restart the local Stilura app.');
        return response.json();
      },
    });
    if (!/^[a-f0-9]{64}$/.test(result?.result?.token ?? '')) throw Error('Update and restart the local Stilura app.');
    await protectedStorage;
    await chrome.storage.local.set({ server: origin, token: result.result.token });
    await notifySettings();
    return (await request('/api/agent/status', null, AbortSignal.timeout(15000))).json();
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const ownPage = sender.url === chrome.runtime.getURL('popup.html');
  (async () => {
    const config = await settings();
    if (message.type === 'settings') return { server: config.server, enabled: config.enabled, suggestions: config.suggestions, connected: !!config.token, ...(ownPage ? { agent: config.agent } : {}) };
    if (!ownPage) throw Error('Settings are only available in the extension.');
    if (message.type === 'connect') return connect(message.server);
    if (message.type === 'status') return (await request('/api/agent/status', null, AbortSignal.timeout(15000))).json();
    if (message.type === 'save') {
      if (typeof message.enabled !== 'boolean' || typeof message.suggestions !== 'boolean') throw Error('Invalid settings');
      const agent = message.agent;
      if (agent !== null && (!agent || typeof agent.provider !== 'string' || typeof agent.model !== 'string')) throw Error('Invalid model');
      await chrome.storage.local.set({ enabled: message.enabled, suggestions: message.suggestions, agent });
      await notifySettings();
      return { saved: true };
    }
    throw Error('Unknown request');
  })().then(data => reply({ data }), error => reply({ error: error.message }));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'stilura-action' || port.sender?.id !== chrome.runtime.id || !port.sender.tab) return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  const send = value => { if (!controller.signal.aborted) { try { port.postMessage(value); } catch { controller.abort(); } } };
  let started = false;
  port.onMessage.addListener(message => {
    if (started) return;
    started = true;
    (async () => {
      const config = await settings();
      if (!config.enabled || (message.action === 'suggest' && !message.body?.manual && !config.suggestions)) throw Error('Stilura is paused.');
      if (!['ask', 'write', 'suggest'].includes(message.action)) throw Error('Unknown action');
      const body = message.body;
      if (!body || typeof body.document !== 'string' || body.document.length > 60000) throw Error('Use a field with up to 60,000 characters.');
      const response = await request('/' + message.action, body, AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]));
      if (message.action !== 'write') { send({ data: await response.json(), done: true }); return; }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', answer = '', done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const value = line.slice(6);
            if (value === '[DONE]') { done = true; break; }
            const event = JSON.parse(value);
            if (event.error) throw Error(event.error);
            answer = typeof event.replace === 'string' ? event.replace : answer + (event.text ?? '');
            send({ text: answer });
          }
        }
      }
      if (!done || !answer.trim()) throw Error('Generation ended before a complete answer arrived. Try again.');
      send({ data: { text: answer.trim() }, done: true });
    })().catch(error => send({ error: error.message }));
  });
});
