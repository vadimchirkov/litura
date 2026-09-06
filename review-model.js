import { completeText } from './pi.js';
import { mergeReviewFindings, parseReviewResponse, validateReviewFindings } from './review.js';

async function requestReviewPass({ systemPrompt, userPrompt, allowedCodes, source, selection, attempts }) {
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
        signal: AbortSignal.timeout(90_000),
      });
      const findings = parseReviewResponse(raw);
      validateReviewFindings(findings, allowedCodes, source);
      return findings;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function requestReview({ systemPrompt, userPrompt, prompts, selection, attempts = 3 }) {
  const requests = prompts ?? [{ systemPrompt, userPrompt }];
  const groups = await Promise.all(requests.map(prompt => requestReviewPass({
    ...prompt,
    selection,
    attempts,
  })));
  return mergeReviewFindings(groups);
}
