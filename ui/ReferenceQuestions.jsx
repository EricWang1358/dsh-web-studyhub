import React from 'react';
import { ui, uiFormat } from './i18n.js';
import SourcePicker from './SourcePicker.jsx';
import { Button, Disclosure } from './components/index.js';
import { referenceSelection } from './reference-questions.js';

export default function ReferenceQuestions({ sources, selected = [], evidenceIds = [], onChange, onImport, busy = false, courses }) {
  const state = referenceSelection(sources, selected, evidenceIds);
  const evidence = new Set(evidenceIds);
  return <Disclosure summary={ui('参考样题（可选）')} defaultOpen={selected.length > 0}>
    <p className="muted">{ui('上传自己教材中的优质题目，或选择已导入的样题。只参考题型、难度和表达方式，要求生成原创题；事实和答案仍以教材依据为准。')}</p>
    <p className="muted small">{ui('开始生成后，所选样题会随教材发送给已配置的模型，会增加输入 Token。')}</p>
    <p className="muted small">{ui('建议包含题干、答案与解析。最多选择 5 页或文本片段，总计 12,000 字符；整本题集请先缩小到少量样题。')}</p>
    <SourcePicker sources={sources.filter(source => !evidence.has(source.id))} selected={selected} onChange={onChange}
      courses={courses} disabled={busy} maxHeight={240} aria-label={ui('参考样题资料')} />
    <Button variant="link" icon="upload" disabled={busy} onClick={onImport}>{ui('上传参考样题')}</Button>
    {selected.length > 0 && <Button variant="link" disabled={busy} onClick={() => onChange([])}>{ui('清空样题选择')}</Button>}
    <small className="muted">{ui('TXT / Markdown 可直接上传；PDF / Word 沿用资料解析。图片请先转成文本。导入后保存在资料库，可再次选择。')}</small>
    {selected.length > 0 && <p role="status" className="muted">{uiFormat('已选择 {0} 个样题片段 · {1} 字符', [selected.length, state.chars])}</p>}
    {state.reason && <p role="alert" className="warning">{ui(state.reason === 'size'
      ? '参考样题超过 5 个片段或 12,000 字符。请取消部分选择，再开始生成。'
      : state.reason === 'overlap' ? '同一资料不能同时作为教材依据和参考样题。请取消其中一处选择。'
        : '部分参考样题已被删除。请清空样题选择后重新选择。')}</p>}
  </Disclosure>;
}
