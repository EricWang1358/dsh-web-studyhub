import { audioRequestMetadata, recordAudioUsage, rateHeaders, usageTokens } from './audio-dashboard.js';
import { longFetch } from './http.js';

/** Audio-specific projection into the existing ledger. The gateway owns Call
 * identity; this adapter knows providers, never Job lifecycle or retry policy. */
export function gatewayAudioTransport(gateway, fetch = longFetch, settings, meter = { recorded: 0, unrecorded: 0 }) {
  return (tier, cleanup = false) => (input, init = {}) => {
    const metadata = audioRequestMetadata(input, init, settings || {}), at = Date.now();
    return gateway.observe({ boundary: 'external-request', kind: metadata?.stage || 'provider-io', tier,
      model: metadata?.model, selectedEffort: metadata?.reasoning, modelRequest: !!metadata, cleanup,
      async recordUsage(event) { try { await recordAudioUsage(event); meter.recorded++; } catch (error) { meter.unrecorded++; throw error; } },
    }, async scopedSignal => {
      const signal = cleanup ? init.signal : init.signal ? AbortSignal.any([init.signal, scopedSignal]) : scopedSignal;
      let response, body = null, parseError;
      try { response = await fetch(input, { ...init, signal, awaitPhysicalClose: true }); }
      catch (error) {
        // Failed dispatch is still one physical attempt. Record it through the
        // same Call identity before propagating the original transport failure.
        return { value: { transportError: error }, status: 599,
          ...(metadata && settings ? { ledgerEvent: { ...metadata, type: 'request', at, status: 0, elapsedMs: Date.now() - at } } : {}) };
      }
      try { body = await response.json(); } catch (error) { parseError = error; }
      const raw = body?.usageMetadata || body?.usage;
      const tokens = raw ? usageTokens(body) : null;
      const valid = count => Number.isSafeInteger(count) && count >= 0;
      const tokenUsage = tokens && valid(raw.promptTokenCount ?? raw.prompt_tokens) &&
        valid(raw.candidatesTokenCount ?? raw.completion_tokens ?? raw.totalTokenCount)
        ? { uncachedInputTokens: Math.max(0, tokens.inputTokens - tokens.cachedInputTokens), outputTokens: tokens.outputTokens,
          cacheReadTokens: tokens.cachedInputTokens, cacheWriteTokens: 0 } : null;
      return { value: { status: response.status, ok: response.ok, headers: response.headers,
        json: async () => { if (parseError) throw parseError; return body; } }, status: response.status, tokenUsage,
        ...(metadata && settings ? { ledgerEvent: { ...metadata, type: 'request', at, status: response.status, elapsedMs: Date.now() - at,
          inputTokens: tokens?.inputTokens ?? null, outputTokens: tokens?.outputTokens ?? null,
          audioSeconds: response.ok ? Number(init.audioUsage?.seconds) || 0 : 0,
          quota: ['groq', 'siliconflow'].includes(tier) ? rateHeaders(response.headers, at) : null } } : {}) };
    }).then(value => { if (value?.transportError) throw value.transportError; return value; });
  };
}
