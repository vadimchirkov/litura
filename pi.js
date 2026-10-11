import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Named models first. A router picks a different model per request, so the same
// draft comes back rewritten wholesale on one call and empty on the next — the
// app cannot hold a prompt contract against it. Kept last so an OpenRouter-only
// setup still starts, never as the preferred default.
const FALLBACK_MODELS = [
  ['anthropic', 'claude-sonnet-4-6'],
  ['openrouter', 'anthropic/claude-sonnet-4.6'],
  ['openrouter', 'auto'],
];

// Pi ships a snapshot of every provider's model list, and it ages: a model
// added to OpenRouter after the dependency was published cannot be selected at
// all, because `resolveModel` refuses what the catalog does not know. Asking a
// provider what it offers is a call to the provider the writer has already
// pointed the app at, so it is allowed by default. `STILURA_OFFLINE_MODELS=1`
// stops Stilura from asking, and Pi falls back to the list it already has —
// bundled, or cached from an earlier refresh.
const OFFLINE_MODELS = Boolean(process.env.STILURA_OFFLINE_MODELS ?? process.env.LITURA_OFFLINE_MODELS);
let runtimePromise;
const runtime = () => runtimePromise ??= ModelRuntime.create({ allowModelNetwork: !OFFLINE_MODELS })
  .catch(error => {
    // No network, or a provider that will not answer: the snapshot still works.
    console.warn('[pi] model catalog refresh failed, using the bundled list —', error.message);
    // The in-flight assignment already happened; clear it so a later call
    // retries instead of reusing this rejection.
    runtimePromise = undefined;
    return ModelRuntime.create({ allowModelNetwork: false });
  })
  .catch(error => {
    // Even the offline snapshot can fail. Never park a rejected promise in the
    // cache — the next call must try again.
    runtimePromise = undefined;
    throw error;
  });

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

// ─── Subscription sign-in (OAuth) ──────────────────────────────────────────
// Allowlist, not every OAuth provider Pi knows. Anthropic is deliberately
// absent: since February 2026 Anthropic restricts Pro/Max OAuth tokens to
// Claude Code and claude.ai, and routing them through Stilura would violate
// their terms. OpenAI tolerates Codex OAuth in third-party tools, so only
// the ChatGPT Plus/Pro subscription is offered here.
//
// The flow is driven by Pi's CLI-oriented login: a `select` prompt picks the
// method, a notify carries the auth URL (or device code), and a `manual_code`
// prompt stays pending as the paste fallback when the localhost callback
// (fixed port 1455) never fires. The browser UI mirrors each step over three
// small endpoints; the login itself runs in the background.
const OAUTH_PROVIDERS = ['openai-codex'];
const OAUTH_METHODS = ['browser', 'device_code'];

let oauthSession = null;

const oauthSnapshot = session => !session ? null : {
  provider: session.provider,
  method: session.method,
  step: session.step,
  ...(session.url ? { url: session.url } : {}),
  ...(session.userCode ? { userCode: session.userCode } : {}),
  ...(session.verificationUri ? { verificationUri: session.verificationUri } : {}),
  ...(session.error ? { error: session.error } : {}),
};

const oauthError = (status, message) => Object.assign(new Error(message), { status });

export async function getOAuthStatus() {
  const rt = await runtime();
  const supported = [];
  for (const id of OAUTH_PROVIDERS) {
    const provider = rt.getProvider(id);
    if (!provider) continue;
    let configured = false;
    try { configured = !!rt.getProviderAuthStatus(id)?.configured; } catch {}
    supported.push({
      id,
      name: provider.name ?? id,
      ...(provider.auth?.oauth && typeof provider.auth.oauth.name === 'string' ? { label: provider.auth.oauth.name } : {}),
      isSubscription: true,
      configured,
    });
  }
  return { supported, active: oauthSnapshot(oauthSession) };
}

