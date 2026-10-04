import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Dialog, InlineMessage } from './components/index.js';
import { indexProgress, runInstall, runUninstall, startIndex } from './retrieval-extension-flow.js';
import css from './large-documents.css';

/* The one-click path to searching a large textbook (WP28b): install the search
   extension, then build the index of a course. No file is edited and no command is
   typed. Shown in Settings and on the 大教材建议 card; both pass the host's retrieval
   status (retrieval.status, with `extension` and `companion`). */

/* What each component of the search extension is, and what its install script does, so the
   approval is an informed one. A package not listed here still gets the general explanation. */
const COMPONENTS = {
  'onnxruntime-node': '运行检索模型的引擎（微软 ONNX Runtime），把每页文字变成可比较的向量。脚本按你的系统准备运行库，部分系统需要另外下载。',
  protobufjs: '读取检索模型文件格式（Protocol Buffers）的工具库。脚本只做版本检查。',
  sharp: '图片处理库：检索用的模型工具包（Transformers.js）附带依赖它，检索文字时用不到。脚本检查适合你系统的图片运行库是否就绪。',
};
const COMPONENT_UNKNOWN = '检索扩展依赖的组件；脚本用来准备适合你电脑的文件。';

/** Installed but not running: ask the learner to restart DSH, and meanwhile check quietly in case it comes up anyway. */
function StartupWait({ refresh }) {
  useEffect(() => {
    const poll = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(poll);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <p className="extension-panel__lead" role="status">{ui('检索扩展已安装。请手动重启 DSH 以应用。')}</p>;
}

/** Install (or update) the extension: the approval step, the busy state, the error. Shared by the panel and the update notice. */
function useExtensionInstall({ call, onStatus, initialApproval = null }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [approval, setApproval] = useState(initialApproval), [restart, setRestart] = useState(false), [done, setDone] = useState(false);
  async function install(approved) {
    setBusy(true); setError('');
    const result = await runInstall(call, approved);
    setBusy(false);
    if (result.phase === 'approval') { setApproval(result.pending); return; }
    setApproval(null);
    if (result.phase === 'error') { setError(result.message); return; }
    setRestart(result.restartRequired); setDone(true);
    if (result.status) onStatus?.(result.status);
  }
  return { busy, error, approval, restart, done, install, setApproval };
}

function ApprovalDialog({ approval, busy, install, close }) {
  if (!approval) return null;
  return <Dialog size="sm" title={ui('允许安装组件的脚本？')} onClose={() => { if (!busy) close(); }}
    description={ui('检索扩展依赖的这些组件，安装时要运行自带的脚本（用来取得适合你电脑的运行文件）。DSH 默认会拦下它们，需要你确认。')}
    footer={<>
      <Button variant="quiet" disabled={busy} onClick={close}>{ui('取消')}</Button>
      <Button variant="primary" busy={busy} onClick={() => install(approval)}>{ui('允许并继续')}</Button>
    </>}>
    <ul className="extension-panel__pending">{approval.map(name => <li key={name}><code>{name}</code>
      <small className="extension-panel__purpose">{ui(COMPONENTS[name] || COMPONENT_UNKNOWN)}</small></li>)}</ul>
    <p className="large-doc__note">{ui('这些都是常用的开源组件，脚本只在安装时运行一次。取消后不会安装检索扩展，其他功能不受影响。')}</p>
  </Dialog>;
}

/** An installed extension older than this StudyHub (DSH's update of StudyHub does not touch it): say so, and update it in one click.
 *  Stays mounted once the update finished, so the outcome (and whether DSH must restart) is not lost when the status refresh
 *  clears `outdated`: the parent keeps rendering it for any installed extension. */
export function ExtensionUpdateNotice({ call, status, onStatus }) {
  const flow = useExtensionInstall({ call, onStatus });
  const extension = status?.extension;
  if (!extension?.installed || (!extension.outdated && !flow.done)) return null;
  if (flow.done) return (
    <div className="extension-panel__update">
      <InlineMessage tone={flow.restart ? 'warning' : 'success'} boxed title={ui('检索扩展已更新')}>
        {flow.restart ? ui('这次更新要重启 DSH 之后才会生效。') : ui('已更新，无需重启。')}
      </InlineMessage>
    </div>
  );
  return (
    <div className="extension-panel__update">
      <InlineMessage tone="warning" boxed title={ui('检索扩展需要更新')}>{uiFormat('已安装的检索扩展是 {0}，比当前 StudyHub（{1}）旧，可能一直启动不了。更新后要重启 DSH。', [extension.version, extension.expected])}</InlineMessage>
      <div><Button variant="primary" icon="download" busy={flow.busy} disabled={flow.busy} onClick={() => flow.install()}>{flow.busy ? ui('正在更新…') : ui('更新检索扩展')}</Button></div>
      {flow.busy && <p className="large-doc__note" role="status">{ui('正在下载并安装检索扩展，通常几分钟。期间可以继续学习，不要关闭 DSH。')}</p>}
      {flow.error && <InlineMessage boxed title={ui('没能完成')}>{flow.error}</InlineMessage>}
      <ApprovalDialog approval={flow.approval} busy={flow.busy} install={flow.install} close={() => flow.setApproval(null)} />
    </div>
  );
}

const names = courses => (courses || []).map(course => (typeof course === 'string' ? course : course?.name)).filter(Boolean);
const FINISHED = new Set(['complete', 'failed', 'cancelled']);

function IndexBuilder({ call, courses, defaultCourse, onDone, initialPlan, initialRun }) {
  const list = names(courses);
  const [course, setCourse] = useState(defaultCourse && list.includes(defaultCourse) ? defaultCourse : '');
  const [plan, setPlan] = useState(initialPlan), [run, setRun] = useState(initialRun), [starting, setStarting] = useState(false), [problem, setProblem] = useState('');
  const selectId = useId();
  const running = run?.status === 'running';
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The plan for the chosen course, whenever it is not being built.
  useEffect(() => {
    if (running || typeof call !== 'function') return undefined;
    let live = true;
    Promise.resolve(call('retrieval.index.plan', { course })).then(value => { if (live && value) setPlan(value); }, () => {});
    return () => { live = false; };
  }, [course, running, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // A build already under way (the page was closed and opened again) is picked up; a running one is followed.
  useEffect(() => {
    if (typeof call !== 'function') return undefined;
    let live = true, timer;
    const poll = async () => {
      const value = await Promise.resolve(call('retrieval.index.status', {})).catch(() => null);
      if (!live || !value) return;
      setRun(value.status === 'idle' ? undefined : value);
      if (value.status === 'running') timer = setTimeout(poll, 1000);
      else if (FINISHED.has(value.status)) onDone?.();
    };
    if (initialRun?.status !== 'running' && initialRun) return undefined;
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  async function start() {
    setStarting(true); setProblem('');
    const result = await startIndex(call, course);
    if (!alive.current) return;
    setStarting(false);
    if (result.phase === 'started') setRun(result.run); else setProblem(result.message);
  }
  async function stop() { const value = await Promise.resolve(call('retrieval.index.cancel', {})).catch(() => null); if (value && alive.current) setRun(value); }
  const upToDate = plan && plan.toIndex === 0 && plan.toRemove === 0;
  const progress = running ? indexProgress(run) : null;
  return (
    <div className="extension-panel__index">
      <div className="extension-panel__course">
        <label htmlFor={selectId}>{ui('要建立索引的课程')}
          <select id={selectId} value={course} disabled={running || starting} onChange={event => setCourse(event.target.value)}>
            <option value="">{ui('全部资料')}</option>
            {list.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>
      {plan && !running && <p className="extension-panel__plan" role="status">{upToDate
        ? uiFormat('「{0}」共 {1} 页，索引已是最新。', [course || ui('全部资料'), plan.pages])
        : uiFormat('「{0}」共 {1} 页：需要建立 {2} 页，{3} 页已经建好。', [course || ui('全部资料'), plan.pages, plan.toIndex, plan.unchanged])}</p>}
      {plan?.firstRun && !upToDate && !running && <p className="large-doc__note">{uiFormat('首次需要下载约 {0} MB 的检索模型，只下载一次，之后可以离线使用。', [plan.modelMb])}</p>}
      {running && <div className="extension-panel__progress">
        <progress max={run.total || 1} value={Math.min(run.done || 0, run.total || 1)} aria-label={ui('索引进度')} />
        <p role="status">{progress.label}</p>
        {run.stage === 'model' && run.firstRun && <p className="large-doc__note">{ui('首次需要下载约 90 MB 的检索模型，只下载一次。')}</p>}
        <Button size="sm" variant="quiet" onClick={stop}>{ui('停止')}</Button>
      </div>}
      {!running && <Button variant="primary" busy={starting} disabled={starting || !!upToDate || plan?.canIndex === false} onClick={start}>{ui('为这门课建立检索索引')}</Button>}
      {!running && <p className="large-doc__note">{ui('默认检索模型主要针对英文；中文教材也能检索（会结合关键词匹配），但语义匹配较弱。')}</p>}
      {problem && <InlineMessage>{problem}</InlineMessage>}
      {run?.status === 'complete' && <InlineMessage tone="success" boxed>
        {uiFormat('已为「{0}」建立索引：新增 {1} 页，移除 {2} 页，{3} 页无需更新。出题和 AI 带学现在会用它挑选相关页面。', [run.course || ui('全部资料'), run.added ?? 0, run.removed ?? 0, run.unchanged ?? 0])}
        {run.failedCount > 0 && ` ${uiFormat('{0} 页没能写入索引，下次建立时会重试。', [run.failedCount])}`}
      </InlineMessage>}
      {run?.status === 'cancelled' && <InlineMessage tone="info">{ui('已停止。建好的部分会保留，下次接着建。')}</InlineMessage>}
      {run?.status === 'failed' && <InlineMessage tone="error" boxed title={ui('索引没有建完')}>
        {run.error}
        {run.errorCode === 'retrieval-model-download' && ` ${ui('也可以在「设置 › 检索扩展」的高级选项里填写模型下载地址。')}`}
      </InlineMessage>}
    </div>
  );
}

/**
 * Props: call, status (retrieval.status incl. `extension`, `companion`), onStatus(next) after an install,
 * removal or finished build, courses + defaultCourse (for the index), and for previews and tests
 * initialApproval (package names), initialPlan, initialRun.
 */
export default function ExtensionPanel({ call, status, onStatus, courses = [], defaultCourse = '', initialApproval = null, initialPlan, initialRun }) {
  useInjectCss(css, 'study-large-documents');
  const { busy, error, approval, restart, install, setApproval } = useExtensionInstall({ call, onStatus, initialApproval });
  const [removing, setRemoving] = useState(false), [removeError, setRemoveError] = useState(''), [confirmRemove, setConfirmRemove] = useState(false);
  const extension = status?.extension;
  if (!status || !extension) return null;
  const refresh = async next => { const value = next || await Promise.resolve(call('retrieval.status', {})).catch(() => null); if (value) onStatus?.(value); };
  async function remove() {
    setRemoving(true); setRemoveError(''); setConfirmRemove(false);
    const result = await runUninstall(call);
    setRemoving(false);
    if (result.phase === 'error') setRemoveError(result.message); else if (result.status) onStatus?.(result.status);
  }
  const running = status.companion?.running === true;
  return (
    <div className="extension-panel" data-state={!extension.canInstall ? 'unsupported' : !extension.installed ? 'available' : running ? 'running' : 'starting'}>
      {!extension.canInstall && <InlineMessage tone="info" boxed>{ui('当前 DSH 不能在应用内安装插件，所以没有一键安装。可以展开「高级：手动配置」自己连接检索工具。')}</InlineMessage>}
      {extension.canInstall && !extension.installed && <>
        <p className="extension-panel__lead">{ui('一次点击：下载检索扩展，由 DSH 自己安装并运行。不需要命令行，也不需要另装其他软件；会下载一些组件，通常几分钟。')}</p>
        <div><Button variant="primary" icon="download" busy={busy} onClick={() => install()}>{ui('安装检索扩展')}</Button></div>
      </>}
      {extension.canInstall && extension.installed && <>
        {running ? <p className="extension-panel__lead extension-panel__lead--ok">{ui('检索扩展已安装并在运行。')}</p> : extension.outdated ? null : <StartupWait refresh={refresh} />}
        {restart && <InlineMessage tone="warning" boxed>{ui('这次更新要重启 DSH 之后才会生效。')}</InlineMessage>}
        <ExtensionUpdateNotice call={call} status={status} onStatus={onStatus} />
      </>}
      {(error || removeError) && <InlineMessage boxed title={ui('没能完成')}>{error || removeError}</InlineMessage>}
      {running && <IndexBuilder call={call} courses={courses} defaultCourse={defaultCourse} onDone={() => refresh()} initialPlan={initialPlan} initialRun={initialRun} />}
      {extension.canInstall && extension.installed && <div>
        <Button size="sm" variant="quiet" disabled={busy || removing} onClick={() => setConfirmRemove(true)}>{ui('卸载检索扩展')}</Button>
      </div>}
      <ApprovalDialog approval={approval} busy={busy} install={install} close={() => setApproval(null)} />
      {confirmRemove && <Dialog size="sm" title={ui('卸载检索扩展？')} onClose={() => setConfirmRemove(false)}
        description={ui('检索扩展会从 DSH 移除。已建好的索引和下载的检索模型仍留在 DSH 主目录里，重新安装后可以继续用。')}
        footer={<>
          <Button variant="quiet" onClick={() => setConfirmRemove(false)}>{ui('取消')}</Button>
          <Button variant="danger" onClick={remove}>{ui('卸载')}</Button>
        </>} />}
    </div>
  );
}
