import { randomUUID } from 'node:crypto';

/* The MinerU precision API (https://mineru.net/apiManage/docs), as far as StudyHub uses it: convert one PDF piece with
   the learner's own token. Every number the owner or the documentation fixes lives in MINERU, in one place.
   Local-file flow: POST /file-urls/batch -> HTTP PUT of the raw bytes to the returned address (pre-signed: no token,
   no JSON content type) -> poll GET /extract-results/batch/{id} -> download full_zip_url.
   The token is only ever put in the Authorization header of requests to MinerU; it appears in no message, error or log. */

export const MINERU = Object.freeze({
  baseUrl: 'https://mineru.net/api/v4',
  docsUrl: 'https://mineru.net/apiManage/docs',
  /** 'vlm' is MinerU's own vision-language model; 'pipeline' is the older one. */
  modelVersion: 'vlm',
  language: 'ch',
  enableFormula: true,
  enableTable: true,
  isOcr: true,
  /** The API's hard limits per file (-60005 over 200 MB, -60006 over 200 pages). The chunker keeps a margin below them. */
  maxPages: 200,
  maxBytes: 200 * 1024 * 1024,
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

export const MINERU_MESSAGES = {
  'invalid-token': 'MinerU 令牌无效：请到「设置 › MinerU 云端解析」重新粘贴一个有效的令牌。',
  expired: 'MinerU 令牌已过期：请到 mineru.net 重新创建一个令牌，再到「设置 › MinerU 云端解析」粘贴。',
  'too-large': '这一段超过 MinerU 单个文件 200 MB 的上限。',
  'too-many-pages': '这一段超过 MinerU 单个文件 200 页的上限。',
  'task-not-found': 'MinerU 找不到这个解析任务（可能已过期），需要重新上传这一段。',
  'conversion-failed': 'MinerU 没能转换这一段文件（可能是文件受保护或内容异常）。',
  'rate-limited': 'MinerU 请求太频繁，请稍后；任务会自动等一会儿再继续。',
  unavailable: 'MinerU 服务暂时不可用，请稍后再试。',
  network: '连不上 MinerU：请检查网络后重试（已完成的部分会保留）。',
  'bad-response': 'MinerU 返回的内容无法识别，请稍后再试。',
  'upload-failed': 'MinerU 没有收下上传的文件，请稍后再试。',
  'download-failed': '没能下载 MinerU 的解析结果，请稍后再试。',
};
const RETRYABLE = new Set(['conversion-failed', 'rate-limited', 'unavailable', 'network', 'bad-response', 'upload-failed', 'download-failed', 'task-not-found']);
const API_CODES = { A0202: 'invalid-token', A0211: 'expired', '-60005': 'too-large', '-60006': 'too-many-pages', '-60012': 'task-not-found', '-60015': 'conversion-failed' };
const clip = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * A failure report as a MineruError. `code` and `msg` are the service's JSON fields, `httpStatus` the HTTP status
 * (`retryAfter` the Retry-After header, in seconds). Unknown service codes keep the service's own words.
 */
export function mapMineruFailure({ code, msg, httpStatus, retryAfter } = {}) {
  let kind = Object.hasOwn(API_CODES, String(code)) ? API_CODES[String(code)] : undefined;
  if (!kind && (httpStatus === 401 || httpStatus === 403)) kind = 'invalid-token';
  if (!kind && httpStatus === 429) kind = 'rate-limited';
  if (!kind && httpStatus >= 500) kind = 'unavailable';
  const extra = { ...(code !== undefined ? { apiCode: code } : {}), ...(httpStatus ? { httpStatus } : {}) };
  if (!kind) return new MineruError('unexpected', `MinerU 返回了意料之外的结果（${clip(msg) || `HTTP ${httpStatus ?? '?'}`}）。请稍后再试。`, { ...extra, retryable: false });
  const seconds = Number(retryAfter);
  return new MineruError(kind, MINERU_MESSAGES[kind], { ...extra, retryable: RETRYABLE.has(kind),
    ...(kind === 'rate-limited' && Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: Math.round(seconds * 1000) } : {}) });
}

const STATES = { 'waiting-file': 'waiting', waiting: 'waiting', pending: 'pending', running: 'running', converting: 'running', done: 'done', failed: 'failed' };

/**
 * A client for one token. `fetch` is injectable (tests), `baseUrl` too. Every method takes an optional `signal`;
 * an aborted signal rejects with its own reason, so a cancelled job stops at the request in flight.
 */
export function createMineruClient({ token, fetch = globalThis.fetch, baseUrl = MINERU.baseUrl } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const authorization = `Bearer ${token}`;

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
      throw mapMineruFailure({ ...(known ? { code: parsed.code, msg: parsed.msg } : {}), httpStatus: response.status, retryAfter });
    if (!known) throw new MineruError('bad-response', MINERU_MESSAGES['bad-response'], { retryable: true, httpStatus: response.status });
    if (!response.ok || !(Number(parsed.code) === 0 && parsed.code !== '')) throw mapMineruFailure({ code: parsed.code, msg: parsed.msg, httpStatus: response.status });
    return parsed.data ?? {};
  }

  return {
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
          ...(item.err_msg ? { errMsg: clip(item.err_msg) } : {}), ...(item.full_zip_url ? { zipUrl: String(item.full_zip_url) } : {}),
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
