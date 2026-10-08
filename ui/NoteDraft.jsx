import React from 'react';
import { ui } from './i18n.js';
import { Button } from './components/index.js';
import { TokenEstimate } from './TokenUsage.jsx';
import ModelSetupGate from './ModelSetupGate.jsx';

/**
 * The AI draft of a note (note.generate), the note's main button. What it makes is a public article, not a study note: the courses, slides and the learner are left out
 * of it, and a draft that still has "课件", "讲义", "PPT", "本课程" or a file path in it is refused only after the model has been paid (lib/blog-generation.js), so all of
 * that is said before the click, with what the call is expected to use. `model` is the readiness ({ ready, reason, label }); without it the gate says what to do.
 * running: a draft is being written; disabled: the note is busy with something else.
 */
export default function NoteDraft({ note, model, running = false, disabled = false, onStart, onModelSettings }) {
  return (
    <section className="note-draft" aria-label={ui('AI 起草')} data-running={running || undefined}>
      <div className="note-draft__row">
        <Button variant="primary" icon="sparkle" disabled={disabled || running || !model?.ready} onClick={onStart}>{ui('AI 起草解析')}</Button>
        {model?.ready && !running && <TokenEstimate request={{ feature: 'note', id: note.id }} />}
      </div>
      {running
        ? <p role="status">{ui('AI 正在起草这篇笔记，你可以继续学习；完成后会进信箱。')}</p>
        : <p className="muted note-draft__about">{ui('AI 会按这几道题写一篇可以公开发布的通用文章：不写课程、课件或个人信息，也不照抄原题。文中出现「课件」「讲义」「PPT」「本课程」或文件路径这类字样时，这篇草稿会被拒绝，已用的用量不退。')}</p>}
      {!model?.ready && <ModelSetupGate variant="inline" feature="note" model={model} onOpenSettings={onModelSettings} />}
    </section>
  );
}
