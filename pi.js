import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_MODELS = [
  ['amazon-bedrock', 'eu.anthropic.claude-sonnet-4-6'],
  ['openrouter', 'auto'],
];

let runtimePromise;
const runtime = () => runtimePromise ??= ModelRuntime.create({ allowModelNetwork: false });

const requestedThinking = () => THINKING_LEVELS.includes(process.env.PI_THINKING_LEVEL)
  ? process.env.PI_THINKING_LEVEL
  : 'medium';

const selectionFor = (model, thinkingLevel = requestedThinking()) => ({
  provider: model.provider,
  model: model.id,
  thinkingLevel: clampThinkingLevel(model, thinkingLevel),
});

export async function getAgentStatus() {
  try {
    const rt = await runtime();
    const available = await rt.getAvailable();
    const unique = [...new Map(available.map(model => [`${model.provider}\0${model.id}`, model])).values()];
    const models = unique.map(model => ({
      provider: model.provider,
      model: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
    const providers = [...new Set(models.map(model => model.provider))].map(id => ({
      id,
      name: rt.getProvider(id)?.name ?? id,
      models: models.filter(model => model.provider === id),
    }));
    const authProviders = rt.getProviders()
      .filter(provider => provider.auth.apiKey?.login)
      .map(provider => {
        const status = rt.getProviderAuthStatus(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          label: provider.auth.apiKey.name,
          configured: status.configured,
          ...(status.source ? { source: status.source } : {}),
        };
      });
    const configured = process.env.PI_PROVIDER && process.env.PI_MODEL
      ? unique.find(model => model.provider === process.env.PI_PROVIDER && model.id === process.env.PI_MODEL)
      : undefined;
    const selected = configured
      ?? FALLBACK_MODELS.map(([provider, id]) => unique.find(model => model.provider === provider && model.id === id)).find(Boolean)
      ?? unique[0];
    return {
      available: models.length > 0,
      ...(selected ? { defaultSelection: selectionFor(selected) } : {}),
      providers,
      models,
      authProviders,
      ...(rt.getError() ? { error: rt.getError() } : {}),
    };
  } catch (error) {
    return { available: false, providers: [], models: [], authProviders: [], error: error.message };
  }
}

export async function saveProviderApiKey(providerId, apiKey) {
  const rt = await runtime();
  const provider = rt.getProvider(providerId);
  if (!provider?.auth.apiKey?.login) throw new Error(`Provider ${providerId} does not support API-key login`);
  if (!apiKey.trim() || apiKey.length > 10_000) throw new Error('API key is empty or too long');
  await rt.login(providerId, 'api_key', { prompt: async () => apiKey.trim(), notify: () => {} });
}

export async function removeProviderApiKey(providerId) {
  const rt = await runtime();
  if (!rt.getProvider(providerId)) throw new Error(`Unknown provider ${providerId}`);
  await rt.logout(providerId);
}

async function resolveModel(selection) {
  const rt = await runtime();
  if (!selection && process.env.PI_PROVIDER && process.env.PI_MODEL) {
    selection = { provider: process.env.PI_PROVIDER, model: process.env.PI_MODEL, thinkingLevel: requestedThinking() };
  }
  if (selection) {
    const model = rt.getModel(selection.provider, selection.model);
    if (!model) throw new Error(`Unknown Pi model ${selection.provider}/${selection.model}`);
    const available = await rt.getAvailable(selection.provider);
    if (!available.some(candidate => candidate.id === selection.model)) {
      throw new Error(`Pi model ${selection.provider}/${selection.model} is not authenticated or unavailable`);
    }
    return { rt, model, selection: selectionFor(model, selection.thinkingLevel) };
  }
  const available = await rt.getAvailable();
  const model = FALLBACK_MODELS.map(([provider, id]) => available.find(candidate => candidate.provider === provider && candidate.id === id)).find(Boolean)
    ?? available[0];
  if (!model) throw new Error('No authenticated Pi model is available; open Settings and add an API key');
  return { rt, model, selection: selectionFor(model) };
}

// Either a single user turn or a whole transcript — the chat needs the latter.
const request = (systemPrompt, userPrompt, history) => ({
  systemPrompt,
  messages: (history ?? [{ role: 'user', content: userPrompt }])
    .map(message => ({ role: message.role, content: message.content, timestamp: Date.now() })),
});

const options = (selection, maxTokens, signal) => ({
  maxTokens,
  signal,
  ...(selection.thinkingLevel === 'off' ? {} : { reasoning: selection.thinkingLevel }),
});

export async function completeText({ systemPrompt, userPrompt, selection, maxTokens = 1500, signal }) {
  const resolved = await resolveModel(selection);
  const response = await resolved.rt.completeSimple(
    resolved.model,
    request(systemPrompt, userPrompt),
    options(resolved.selection, maxTokens, signal),
  );
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new Error(response.errorMessage ?? 'Pi request failed');
  }
  return response.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim();
}

export async function streamText({ systemPrompt, userPrompt, messages, selection, maxTokens = 2000, signal, onText }) {
  const resolved = await resolveModel(selection);
  const stream = resolved.rt.streamSimple(
    resolved.model,
    request(systemPrompt, userPrompt, messages),
    options(resolved.selection, maxTokens, signal),
  );
  for await (const event of stream) {
    if (event.type === 'text_delta') onText(event.delta);
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'Pi request failed');
  }
}
