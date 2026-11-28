import { randomUUID } from 'node:crypto';

/* The MinerU precision API (https://mineru.net/apiManage/docs) and compatible third-party endpoints: convert one PDF
   piece with the learner's own Key and optional custom baseUrl. Every number fixed by the API lives in MINERU.
   Local-file flow: POST /file-urls/batch -> HTTP PUT of the raw bytes to the returned address (pre-signed: no token,
   no JSON content type) -> poll GET /extract-results/batch/{id} -> download full_zip_url.
   The Key is only ever put in the Authorization header of requests to baseUrl; it appears in no message, error or log. */

export const MINERU = Object.freeze({
  baseUrl: 'https://mineru.net/api/v4',
  docsUrl: 'https://mineru.net/apiManage/docs',
  /** 'vlm' is MinerU's own vision-language model; 'pipeline' is the older one. */
  modelVersion: 'vlm',
  language: 'ch',
  enableFormula: true,
  enableTable: true,
  isOcr: true,
  /** The API's hard limits per file (-60005 over 200 MB, -60006 over 200 pages). The chunker (lib/pdf-chunker.js) reads them and keeps a margin below the bytes. */
  maxPages: 200,
  maxBytes: 200 * 1024 * 1024,
  /** Pages per account per day parsed at top priority; past them the service still parses, at a lower priority (slower, not refused). */
  dailyPriorityPages: 1000,
  /** Tokens are created on the API management page of mineru.net and are valid this long. */
  tokenValidityDays: 90,
  /** Polling: the documented limit is 1000 result requests a minute; a few seconds between polls is far below it. */
  pollMs: 4000,
  pollMaxMs: 30000,
  /** A request is given this long before it counts as a network failure (uploads and downloads of large files get more). */
  requestTimeoutMs: 60_000,
  transferTimeoutMs: 30 * 60_000,
});

