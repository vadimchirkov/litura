import assert from 'node:assert/strict';
import { cancelOAuth, getOAuthStatus, startOAuth, submitOAuthCode } from '../pi.js';

// Subscription sign-in: the allowlist, method validation, and the session
// state machine — without starting a real browser flow.
await assert.rejects(startOAuth('anthropic'), /not offered/);
await assert.rejects(startOAuth('nope'), /not offered/);
await assert.rejects(startOAuth('openai-codex', 'bogus'), /method/);

const status = await getOAuthStatus();
assert(Array.isArray(status.supported));
assert(status.supported.some(provider => provider.id === 'openai-codex' && provider.isSubscription));
assert(!status.supported.some(provider => provider.id === 'anthropic'), 'Claude OAuth must never be offered');
assert.equal(status.active, null);

await assert.rejects(submitOAuthCode('whatever'), /waiting for a code/);
await assert.rejects(submitOAuthCode('   '), /empty/);
assert.deepEqual(await cancelOAuth(), { active: null });

console.log('OAuth checks passed: allowlist, method validation, status shape, idle code/cancel paths.');
