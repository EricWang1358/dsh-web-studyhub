import { randomUUID } from 'node:crypto';
import { RETRIEVAL_SERVICE, RetrievalError } from './retrieval.js';

/* The DSH side of the retrieval contract (WP28; host-specific, like lib/host.js).

   DSH's MCP client (@deepseek-ai/dsh-mcp-client) registers every tool of a
   configured MCP server on the shared tool registry as mcp__<server>__<tool>.
   A plugin can list them with `ctx.tools.schemas()` and run one with
   `ctx.tools.execute({ callId, name, arguments, signal })`, which resolves to
   { isError, value, content }; for an MCP tool `value` is { content: [...],
   structuredContent? } (DSH 0.2.0-rc.2, dsh-tools / dsh-mcp-client). Another
   plugin acts as a provider by registering the cordis service `studyRetrieval`
   with `retrieve(request)`; it is read with `ctx.get('studyRetrieval')`.

   The registry's global view is used: MCP servers configured in the profile are
   visible; a server mounted only inside one agent preset is not. */

const CALL_TIMEOUT_MS = 90_000;

/** A port { tools(), call(name, args, { signal }), service() } over a DSH context (or a stub of one). */
export function retrievalPort(ctx, { agent } = {}) {
  const read = name => { try { return ctx?.get?.(name); } catch { return undefined; } };
  const registry = () => { try { return read('tools') || ctx?.tools; } catch { return undefined; } };
  return {
    tools() { try { return registry()?.schemas?.(agent) ?? []; } catch { return []; } },
    service() { try { return read(RETRIEVAL_SERVICE) ?? ctx?.[RETRIEVAL_SERVICE]; } catch { return undefined; } },
    async call(name, args, { signal, timeoutMs } = {}) {
      const tools = registry();
      if (typeof tools?.execute !== 'function') throw new RetrievalError('retrieval-missing', '当前环境没有可调用的工具（DSH 的工具注册表不可用）。');
      const limit = AbortSignal.timeout(timeoutMs ?? CALL_TIMEOUT_MS);
      const result = await tools.execute({ callId: `study-retrieval-${randomUUID()}`, name, arguments: args,
        ...(agent ? { agent } : {}), signal: signal ? AbortSignal.any([signal, limit]) : limit });
      if (result?.isError) throw new Error(result.error?.message || String(result.content?.[0]?.text || '检索工具返回了错误'));
      return result?.value;
    },
  };
}