export class MineruError extends Error {
  constructor(code, message, { retryable = false, retryAfterMs, apiCode, httpStatus } = {}) {
    super(message);
    this.name = 'MineruError'; this.code = code; this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (apiCode !== undefined) this.apiCode = apiCode;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

/** The official limits as the panel shows them (Settings, the import plan): one object, read from MINERU. */
export const cloudLimits = () => ({ maxPages: MINERU.maxPages, maxBytes: MINERU.maxBytes, maxMegabytes: MINERU.maxBytes / (1024 * 1024),
  dailyPriorityPages: MINERU.dailyPriorityPages, tokenValidityDays: MINERU.tokenValidityDays, docsUrl: MINERU.docsUrl });

/* The numbers in these sentences come from MINERU; each sentence has its English form in lib/application-messages-en.js (keyed by the
   sentence as built here, so a changed limit fails tests/mineru-messages.test.mjs until both are updated). */
export const MINERU_MESSAGES = {
  'invalid-base-url': '云端接口地址格式不对：请填写以 http:// 或 https:// 开头的完整地址（留空则使用 MinerU 官方地址）。',
  'invalid-token': 'MinerU 令牌无效：请到「设置 › PDF 转换（MinerU）」检查接口地址并重新粘贴有效的密钥。',
  expired: `MinerU 令牌已过期（令牌有效期 ${MINERU.tokenValidityDays} 天）：请到 MinerU 官网的 API 管理页重新创建令牌，再到「设置 › PDF 转换（MinerU）」粘贴。`,
  'too-large': `这一段超过 MinerU 单个文件 ${MINERU.maxBytes / (1024 * 1024)} MB 的上限。`,
  'too-many-pages': `这一段超过 MinerU 单个文件 ${MINERU.maxPages} 页的上限。`,
  'task-not-found': 'MinerU 找不到这个解析任务（可能已过期），需要重新上传这一段。',
  'conversion-failed': 'MinerU 没能转换这一段文件（可能是文件受保护或内容异常）。',
  'rate-limited': 'MinerU 请求太频繁，请稍后；任务会自动等一会儿再继续。',
  unavailable: 'MinerU 服务暂时不可用，请稍后再试。',
  network: '连不上 MinerU：请检查网络或接口地址后重试（已完成的部分会保留）。',
  'bad-response': 'MinerU 返回的内容无法识别，请稍后再试。',
  'upload-failed': 'MinerU 没有收下上传的文件，请稍后再试。',
  'download-failed': '没能下载 MinerU 的解析结果，请稍后再试。',
};
const RETRYABLE = new Set(['conversion-failed', 'rate-limited', 'unavailable', 'network', 'bad-response', 'upload-failed', 'download-failed', 'task-not-found']);
const API_CODES = { A0202: 'invalid-token', A0211: 'expired', '-60005': 'too-large', '-60006': 'too-many-pages', '-60012': 'task-not-found', '-60015': 'conversion-failed' };
const clip = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const redact = (value, secret) => (secret ? String(value ?? '').split(secret).join('[redacted]') : String(value ?? ''));

/**
 * Validate and normalize a custom cloud base URL. Empty / blank returns '' (meaning use MINERU.baseUrl).
 * Accepts only http:// or https:// without embedded credentials, query strings or fragments; strips trailing slashes.
 */
export function normalizeBaseUrl(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new MineruError('invalid-base-url', MINERU_MESSAGES['invalid-base-url']);
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 500 || /[\u0000-\u001f\s]/.test(trimmed)) throw new MineruError('invalid-base-url', MINERU_MESSAGES['invalid-base-url']);
  let parsed;
  try { parsed = new URL(trimmed); } catch { throw new MineruError('invalid-base-url', MINERU_MESSAGES['invalid-base-url']); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new MineruError('invalid-base-url', MINERU_MESSAGES['invalid-base-url']);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new MineruError('invalid-base-url', MINERU_MESSAGES['invalid-base-url']);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

/** Display host for the configured endpoint (e.g. "mineru.net" or "parser.example.com:8443"); never leaks paths or keys. */
export function endpointHost(baseUrl) {
  try { return new URL(baseUrl ? normalizeBaseUrl(baseUrl) : MINERU.baseUrl).host; }
  catch { return new URL(MINERU.baseUrl).host; }
}

/**
 * A failure report as a MineruError. `code` and `msg` are the service's JSON fields, `httpStatus` the HTTP status
 * (`retryAfter` the Retry-After header, in seconds). Unknown service codes keep the service's own words (secret redacted).
 */
export function mapMineruFailure({ code, msg, httpStatus, retryAfter, secret } = {}) {
  let kind = Object.hasOwn(API_CODES, String(code)) ? API_CODES[String(code)] : undefined;
  if (!kind && (httpStatus === 401 || httpStatus === 403)) kind = 'invalid-token';
  if (!kind && httpStatus === 429) kind = 'rate-limited';
  if (!kind && httpStatus >= 500) kind = 'unavailable';
  const extra = { ...(code !== undefined ? { apiCode: code } : {}), ...(httpStatus ? { httpStatus } : {}) };
  if (!kind) return new MineruError('unexpected', `MinerU 返回了意料之外的结果（${clip(redact(msg, secret)) || `HTTP ${httpStatus ?? '?'}`}）。请稍后再试。`, { ...extra, retryable: false });
  const seconds = Number(retryAfter);
  return new MineruError(kind, MINERU_MESSAGES[kind], { ...extra, retryable: RETRYABLE.has(kind),
    ...(kind === 'rate-limited' && Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: Math.round(seconds * 1000) } : {}) });
}

const STATES = { 'waiting-file': 'waiting', waiting: 'waiting', pending: 'pending', running: 'running', converting: 'running', done: 'done', failed: 'failed' };

/**
 * A client for one token + optional baseUrl. `fetch` is injectable (tests), `baseUrl` too (defaults to MINERU.baseUrl when blank).
 * Every method takes an optional `signal`; an aborted signal rejects with its own reason, so a cancelled job stops at the request in flight.
 */
export function createMineruClient({ token, fetch = globalThis.fetch, baseUrl = MINERU.baseUrl } = {}) {
  const base = normalizeBaseUrl(baseUrl) || MINERU.baseUrl;
  const secret = String(token ?? '');
  const authorization = `Bearer ${secret}`;

  async function send(url, init, { signal, timeoutMs = MINERU.requestTimeoutMs } = {}) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try { return await fetch(url, { ...init, signal: combined }); }
    catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new MineruError('network', MINERU_MESSAGES.network, { retryable: true });
    }
  }

