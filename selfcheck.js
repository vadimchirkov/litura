import assert from 'node:assert/strict';
import { getAgentStatus } from './pi.js';

const status = await getAgentStatus();
assert(Array.isArray(status.providers));
assert(Array.isArray(status.models));
assert(Array.isArray(status.authProviders));
if (status.defaultSelection) {
  assert(status.models.some(model =>
    model.provider === status.defaultSelection.provider && model.model === status.defaultSelection.model));
}

console.log(`Pi self-check: ${status.models.length} available model(s)`);
