import { RetrievalError } from './retrieval.js';
import { INDEX_TEXT } from './retrieval-messages.js';

const INDEX_BATCH_TOOL = 'mcp__studyhub__ingest_data_batch';
const indexBatchSize = pendingPages => Math.min(8, Math.ceil(pendingPages / 8));

const invalidReceipt = () => new RetrievalError('retrieval-index-batch', INDEX_TEXT.batchInvalid);

function batchReceipt(reply, items) {
  let data = reply?.structuredContent;
  if (!data) {
    try { data = JSON.parse(reply?.content?.find(item => item.type === 'text')?.text); }
    catch { throw invalidReceipt(); }
  }
  if (data?.maintenanceError) throw new RetrievalError('retrieval-index-batch', INDEX_TEXT.batchMaintenance(data.maintenanceError));
  const results = data?.results;
  if (!Array.isArray(results) || !results.length || results.length > items.length) throw invalidReceipt();
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    if (row?.source !== items[i].metadata.source || !['indexed', 'no-chunks', 'failed'].includes(row.status)) throw invalidReceipt();
    if (row.status === 'failed' && i !== results.length - 1) throw invalidReceipt();
  }
  if (results.length < items.length && results.at(-1).status !== 'failed' && !data.cancelled) throw invalidReceipt();
  return data;
}

/** Each yielded page has a confirmed receipt. A failed transport leaves the whole in-flight batch unconfirmed. */
export async function* ingestPages({ port, add, document, sourceKey, ingestTool, timeoutMs, signal, onItem }) {
  const batched = port.tools().some(tool => tool.name === INDEX_BATCH_TOOL);
  if (!batched) {
    for (const source of add) {
      signal?.throwIfAborted();
      onItem({ kind: 'ingest', id: source.id });
      let error;
      try {
        await port.call(ingestTool, { content: document(source), metadata: { source: sourceKey(source.id), format: 'markdown' } }, { signal, timeoutMs });
      } catch (failure) { error = failure; }
      yield { source, error };
    }
    return;
  }
  const size = indexBatchSize(add.length);
  let at = 0;
  while (at < add.length) {
    signal?.throwIfAborted();
    const batch = add.slice(at, at + size);
    const items = batch.map(source => ({ content: document(source), metadata: { source: sourceKey(source.id), format: 'markdown' } }));
    onItem({ kind: 'ingest', id: batch[0].id, ids: batch.map(source => source.id), unconfirmed: true });
    const reply = await port.call(INDEX_BATCH_TOOL, { items }, { signal, timeoutMs });
    const receipt = batchReceipt(reply, items);
    for (let i = 0; i < receipt.results.length; i++) {
      const row = receipt.results[i];
      const message = String(row.message || INDEX_TEXT.batchPageFailed).slice(0, 300);
      const error = row.status === 'indexed' ? undefined : new Error(row.status === 'no-chunks' ? `No chunks generated: ${message}` : message);
      onItem({ kind: 'ingest', id: batch[i].id, ids: batch.slice(i, receipt.results.length).map(source => source.id) });
      yield { source: batch[i], error, batchEnd: i === receipt.results.length - 1 };
    }
    at += receipt.results.length;
    if (receipt.cancelled) { signal?.throwIfAborted(); throw invalidReceipt(); }
  }
}