  async function call(path, { method = 'GET', body, signal } = {}) {
    const response = await send(`${base}${path}`, { method, headers: { Authorization: authorization, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, { signal });
    const retryAfter = response.headers?.get?.('retry-after') ?? undefined;
    let text = '';
    try { text = await response.text(); } catch { throw new MineruError('network', MINERU_MESSAGES.network, { retryable: true }); }
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const known = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    if (response.status === 429 || response.status === 401 || response.status === 403 || response.status >= 500)
      throw mapMineruFailure({ ...(known ? { code: parsed.code, msg: parsed.msg } : {}), httpStatus: response.status, retryAfter, secret });
    if (!known) throw new MineruError('bad-response', MINERU_MESSAGES['bad-response'], { retryable: true, httpStatus: response.status });
    if (!response.ok || !(Number(parsed.code) === 0 && parsed.code !== '')) throw mapMineruFailure({ code: parsed.code, msg: parsed.msg, httpStatus: response.status, secret });
    return parsed.data ?? {};
  }

  return {
    baseUrl: base,
    /**
     * One harmless authenticated request: the status of a task that does not exist. A valid token gets the service's
     * "task not found"; an invalid or expired one gets its own answer. Resolves { ok: true }, otherwise rejects with a MineruError.
     */
    async check({ signal } = {}) {
      try { await call(`/extract-results/batch/${randomUUID()}`, { signal }); return { ok: true }; }
      catch (error) {
        if (error instanceof MineruError && ['task-not-found', 'unexpected', 'conversion-failed', 'too-large', 'too-many-pages'].includes(error.code)) return { ok: true };
        throw error;
      }
    },

    /** Ask for upload addresses. files: [{ name, dataId, isOcr?, pageRanges? }]. Resolves { batchId, urls } (one address per file, in order). */
    async requestUploads(files, { language = MINERU.language, modelVersion = MINERU.modelVersion, signal } = {}) {
      const data = await call('/file-urls/batch', { method: 'POST', signal, body: {
        files: files.map(file => ({ name: file.name, data_id: file.dataId, is_ocr: file.isOcr ?? MINERU.isOcr, ...(file.pageRanges ? { page_ranges: file.pageRanges } : {}) })),
        model_version: modelVersion, enable_formula: MINERU.enableFormula, enable_table: MINERU.enableTable, language } });
      if (typeof data.batch_id !== 'string' || !Array.isArray(data.file_urls) || data.file_urls.length !== files.length)
        throw new MineruError('bad-response', MINERU_MESSAGES['bad-response'], { retryable: true });
      return { batchId: data.batch_id, urls: data.file_urls.map(String) };
    },

    /** PUT the raw bytes to a pre-signed address: no token, no content type. */
    async upload(url, bytes, { signal } = {}) {
      const response = await send(url, { method: 'PUT', body: bytes }, { signal, timeoutMs: MINERU.transferTimeoutMs });
      if (!response.ok) throw new MineruError('upload-failed', MINERU_MESSAGES['upload-failed'], { retryable: true, httpStatus: response.status });
    },

    /** The state of every file of a batch: [{ fileName, dataId, state: waiting | pending | running | done | failed, errMsg?, zipUrl?, extractedPages?, totalPages? }]. */
    async status(batchId, { signal } = {}) {
      const data = await call(`/extract-results/batch/${encodeURIComponent(batchId)}`, { signal });
      if (!Array.isArray(data.extract_result)) throw new MineruError('bad-response', MINERU_MESSAGES['bad-response'], { retryable: true });
      return data.extract_result.map(item => {
        const progress = item.extract_progress && typeof item.extract_progress === 'object' ? item.extract_progress : {};
        const number = value => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : undefined);
        return { fileName: String(item.file_name ?? ''), dataId: String(item.data_id ?? ''), state: STATES[item.state] ?? 'pending',
          ...(item.err_msg ? { errMsg: clip(redact(item.err_msg, secret)) } : {}), ...(item.full_zip_url ? { zipUrl: String(item.full_zip_url) } : {}),
          ...(number(progress.extracted_pages) !== undefined ? { extractedPages: number(progress.extracted_pages) } : {}),
          ...(number(progress.total_pages) !== undefined ? { totalPages: number(progress.total_pages) } : {}) };
      });
    },

    /** The result archive (full_zip_url is pre-signed too). */
    async download(url, { signal, maxBytes = 1024 * 1024 * 1024 } = {}) {
      const response = await send(url, { method: 'GET' }, { signal, timeoutMs: MINERU.transferTimeoutMs });
      if (!response.ok) throw new MineruError('download-failed', MINERU_MESSAGES['download-failed'], { retryable: true, httpStatus: response.status });
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) throw new MineruError('download-failed', MINERU_MESSAGES['download-failed'], { retryable: false });
      try { return Buffer.from(await response.arrayBuffer()); }
      catch (error) { if (signal?.aborted) throw signal.reason ?? error; throw new MineruError('network', MINERU_MESSAGES.network, { retryable: true }); }
    },
  };
}
