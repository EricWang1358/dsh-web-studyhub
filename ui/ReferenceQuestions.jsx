import React from 'react';
import { ui, uiFormat } from './i18n.js';
import SourcePicker from './SourcePicker.jsx';
import { Button, Disclosure, InlineMessage } from './components/index.js';
import { referenceSelection } from './reference-questions.js';
import { QUESTION_REFERENCE_LIMITS, QUESTION_REFERENCE_HARD_LIMITS, QUESTION_REFERENCE_FORMAT_DEFAULT } from '../lib/question-references.js';
import { formatNumber } from './format.js';

const FORMATS = ['flexible', 'balanced', 'strict'];
const FORMAT_LABELS = ['灵活参考', '均衡贴合', '紧密遵循'];

export default function ReferenceQuestions({ sources, selected = [], evidenceIds = [], limits, onLimitsChange,
  format = QUESTION_REFERENCE_FORMAT_DEFAULT, onFormatChange, onChange, onImport, busy = false, courses }) {
  const state = referenceSelection(sources, selected, evidenceIds, limits, format);
  const formatIndex = FORMATS.indexOf(format);
  const values = { ...QUESTION_REFERENCE_LIMITS, ...limits };
  const updateLimit = (key, value) => onLimitsChange?.({ ...values, [key]: value === '' ? '' : Number(value) });
  const evidence = new Set(evidenceIds);
  return <Disclosure summary={ui('参考样题（可选）')} defaultOpen={selected.length > 0}>
    <p className="muted">{ui('上传自己教材中的优质题目，或选择已导入的样题。只参考题型、难度和表达方式，要求生成原创题；事实和答案仍以教材依据为准。')}</p>
    <p className="muted small">{ui('参考样题的组织方式，但按各知识点调整情景与措辞，避免机械套用重复模板。格式一致不等于表述雷同；教材依据与易读性优先。')}</p>
    <label>{ui('样题格式贴合度')}<input type="range" min="0" max="2" step="1" value={formatIndex < 0 ? 1 : formatIndex}
      aria-label={ui('样题格式贴合度')} aria-valuetext={ui(formatIndex < 0 ? '请选择有效的样题格式贴合度。' : FORMAT_LABELS[formatIndex])}
      disabled={busy} onChange={event => onFormatChange?.(FORMATS[Number(event.target.value)])} /></label>
    <div className="muted small">{FORMAT_LABELS.map((label, index) => <span key={label}>{index ? ' · ' : ''}{ui(label)}</span>)}</div>
    <p className="muted small">{ui('从灵活借鉴到紧密遵循题干结构、选项组织与解析方式。任何档位都优先保证教材依据、答案准确与可读性，并避免重复套话。')}</p>
    <p className="muted small">{ui('开始生成后，所选样题会随教材发送给已配置的模型，会增加输入 Token。')}</p>
    <p className="muted small">{ui('建议包含题干、答案与解析。按资料页或文本片段计数，不是按单道题计数；整本题集请先缩小到少量样题。')}</p>
    <div className="two-col" role="group" aria-label={ui('参考样题用量上限')}>
      <label>{ui('最多样题片段')}<input type="number" min="1" max={QUESTION_REFERENCE_HARD_LIMITS.sources} step="1" required
        value={values.sources} disabled={busy} onChange={event => updateLimit('sources', event.target.value)} /></label>
      <label>{ui('最多样题字符')}<input type="number" min="1" max={QUESTION_REFERENCE_HARD_LIMITS.chars} step="1" required
        value={values.chars} disabled={busy} onChange={event => updateLimit('chars', event.target.value)} /></label>
    </div>
    <p className="muted small">{uiFormat('默认 {0} 个片段 / {1} 字符；可调整，最高 {2} 个片段 / {3} 字符。',
      [QUESTION_REFERENCE_LIMITS.sources, formatNumber(QUESTION_REFERENCE_LIMITS.chars), QUESTION_REFERENCE_HARD_LIMITS.sources, formatNumber(QUESTION_REFERENCE_HARD_LIMITS.chars)])}</p>
    <p className="muted small">{ui('提高上限本身不增加用量；实际选入的文字才会增加输入 Token。更多样题可提供不同表达，也可能带来风格冲突，增加费用与等待时间；不会增加生成题数或保证通过率。沿用现有生成与审阅步骤，不增加模型调用步骤。')}</p>
    <SourcePicker sources={sources.filter(source => !evidence.has(source.id))} selected={selected} onChange={onChange}
      courses={courses} disabled={busy} maxHeight={240} aria-label={ui('参考样题资料')} />
    <Button variant="link" icon="upload" disabled={busy} onClick={onImport}>{ui('上传参考样题')}</Button>
    {selected.length > 0 && <Button variant="link" disabled={busy} onClick={() => onChange([])}>{ui('清空样题选择')}</Button>}
    <small className="muted">{ui('TXT / Markdown 可直接上传；PDF / Word 沿用资料解析。图片请先转成文本。导入后保存在资料库，可再次选择。')}</small>
    <p role="status" className="muted">{uiFormat('已选择 {0} 个样题片段 · {1} 字符', [state.ids.length, state.chars])}</p>
    {state.reason && <InlineMessage tone="error">{state.reason === 'limits'
      ? uiFormat('请填写正整数上限：片段为 1–{0}，字符为 1–{1}。', [QUESTION_REFERENCE_HARD_LIMITS.sources, formatNumber(QUESTION_REFERENCE_HARD_LIMITS.chars)])
      : ui(state.reason === 'format' ? '请选择有效的样题格式贴合度。' : state.reason === 'size'
      ? '参考样题超过当前设置的片段或字符上限。请取消部分选择，或在允许范围内提高上限；不会自动截断样题。'
      : state.reason === 'overlap' ? '同一资料不能同时作为教材依据和参考样题。请取消其中一处选择。'
        : '部分参考样题已被删除。请清空样题选择后重新选择。')}</InlineMessage>}
  </Disclosure>;
}
