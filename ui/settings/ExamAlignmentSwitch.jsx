import React, { useCallback, useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Hint, Icon, Switch, Tooltip, useToast } from '../components/index.js';
import { formatList } from '../format.js';
import { alignmentReceipt, examDateText } from '../exam-alignment-words.js';
import { useStudy } from '../study-context.jsx';

/* 考前对齐 (#882): one switch inside 间隔复习 · FSRS-6, shown only when an active course has an exam date ahead. Next to it, before
   the learner flips it, what flipping it does to each of the next 14 days (course.examAlignment.preview: the backend runs the very
   pass the switch runs, on a copy). A library whose exam date was set before alignment existed is on but not aligned: it says how
   many questions wait and offers 现在对齐. Questions moved for an exam that is over (or removed) stay due until answered: their
   count and 恢复原来的日期 are shown even when the switch is not. Each press ends with a toast of what moved. */

/** 「11月12日 +3」: the days whose count would change, as the learner reads them. */
export function changeList(days = []) {
  return days.filter(day => day.after !== day.before)
    .map(day => `${examDateText(day.date, 'monthDay')} ${day.after > day.before ? '+' : '−'}${Math.abs(day.after - day.before)}`);
}

/** The line under the switch: what turning it to `target` (or aligning now) does, as an estimate. */
export function previewLine(preview, target) {
  const changes = changeList(target ? preview.on : preview.off);
  if (!changes.length) return target ? ui('打开后，未来 14 天每天的复习量不变。') : ui('关闭后，未来 14 天每天的复习量不变。');
  return uiFormat(target ? '打开后，未来 14 天每天的复习量（估计）：{0}。之后的作答也会按考试日安排，考前实际会再多一些。' : '关闭后，未来 14 天每天的复习量（估计）：{0}。', [changes.join(' · ')]);
}

const RULE = '有考试日的课，每次作答后下次复习不晚于考试日（考试当天 0 点起就会出现）；已经排到考试之后的题，按「现在对齐」或保存考试日期时分散提前到考试前的几天，最容易忘的先回来。只改复习日期，不改记忆估计和掌握程度。考试当天作答的题只能排到考试之后。考试日过后，新的作答照常安排；提前了还没作答的题仍然到期，直到作答，或在这里恢复原来的日期。';

/**
 * The switch, its preview and the two follow-ups, for a read `preview` (nothing when there is neither an exam ahead nor a date to give
 * back). onSet(enabled), onAlign() (现在对齐), onRestore() (恢复原来的日期); `working` names the press in flight ('switch' | 'align' | 'restore').
 */
export function ExamAlignmentView({ preview, working = null, onSet, onAlign, onRestore }) {
  const { busy } = useStudy();
  const showSwitch = !!preview?.courses?.length, restorable = Number(preview?.restorable) || 0;
  if (!showSwitch && !restorable) return null;
  const waiting = showSwitch && preview.enabled && preview.pending > 0;
  const exams = showSwitch ? formatList(preview.courses.map(course => `${course.name} ${examDateText(course.date)}`)) : '';
  return (
    <div className="sm2-exam-align" data-tour="settings-exam-alignment">
      {showSwitch && <Switch checked={preview.enabled} disabled={busy} onChange={enabled => onSet?.(enabled)}
        label={<>{ui('考前对齐')}{' '}<Tooltip layer content={ui(RULE)}>
          <span tabIndex={0} className="sm2-field-tip" aria-label={uiFormat('「{0}」是什么', [ui('考前对齐')])}><Icon name="info" size={16} /></span>
        </Tooltip></>}
        hint={uiFormat('考试日：{0}。复习不会排到考试之后。', [exams])} />}
      {showSwitch && (waiting
        ? <Hint>{uiFormat('还有 {0} 道题排在考试之后，现在对齐会把它们提前。', [preview.pending])}{' '}{previewLine(preview, true)}{' '}
            <Button variant="quiet" size="sm" busy={working === 'align'} lock={busy} onClick={() => onAlign?.()}>{ui('现在对齐')}</Button></Hint>
        : <Hint>{previewLine(preview, !preview.enabled)}</Hint>)}
      {restorable > 0 && <Hint>{uiFormat('{0} 道题是为已经过去或已删除的考试提前的，还没作答，仍按提前的日子到期。', [restorable])}{' '}
        <Button variant="quiet" size="sm" busy={working === 'restore'} lock={busy} onClick={() => onRestore?.()}>{ui('恢复原来的日期')}</Button></Hint>}
    </div>
  );
}

/** Reads the preview for the open library (again after each press), runs the press and says what moved. */
export function ExamAlignmentSwitch({ root }) {
  const { act, call } = useStudy();
  const toast = useToast();
  const [preview, setPreview] = useState(null), [working, setWorking] = useState(null);
  const load = useCallback(async () => {
    try { setPreview(await call('course.examAlignment.preview', {})); } catch { setPreview(null); }
  }, [call]);
  useEffect(() => { setPreview(null); void load(); }, [root, load]);
  const run = async (press, action, args) => {
    setWorking(press);
    try {
      await act(action, args, async result => {
        const moved = alignmentReceipt(result);
        if (moved) toast.success(moved); else toast.info(ui('没有需要移动的题'));
        await load();
      });
    } finally { setWorking(null); }
  };
  return <ExamAlignmentView preview={preview} working={working}
    onSet={enabled => run('switch', 'course.examAlignment.set', { enabled })}
    onAlign={() => run('align', 'course.examAlignment.set', { enabled: true })}
    onRestore={() => run('restore', 'course.examAlignment.restore', {})} />;
}

export default ExamAlignmentSwitch;
