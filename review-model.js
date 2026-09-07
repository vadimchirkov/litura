import { completeText } from './pi.js';
import { mergeReviewFindings, parseReviewResponse, validateReviewFindings } from './review.js';

async function requestReviewPass({ systemPrompt, userPrompt, allowedCodes, source, selection, attempts, signal }) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const raw = await completeText({
        systemPrompt,
        userPrompt: attempt === 0
          ? userPrompt
          : `${userPrompt}\n\n---\n\nRESPONSE RETRY: ${lastError.message}. Return the valid JSON array required by the system prompt, even when it is empty.`,
        selection,
        maxTokens: 4000,
        signal,
      });
      const findings = parseReviewResponse(raw);
      validateReviewFindings(findings, allowedCodes, source);
      return findings;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function requestReview({ systemPrompt, userPrompt, prompts, selection, attempts = 3, signal = AbortSignal.timeout(120_000), detailed = false }) {
  const requests = prompts ?? [{ systemPrompt, userPrompt }];
  const results = await Promise.allSettled(requests.map(prompt => requestReviewPass({
    ...prompt,
    selection,
    attempts,
    signal,
  })));
  const groups = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (!groups.length) throw results[0].reason;
  const findings = mergeReviewFindings(groups);
  const failedPasses = results.flatMap((result, index) => result.status === 'rejected' ? [requests[index].phase ?? String(index + 1)] : []);
  if (!detailed && failedPasses.length) throw new Error(`Incomplete review: ${failedPasses.join(', ')}`);
  return detailed ? { findings, failedPasses, complete: failedPasses.length === 0 } : findings;
}
