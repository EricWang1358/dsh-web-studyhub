import { ui, uiFormat } from "./i18n.js";
import React, { useState } from "react";
import CourseField from './CourseField.jsx';
import { Button, SegmentedControl } from './components/index.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { modelReadiness } from './generation-status.js';
import { INGEST_KINDS, INGEST_MISTAKES } from './agent-prompts/ingest.js';

/** Setup for recording questions straight from the conversation. */
export default function Ingest({ data, busy, start, onOpenSettings }) {
  const decks = data.decks.filter(d => !d.archived && !d.systemKind);
  const currentCourse = data.focus?.course ?? '';
  const [target, setTarget] = useState(() => decks.find(d => (d.course ?? d.folder ?? '') === currentCourse)?.id || 'new'),
    [title, setTitle] = useState(""),
    [folder, setFolder] = useState(""),
    [course, setCourse] = useState(currentCourse),
    [kind, setKind] = useState("auto"),
    [mistakes, setMistakes] = useState("auto");
  const selectedDeck = decks.find(deck => deck.id === target);
  const newDeck = target === "new";
  return (
    <form
      className="ingest-setup"
      onSubmit={(e) => {
        e.preventDefault();
        start({
          ...(newDeck ? { deckTitle: title.trim(), folder, course } : { deckId: target }),
          kind,
          mistakes,
        });
      }}
    >
      <p className="muted">{ui("刷题软件、Canvas 错题记录、截图都可以直接贴进对话。开启后这段对话里贴的题会自动录入，不需要先整理成文档；贴的原文会作为这些题的资料保存。")}</p>
      <fieldset>
        <legend>{ui("01 / 放进哪个题组")}</legend>
        <label>{ui("题组")}<select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">{ui("＋ 新建题组")}</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {(d.course ?? d.folder) ? `${d.course ?? d.folder} › ` : ''}
                {d.title}
              </option>
            ))}
          </select>
        </label>
        {!newDeck && selectedDeck && <p className="muted">{ui('课程归属')} · {(selectedDeck.course ?? selectedDeck.folder) || ui('未分类')}</p>}
        {newDeck && <CourseField value={course} onChange={setCourse} courses={data.focus?.courses || []} />}
        {newDeck && (
          <div className="two-col">
            <label>{ui("题组名称")}<input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={ui("例如：数据结构 · 错题")}
              />
            </label>
            <label>{ui("所在目录（可选）")}<input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder={ui("例如：数据结构 / 第 3 章")}
              />
            </label>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>{ui("02 / 题型")}</legend>
        <SegmentedControl label={ui("02 / 题型")} value={kind} onChange={setKind}
          options={INGEST_KINDS.map(({ id, label, hint }) => ({ value: id, label: ui(label), title: ui(hint) }))} />
        <small className="sh-seg-note">{ui(INGEST_KINDS.find((item) => item.id === kind).hint)}</small>
      </fieldset>
      <fieldset>
        <legend>{ui("03 / 错题怎么记")}</legend>
        <SegmentedControl label={ui("03 / 错题怎么记")} value={mistakes} onChange={setMistakes}
          options={INGEST_MISTAKES.map(({ id, label, hint }) => ({ value: id, label: ui(label), title: ui(hint) }))} />
        <small className="sh-seg-note">{uiFormat("{0}。错题会记为「薄弱」，学习路径优先出。", [ui(INGEST_MISTAKES.find((item) => item.id === mistakes).hint)])}</small>
      </fieldset>
      <ModelSetupGate variant="inline" feature="ingest" model={modelReadiness(data)} onOpenSettings={onOpenSettings} />
      <Button type="submit" variant="primary" block busy={busy} disabled={!data.modelReady || (newDeck ? !title.trim() : !selectedDeck)}>{ui("开始录题 → 去对话里粘贴")}</Button>
    </form>
  );
}
