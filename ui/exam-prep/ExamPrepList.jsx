import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatDateTime, joinMeta } from '../format.js';
import { Badge, Button, EmptyState, PageHeader, ProgressBar } from '../components/index.js';
import PageScope from '../PageScope.jsx';
import Explain from './Explain.jsx';
import { basisLine, countsLine } from './words.js';

/* 备考补习, the list view: one row per 考点清单 of the current course. A row opens the list; the basis it rests on and its counts are
   on the row, because they decide whether a learner can trust it. A build that is running shows in the place of the time, never as an extra line. */

const buildWords = build => build.total ? uiFormat('正在生成 {0}/{1}', [Math.min(build.done, build.total), build.total]) : ui('正在生成');

function BuildState({ build, onOpenTask }) {
  return (
    <span className="exam-prep-row__state">
      <Explain k="building" focusable><Badge size="sm" tone="accent" dot>{buildWords(build)}</Badge></Explain>
      <Button variant="link" size="sm" onClick={() => onOpenTask(build.taskId)}>{ui('在任务里查看')}</Button>
    </span>
  );
}

function ListRow({ row, onOpen, onOpenTask }) {
  const meta = joinMeta([row.scope, row.course && row.course !== row.scope ? row.course : '']);
  return (
    <li className="exam-prep-row" data-list={row.id}>
      <button type="button" className="exam-prep-row__open" data-usage="examprep.open" onClick={() => onOpen(row.id)}>
        <span className="exam-prep-row__title">{row.title}</span>
        {meta && <span className="exam-prep-row__meta">{meta}</span>}
      </button>
      <Explain k="basis" focusable className="exam-prep-row__basis">{basisLine(row.source.blueprint)}</Explain>
      <span className="exam-prep-row__counts">{countsLine(row.counts)}</span>
      {row.build ? <BuildState build={row.build} onOpenTask={onOpenTask} />
        : <span className="exam-prep-row__time">{[row.updatedAt ? formatDateTime(row.updatedAt, 'short') : '', row.olderVersions ? uiFormat('取代了 {0} 个旧版本', [row.olderVersions]) : ''].filter(Boolean).join(' · ')}</span>}
    </li>
  );
}

/** A build with no list of its own yet (a new list being made): a row of the same shape, with its progress. */
function BuildingRow({ build, onOpenTask }) {
  return (
    <li className="exam-prep-row is-building" data-build={build.jobId}>
      <span className="exam-prep-row__open is-static">
        <span className="exam-prep-row__title">{build.title}</span>
        <span className="exam-prep-row__meta">{build.stage || ui('正在后台生成')}</span>
      </span>
      <ProgressBar value={build.total ? Math.min(build.done, build.total) : 0} max={build.total || 1} label={ui('生成进度')} className="exam-prep-row__bar" />
      <BuildState build={build} onOpenTask={onOpenTask} />
    </li>
  );
}

function Empty({ onCreate, otherCount, scoped }) {
  return (
    <EmptyState icon="file" title={scoped ? ui('这门课还没有考点清单') : ui('还没有考点清单')}
      description={ui('备考补习把课件和样卷整理成一份考点清单：哪些必学，哪些是补充，每个考点出自课件的哪一页。')}
      primary={{ label: ui('新建考点清单'), icon: 'plus', onClick: onCreate }}>
      <ul className="exam-prep-inputs">
        <li><strong>{ui('课件')}</strong>{ui('：必选。考点从这里列出来。')}</li>
        <li><strong>{ui('样卷')}</strong>{ui('：可选。由它定出哪些考点必学；不选时所有考点都是补充。')}</li>
        <li><strong>{ui('大纲、推荐教材')}</strong>{ui('：可选。大纲和课件一样用来列考点；推荐教材只记一条备注。')}</li>
      </ul>
      {otherCount > 0 && <p className="exam-prep-empty__other">{uiFormat('其它课程里有 {0} 份考点清单，可在上面切换课程范围查看。', [otherCount])}</p>}
    </EmptyState>
  );
}

export default function ExamPrepList({ data, scope, onScope, rows, builds, otherCount, onOpen, onCreate, onOpenTask }) {
  const titles = new Set(rows.map(row => row.title));
  const fresh = builds.filter(build => build.live && !titles.has(build.title));
  const failed = builds.filter(build => build.failed).slice(0, 2);
  return (
    <section className="page exam-prep" data-usage-area="examprep">
      <PageHeader title={ui('备考补习')} description={ui('把课件和样卷整理成考点清单：哪些必学，哪些是补充，每个考点出自哪一页。')}
        actions={<Button variant="primary" icon="plus" data-usage="examprep.create" onClick={onCreate}>{ui('新建考点清单')}</Button>}
        scope={<PageScope courses={data.focus?.courses} value={scope} onChange={onScope} />} />
      {failed.map(build => (
        <p key={build.jobId} className="exam-prep-failed" role="status">
          {uiFormat('「{0}」没有生成完。', [build.title])}{' '}
          <Button variant="link" size="sm" onClick={() => onOpenTask(build.taskId)}>{ui('在任务里查看原因')}</Button>
        </p>
      ))}
      {rows.length || fresh.length ? (
        <ul className="exam-prep-list">
          {fresh.map(build => <BuildingRow key={build.jobId} build={build} onOpenTask={onOpenTask} />)}
          {rows.map(row => <ListRow key={row.id} row={row} onOpen={onOpen} onOpenTask={onOpenTask} />)}
        </ul>
      ) : <Empty onCreate={onCreate} otherCount={otherCount} scoped={scope !== '*'} />}
    </section>
  );
}
