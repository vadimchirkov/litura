const $ = id => document.getElementById(id);
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw Error(result.error);
  return result.data;
}
function status(text) { $('status').textContent = text; }
function models(data, selected = null) {
  $('model').replaceChildren(new Option('App default', 'null'));
  let found = !selected;
  for (const model of data.models ?? []) {
    const agent = { provider: model.provider, model: model.model, thinkingLevel: 'off' };
    const option = new Option(`${model.name} · ${model.provider}`, JSON.stringify(agent));
    option.selected = selected?.provider === agent.provider && selected?.model === agent.model;
    if (option.selected) found = true;
    $('model').append(option);
  }
  status(data.available ? 'Connected. Ready to write.' : 'Connected. Add a model or sign in inside the Stilura app.');
  if (!found) {
    $('model').append(new Option(`Unavailable: ${selected.provider} / ${selected.model}`, JSON.stringify(selected), true, true));
    status('Connected. The selected model is unavailable. Start it or choose another model.');
  }
}
$('connection').addEventListener('submit', async event => {
  event.preventDefault(); $('connect').disabled = true; status('Connecting…');
  try {
    const data = await send({ type: 'connect', server: $('server').value.trim() });
    models(data, (await send({ type: 'settings' })).agent); $('server').removeAttribute('aria-invalid');
  }
  catch (error) { status(error.message); $('server').setAttribute('aria-invalid', 'true'); }
  finally { $('connect').disabled = false; }
});
for (const id of ['enabled', 'suggestions', 'model']) $(id).addEventListener('change', async () => {
  try {
    await send({ type: 'save', enabled: $('enabled').checked, suggestions: $('suggestions').checked, agent: JSON.parse($('model').value) });
    status('Settings saved.');
  } catch (error) { status(error.message); }
});
try {
  const config = await send({ type: 'settings' });
  $('server').value = config.server; $('enabled').checked = config.enabled; $('suggestions').checked = config.suggestions;
  if (config.connected) models(await send({ type: 'status' }), config.agent);
} catch (error) { status(error.message); }
