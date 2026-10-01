import { ui } from "./i18n.js";
import React, { useState } from "react";
import CourseField from './CourseField.jsx';
import { SegmentedControl } from './components/index.js';

const KINDS = [
  ["auto", "自动识别", "有选项保持单选/多选，没有选项做成问答闪卡"],
  ["flashcard", "闪卡", "一律做成问答闪卡"],
  ["quiz", "单选 MQ", "一律做成单选，没有选项的补干扰项"],
  ["multi", "多选", "一律做成多选"],
  ["open", "开放问答", "需要论述的题，附评分标准"],
];
const MISTAKES = [
  ["auto", "按我标注的", "标了自己选错的才记为错题"],
  ["all", "全部当错题", "这批都是错题记录，全部优先复习"],
  ["none", "都不算错题", "只是收集题目"],
];

/** Setup for recording questions straight from the conversation. */
export default function Ingest({ data, busy, start }) {
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
                placeholder={ui("例如：SWE5006 Canvas 错题")}
              />
            </label>
            <label>{ui("所在目录（可选）")}<input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder={ui("例如：SWE5006 / Module 3")}
              />
            </label>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>{ui("02 / 题型")}</legend>
        <SegmentedControl label={ui("02 / 题型")} value={kind} onChange={setKind}
          options={KINDS.map(([value, label, note]) => ({ value, label: ui(label), title: ui(note) }))} />
        <small className="sh-seg-note">{ui(KINDS.find(([id]) => id === kind)[2])}</small>
      </fieldset>
      <fieldset>
        <legend>{ui("03 / 错题怎么记")}</legend>
        <SegmentedControl label={ui("03 / 错题怎么记")} value={mistakes} onChange={setMistakes}
          options={MISTAKES.map(([value, label, note]) => ({ value, label: ui(label), title: ui(note) }))} />
        <small className="sh-seg-note">{ui(MISTAKES.find(([id]) => id === mistakes)[2])}{ui("。错题会记为「薄弱」，学习路径优先出。")}</small>
      </fieldset>
      {!data.modelReady && (
        <p className="warning">{ui("当前会话没有可用模型，录题需要模型整理题目。")}</p>
      )}
      <button className="primary wide" disabled={busy || !data.modelReady || (newDeck ? !title.trim() : !selectedDeck)}>{ui("开始录题 → 去对话里粘贴")}</button>
    </form>
  );
}