export async function startOAuth(providerId, method = 'browser') {
  if (!OAUTH_PROVIDERS.includes(providerId)) {
    throw oauthError(400, providerId === 'anthropic'
      ? 'Claude Pro/Max sign-in is not offered: Anthropic restricts subscription tokens to Claude Code and claude.ai.'
      : `Sign-in is not offered for provider ${providerId}`);
  }
  if (!OAUTH_METHODS.includes(method)) throw oauthError(400, `Unknown sign-in method ${method}`);
  if (oauthSession && oauthSession.step !== 'done' && oauthSession.step !== 'error') {
    throw oauthError(409, 'A sign-in is already in progress');
  }
  const controller = new AbortController();
  const session = oauthSession = { provider: providerId, method, step: 'starting', controller, resolveManual: null };
  const interaction = {
    signal: controller.signal,
    prompt: async request => {
      if (request?.type === 'select') return method;
      if (request?.type === 'manual_code') {
        return new Promise((resolve, reject) => { session.resolveManual = { resolve, reject }; });
      }
      throw new Error(`Unsupported prompt type ${request?.type}`);
    },
    notify: async note => {
      if (oauthSession !== session) return;
      if (note?.type === 'auth_url' && note.url) {
        session.step = 'url';
        session.url = String(note.url);
      } else if (note?.type === 'device_code') {
        session.step = 'device';
        session.userCode = String(note.userCode ?? '');
        session.verificationUri = String(note.verificationUri ?? '');
      }
    },
  };
  (async () => {
    try {
      const rt = await runtime();
      await rt.login(providerId, 'oauth', interaction);
      if (oauthSession === session) session.step = 'done';
    } catch (error) {
      if (oauthSession !== session) return;
      session.step = 'error';
      session.error = controller.signal.aborted ? 'Sign-in cancelled' : (error?.message || String(error));
    } finally {
      session.resolveManual = null;
    }
  })();
  // The auth URL usually arrives within a second; wait for it briefly so the
  // caller can open it at once, and let status polling cover the slow path.
  const deadline = Date.now() + 10_000;
  while (session.step === 'starting' && Date.now() < deadline && !controller.signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { supported: (await getOAuthStatus()).supported, active: oauthSnapshot(session) };
}

export async function submitOAuthCode(code) {
  const text = String(code ?? '').trim();
  if (!text || text.length > 10_000) throw oauthError(400, 'Pasted code is empty or too long');
  const session = oauthSession;
  if (!session || !session.resolveManual) throw oauthError(409, 'No sign-in is waiting for a code');
  session.resolveManual.resolve(text);
  session.resolveManual = null;
  return { active: oauthSnapshot(session) };
}

export async function cancelOAuth() {
  const session = oauthSession;
  if (!session || session.step === 'done' || session.step === 'error') return { active: oauthSnapshot(session) };
  session.controller.abort();
  session.resolveManual?.reject(new Error('Sign-in cancelled'));
  session.resolveManual = null;
  return { active: oauthSnapshot(oauthSession) };
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
// Assistant turns need content as blocks and a usage stub: Pi's context-token
// estimator reads assistant.usage.totalTokens unconditionally, and its Anthropic
// payload builder iterates assistant.content as blocks — a plain string crashes both.
const request = (systemPrompt, userPrompt, history) => ({
  systemPrompt,
  messages: (history ?? [{ role: 'user', content: userPrompt }])
    .map(message => message.role === 'assistant'
      ? {
          role: 'assistant',
          content: [{ type: 'text', text: message.content }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          timestamp: Date.now(),
        }
      : { role: message.role, content: message.content, timestamp: Date.now() }),
});

const options = (selection, maxTokens, signal) => ({
  maxTokens,
  signal,
  ...(selection.thinkingLevel === 'off' ? {} : { reasoning: selection.thinkingLevel }),
});

// Some endpoints reject `reasoning: off` outright ("Reasoning is mandatory…")
// though the model list says it can be switched off. Remember which, and give
// those models the least reasoning they accept with room to finish.
const reasoningRequired = new Set();
const mandatoryReasoning = response => /reasoning is mandatory/i.test(response.errorMessage ?? '');

export async function completeText({ systemPrompt, userPrompt, selection, maxTokens = 1500, signal, continuation = false }) {
  const resolved = await resolveModel(selection);
  const modelKey = `${resolved.model.provider}/${resolved.model.id}`;
  // Typing suggestions need the least reasoning the model supports, regardless
  // of the author's review settings. Mandatory-reasoning models need headroom.
  const ask = async level => {
    const effectiveSelection = continuation ? selectionFor(resolved.model, level) : resolved.selection;
    const budget = continuation ? (effectiveSelection.thinkingLevel === 'off' ? 256 : 2048) : maxTokens;
    return resolved.rt.completeSimple(resolved.model, request(systemPrompt, userPrompt), options(effectiveSelection, budget, signal));
  };
  let response = await ask(reasoningRequired.has(modelKey) ? 'minimal' : 'off');
  if (continuation && !reasoningRequired.has(modelKey) && response.stopReason === 'error' && mandatoryReasoning(response)) {
    reasoningRequired.add(modelKey);
    response = await ask('minimal');
  }
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new Error(response.errorMessage ?? 'Pi request failed');
  }
  const text = response.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim();
  if (response.stopReason === 'length') {
    if (!continuation) throw new Error('Model output was truncated. Try a smaller passage or less reasoning.');
    // Only continuations may use partial output. Drop the potentially cut word;
    // a reasoning-only response or a single cut token offers nothing to accept.
    const boundary = text.search(/\s+\S*$/u);
    return boundary < 0 ? '' : text.slice(0, boundary).trimEnd();
  }
  return text;
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
    if (event.type === 'done' && event.reason === 'length') throw new Error('Model output was truncated. Try a smaller passage.');
  }
}
