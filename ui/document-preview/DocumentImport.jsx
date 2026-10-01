import React, { useState } from 'react';
import { ui } from '../i18n.js';

export default function DocumentImport({ busy, act, courses = [], onImported }) {
  const [reading, setReading] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(null);
  async function importFile(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setReading(true); setError(''); setResult(null);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error(ui('资料最大 8 MB，请按章节拆分。'));
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error(ui('读取文件失败，请重试。'))); reader.readAsDataURL(file);
      });
      await act('materials.document.import', { dataBase64, filename: file.name, courses }, value => {
        setResult(value); onImported?.(value.sourceIds || value.document?.sourceIds || []);
      }, { rethrow: true });
    } catch (e) { setError(e.message); }
    finally { setReading(false); }
  }
  return <div className="pdf-import">
    <strong>{ui('导入资料原文件')}</strong>
    <p className="muted">{ui('支持 PDF、Markdown、HTML 和 TXT。保留原文件与可引用文字，后续可选中提问或补题。')}</p>
    <label>{reading ? ui('正在保存与提取…') : ui('选择文件（最多 8 MB）')}<input type="file" accept=".pdf,.md,.markdown,.html,.htm,.txt" disabled={busy || reading} onChange={importFile} /></label>
    {error && <p className="warning" role="alert">{error}</p>}
    {result && <p role="status">{ui('资料原文件已保存。可在资料列表中打开并选择段落学习。')}</p>}
  </div>;
}
