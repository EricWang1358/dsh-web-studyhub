import React, { useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { FileDrop } from '../components/index.js';
import { DOCUMENT_EXTENSIONS, MAX_DOCUMENT_BYTES, runImport } from '../ImportHub.jsx';
import { sourceFormatLabel } from '../SourcePicker.jsx';

/* Original documents only (PDF, Markdown, HTML, TXT), several at once, each
   with its own status. The add-material dialog uses ImportHub; this compact
   entry is for places that only take documents. onImported(sourceIds) gets the
   ids of everything saved in a batch. Uses `call` when given (no global busy
   flag, per-file errors), otherwise App's `act` with rethrow. */
export default function DocumentImport({ busy, act, call, courses = [], onImported }) {
  const [items, setItems] = useState([]), [running, setRunning] = useState(false);
  const next = useRef(0);
  const send = call || (async (action, args) => {
    const value = await act(action, args, undefined, { rethrow: true });
    if (value === undefined) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
    return value;
  });
  async function importFiles(files) {
    if (!files.length || running) return;
    const batch = files.map(file => ({ id: `doc-${++next.current}`, name: file.name, status: 'pending' }));
    setItems(current => [...current.filter(item => item.status === 'done'), ...batch]);
    setRunning(true);
    const results = await runImport(files, { call: send, courses,
      onUpdate: (index, patch) => setItems(current => current.map(item => item.id === batch[index].id ? { ...item, ...patch } : item)) });
    setRunning(false);
    const ids = results.flatMap(result => result.status === 'done' ? result.result.sourceIds : []);
    if (ids.length) onImported?.(ids);
  }
  const shown = items.map(item => ({ id: item.id, name: item.name, status: item.status,
    detail: item.status === 'error' ? item.error : item.status === 'done' ? sourceFormatLabel({ format: item.result.format, sourceIds: item.result.sourceIds })
      : item.status === 'working' ? ui('正在保存并提取文字…') : undefined }));
  return <div className="pdf-import document-import">
    <strong>{ui('导入资料原文件')}</strong>
    <p className="muted">{ui('支持 PDF、Markdown、HTML 和 TXT。保留原文件与可引用文字，后续可选中提问或补题。')}</p>
    <FileDrop compact multiple accept={DOCUMENT_EXTENSIONS} maxBytes={MAX_DOCUMENT_BYTES} busy={running} disabled={busy && !running}
      label={ui('把讲义或笔记拖到这里，可以一次放多个')} buttonLabel={ui('选择文件')} items={shown} onFiles={accepted => void importFiles(accepted)} />
  </div>;
}
