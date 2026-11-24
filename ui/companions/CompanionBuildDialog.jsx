import React, { useCallback, useContext, useMemo, useState } from 'react';
import { ui, uiFormat, useUiLanguage, errorMessage } from '../i18n.js';
import { formatNumber } from '../format.js';
import { useStudy, useStudyBusy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { AppContext } from '../app/app-context.js';
import { courseNamesOf } from '../PageScope.jsx';
import { modelReadiness } from '../generation-status.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { ModelSettingsContext } from '../ModelErrorNote.jsx';
import { HandOff } from '../hand-off/HandOff.jsx';
import { countMaterials, groupSourcesByDocument } from '../../lib/source-groups.js';
import { courseScope } from '../../lib/course-tree.js';
import { Badge, Button, Checkbox, Chip, Dialog, Field, InlineMessage, SegmentedControl, Select, TextArea, TextInput } from '../components/index.js';
import css from './companions.css';

export function formatEstimateRange(value, formatter = formatNumber) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatter(Math.max(0, Math.round(value)));
  }
  if (value && typeof value === 'object') {
    const low = Number(value.low);
    const high = Number(value.high);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      const rLow = Math.max(0, Math.round(low));
      const rHigh = Math.max(rLow, Math.round(high));
      return rHigh > rLow ? `${formatter(rLow)}–${formatter(rHigh)}` : formatter(rHigh);
    }
    if (Number.isFinite(high)) return formatter(Math.max(0, Math.round(high)));
    if (Number.isFinite(low)) return formatter(Math.max(0, Math.round(low)));
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return formatter(0);
}

function resolveEstimateTokens(est) {
  if (!est || typeof est !== 'object') return 0;
  if (est.totalTokens !== undefined && est.totalTokens !== null) return est.totalTokens;
  const inp = est.inputTokens;
  const out = est.outputTokens;
  if (inp && typeof inp === 'object' && out && typeof out === 'object') {
    return {
      low: (Number(inp.low) || 0) + (Number(out.low) || 0),
      high: (Number(inp.high) || 0) + (Number(out.high) || 0),
    };
  }
  return (Number(inp) || 0) + (Number(out) || 0);
}

export default function CompanionBuildDialog({ modal, onClose }) {
  useInjectCss(css, 'study-companions');
  const { call, act, notify } = useStudy();
  const studyBusy = useStudyBusy();
  const app = useContext(AppContext);
  const fromModelContext = useContext(ModelSettingsContext);
  const data = app?.data;
  const model = modelReadiness(data);
  const rawOpenSettings = fromModelContext ?? app?.settingsEntry?.openModelSettings;
  const handleOpenModelSettings = rawOpenSettings
    ? () => { onClose(); rawOpenSettings(); }
    : undefined;
  const language = useUiLanguage();

  const knownCourses = useMemo(() => courseNamesOf(data), [data]);
  const [tab, setTab] = useState(modal?.tab === 'attach' ? 'attach' : 'build');
  const [course, setCourse] = useState(modal?.course || data?.focus?.course || knownCourses[0] || '');
  const [topic, setTopic] = useState(modal?.topic || '');
  const [archetype, setArchetype] = useState(modal?.archetype || 'auto');
  const [archetypeManual, setArchetypeManual] = useState(() => Boolean(modal?.archetype && modal.archetype !== 'auto'));
  const [mountMode, setMountMode] = useState('auto');
  const [selectedSources, setSelectedSources] = useState(() => new Set(modal?.sourceIds || []));
  const [estimate, setEstimate] = useState(modal?.initialEstimate || null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Tab 2: Attach existing HTML file or companion directory (e.g. Java Hood Lab)
  const [attachPath, setAttachPath] = useState('');
  const [storageMode, setStorageMode] = useState('linked');

  const courseDocuments = useMemo(() => {
    const raw = (data?.sources || []).filter(s => !s.archived && !s.blueprint && !s.courseOutline && !s.courseInventory && !s.companionId);
    const docs = groupSourcesByDocument(raw, { documents: data?.documents }).filter(doc => !doc.archived && doc.sourceIds.length > 0);
    const trimmed = course.trim();
    if (!trimmed) return docs.slice(0, 60);
    const within = courseScope(trimmed, knownCourses);
    return docs.filter(doc => Array.isArray(doc.courses) && doc.courses.some(c => within(String(c).trim()))).slice(0, 60);
  }, [course, data?.documents, data?.sources, knownCourses]);

  const courseSourceIdSet = useMemo(
    () => new Set(courseDocuments.flatMap(doc => doc.sourceIds)),
    [courseDocuments],
  );
  const effectiveSourceIds = useMemo(
    () => [...selectedSources].filter(id => courseSourceIdSet.has(id)),
    [selectedSources, courseSourceIdSet],
  );

  const selectedDocumentCount = useMemo(
    () => countMaterials(data?.sources, effectiveSourceIds),
    [data?.sources, effectiveSourceIds],
  );

  useLiveEffect(isLive => {
    if (tab !== 'build' || !course.trim() || (!topic.trim() && !effectiveSourceIds.length)) {
      setEstimate(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      call('generation.companion.build', {
        course: course.trim(),
        topic: topic.trim(),
        sourceIds: effectiveSourceIds,
        archetype,
        mountMode,
        language,
        estimate: true,
      }).then(res => { if (isLive()) setEstimate(res); }).catch(() => { if (isLive()) setEstimate(null); });
    }, 260);
    return () => { clearTimeout(timer); };
  }, [archetype, call, course, effectiveSourceIds, language, mountMode, tab, topic]);

  const toggleSourceGroup = useCallback((ids, checked) => {
    setSelectedSources(prev => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id); else next.delete(id);
      }
      return next;
    });
  }, []);

  const handleBuild = useCallback(async () => {
    setError('');
    if (!course.trim()) { setError(ui('请填写或选择所属课程名称（可新建任意学科课程，如微积分、西方哲学、机械原理）。')); return; }
    if (!topic.trim() && !effectiveSourceIds.length) { setError(ui('请输入想要讲透的主题/困惑，或勾选至少一份参考资料。')); return; }
    setSubmitting(true);
    try {
      const res = await act('generation.companion.build', {
        course: course.trim(),
        topic: topic.trim(),
        sourceIds: effectiveSourceIds,
        archetype,
        mountMode,
        language,
      }, undefined, { rethrow: true });
      if (res === undefined) {
        setError(ui('上一个操作还没结束，请稍后再试。'));
        return;
      }
      notify({
        text: res?.alreadyRunning
          ? ui('相同的交互伴学课任务已在后台运行中。')
          : ui('已开始在后台生成交互伴学课（含四阶段分镜精写与公式校验），可在「任务」页查看实时进度。'),
        tone: 'success',
      });
      onClose();
      if (res?.jobId && app?.nav?.navigate) app.nav.navigate('tasks');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [act, app?.nav, archetype, course, effectiveSourceIds, language, mountMode, notify, onClose, topic]);

  const handleAttach = useCallback(async () => {
    setError('');
    if (!attachPath.trim()) { setError(ui('请输入本地伴学目录（含 pages/*.html）或单个 HTML 文件路径。')); return; }
    setSubmitting(true);
    try {
      const res = await act('companion.attach', {
        path: attachPath.trim(),
        ...(course.trim() ? { course: course.trim() } : {}),
        mode: storageMode,
        mountMode,
        allowRememberTrusted: true,
      }, undefined, { rethrow: true });
      if (res === undefined) {
        setError(ui('上一个操作还没结束，请稍后再试。'));
        return;
      }
      if (res?.kind === 'directory') {
        notify({
          text: uiFormat('已挂载目录伴学包：新增 {0} 节、更新 {1} 节，关联 {2} 道现有题、补充 {3} 道新题。', [res.attached, res.updated, res.cardsLinked, res.cardsAdded]),
          tone: 'success',
        });
      } else {
        notify({ text: uiFormat('已挂载交互伴学页「{0}」。', [res?.companion?.title || '']), tone: 'success' });
      }
      app?.core?.refresh?.();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [act, app?.core, attachPath, course, mountMode, notify, onClose, storageMode]);

  const starterExamples = [
    {
      id: 'math',
      label: ui('数学 · 一致收敛'),
      course: ui('数学分析'),
      archetype: 'sandbox',
      topic: ui('为什么逐点收敛不足以交换极限与积分？用参数沙盒对比突起函数序列的面积逃逸与一致收敛上确界判据'),
    },
    {
      id: 'philosophy',
      label: ui('哲学 · 义务论与功利主义'),
      course: ui('道德哲学'),
      archetype: 'dialectic',
      topic: ui('康德定言令式与行为功利主义在电车难题、器官移植医生与善意谎言三个边界案例上的对撞与隐含公理拆解'),
    },
    {
      id: 'meche',
      label: ui('机械工程 · 四杆机构与闭环控制'),
      course: ui('机械原理与控制'),
      archetype: 'mechanism',
      topic: ui('曲柄摇杆机构的急回特性、传动角退化与共线死点力流分析，以及飞轮惯性与闭环反馈如何跨过死点'),
    },
    {
      id: 'cs',
      label: ui('计算机 · 无锁 CAS 与 ABA'),
      course: ui('并发系统设计'),
      archetype: 'empirical',
      topic: ui('为什么无锁栈的 Compare-And-Swap 会在节点复用时掉进 ABA 陷阱？双线程交错泳道推演与版本号指针修复'),
    },
  ];

  const applyStarterExample = example => {
    setError('');
    const sameTopic = topic.trim() === example.topic;
    setTopic(example.topic);
    if (!archetypeManual || sameTopic) {
      setArchetype(example.archetype);
      setArchetypeManual(false);
    }
    const trimmedCourse = course.trim();
    if (!trimmedCourse || starterExamples.some(item => item.course === trimmedCourse)) {
      setCourse(example.course);
    }
  };

  return (
    <Dialog
      size="md"
      title={ui('交互伴学（生成跨学科伴学页 / 挂载伴学包）')}
      description={ui('同一套逐句舞台引擎支持数学、哲学、机械、计算机等任意学科：既可自由生成独立自包含 HTML 材料，也可一键挂载本地 Lab 目录。')}
      busy={submitting}
      onClose={onClose}
      footer={(
        <div className="sh-comp-foot">
          <div>
            {tab === 'build' && (
              <Badge tone={effectiveSourceIds.length > 0 ? 'success' : 'neutral'}>
                {effectiveSourceIds.length > 0 ? ui('严格锚定已选讲义原文') : ui('自由命题生成 · 诚实标注 AI 推演')}
              </Badge>
            )}
          </div>
          <div className="sh-comp-foot__actions">
            <Button variant="quiet" lock={submitting} onClick={onClose}>{ui('取消')}</Button>
            {tab === 'build' ? (
              <Button variant="primary" busy={submitting} lock={studyBusy} disabled={!model.ready} onClick={handleBuild}>{ui('开始生成 HTML 伴学课')}</Button>
            ) : (
              <Button variant="primary" busy={submitting} lock={studyBusy} onClick={handleAttach}>{ui('立即挂载')}</Button>
            )}
          </div>
        </div>
      )}
    >
      <div className="sh-comp-build">
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: 'build', label: ui('AI 生成跨学科伴学课') },
            { value: 'attach', label: ui('挂载本地目录 / HTML') },
          ]}
        />

        <Field label={ui('所属课程（可直接输入新学科名称）')}>
          <TextInput
            value={course}
            onChange={e => setCourse(e.target.value)}
            placeholder={ui('例如：微积分 / 西方哲学 / 机械原理 / Java 并发')}
          />
        </Field>

        {tab === 'build' ? (
          <>
            <ModelSetupGate variant="compact" feature="companion" model={model} onOpenSettings={handleOpenModelSettings} />
            <Field label={ui('你想掀开机盖讲透什么问题？（支持无资料自由出课）')}>
              <TextArea
                rows={3}
                value={topic}
                onChange={e => setTopic(e.target.value)}
                placeholder={ui('例如：为什么一致收敛才能交换极限与积分？ / 康德定言令式与功利主义在边界案例上的冲突 / 单自由度阻尼振动的三种响应曲线 / 四杆机构急回特性与死点')}
              />
            </Field>

            <div className="sh-comp-build__starters" role="group" aria-label={ui('跨学科一键示例')}>
              <span className="sh-comp-build__starters-label">{ui('跨学科示例（点击自动填入主题与母版）：')}</span>
              {starterExamples.map(example => (
                <Chip
                  key={example.id}
                  size="sm"
                  data-starter-id={example.id}
                  data-archetype={example.archetype}
                  selected={topic.trim() === example.topic}
                  onClick={() => applyStarterExample(example)}
                >
                  {example.label}
                </Chip>
              ))}
            </div>

            <div className="sh-comp-build__row">
              <Field label={ui('教学交互母版')}>
                <Select
                  value={archetype}
                  onChange={val => {
                    setArchetype(val);
                    setArchetypeManual(val !== 'auto');
                  }}
                  options={[
                    { value: 'auto', label: ui('自动匹配学科（推荐）') },
                    { value: 'sandbox', label: ui('数理参数沙盒（数学 / 物理 / 机械 / 经济）') },
                    { value: 'dialectic', label: ui('思辨反例矩阵（哲学 / 法学 / 人文 / 鉴别）') },
                    { value: 'mechanism', label: ui('分步矢量框图（机构 / 硬件 / 生理 / 系统）') },
                    { value: 'empirical', label: ui('代码实证泳道（算法 / 并发 / 数据库）') },
                  ]}
                />
              </Field>
              <Field label={ui('题库联动策略')}>
                <Select
                  value={mountMode}
                  onChange={setMountMode}
                  options={[
                    { value: 'auto', label: ui('智能判断（已有题组则增强挂载，空白课全量导题）') },
                    { value: 'enrich-existing', label: ui('增强挂载（高置信挂单卡 + 补口述题）') },
                    { value: 'full-pack', label: ui('全量导题（生成带走闪卡 + 自测单选 + 口述题）') },
                    { value: 'companion-only', label: ui('仅生成伴学页与投影讲义，不导题') },
                  ]}
                />
              </Field>
            </div>

            {courseDocuments.length > 0 && (
              <Field group label={uiFormat('可选：勾选参考讲义（已选 {0} 份；不选则按主题自由推演）', [selectedDocumentCount])}>
                <div className="sh-comp-build__sources">
                  {courseDocuments.map(doc => (
                    <Checkbox
                      key={doc.key}
                      checked={doc.sourceIds.every(id => selectedSources.has(id))}
                      onChange={on => toggleSourceGroup(doc.sourceIds, on)}
                      label={doc.title || doc.sourceIds[0]}
                    />
                  ))}
                </div>
              </Field>
            )}

            {estimate?.estimate && (
              <InlineMessage tone="info">
                {uiFormat('预计分 4 阶段（约 {0} 次模型调用，预估读取与输出约 {1} Tokens），产出约 16–20 页自包含 HTML 文件并写入工作区 companions/ 目录。', [
                  formatEstimateRange(estimate.estimate.calls || 3, n => String(n)),
                  formatEstimateRange(resolveEstimateTokens(estimate.estimate), formatNumber),
                ])}
              </InlineMessage>
            )}

            <HandOff
              id="companion.ask"
              shape="quiet"
              className="sh-comp-build__handoff"
              lead="想让主会话直接编排这节伴学课："
              what="把课程、主题与交互母版发给主会话，让主会话设计并生成交互伴学课"
              input={{
                mode: 'build',
                course: course.trim(),
                topic: topic.trim(),
                archetype,
                mountMode,
                sourceIds: [...selectedSources],
              }}
              onSent={outcome => { if (outcome !== 'failed') onClose(); }}
            />
          </>
        ) : (
          <>
            <Field label={ui('本地伴学目录或单个 HTML 文件路径')}>
              <TextInput
                value={attachPath}
                onChange={e => setAttachPath(e.target.value)}
                placeholder={ui('例如：D:\\labs\\concurrency-lab 或 companions/calculus/uniform-convergence.html')}
              />
            </Field>
            <div className="sh-comp-build__row">
              <Field label={ui('存储方式')}>
                <Select
                  value={storageMode}
                  onChange={setStorageMode}
                  options={[
                    { value: 'linked', label: ui('目录原位挂载（零备份膨胀，实时感知修改并同步疑问清单）') },
                    { value: 'managed', label: ui('复制副本至学习库（随便携备份导出）') },
                  ]}
                />
              </Field>
              <Field label={ui('题库联动策略')}>
                <Select
                  value={mountMode}
                  onChange={setMountMode}
                  options={[
                    { value: 'auto', label: ui('智能判断（已有题组则增强挂载，空白课全量导题）') },
                    { value: 'enrich-existing', label: ui('增强挂载（高置信挂单卡 + 补口述题）') },
                    { value: 'full-pack', label: ui('全量零消耗导题（带走卡 + 小测 + 口述题）') },
                    { value: 'companion-only', label: ui('仅挂交互伴学页，不导题') },
                  ]}
                />
              </Field>
            </div>
          </>
        )}

        {error && <InlineMessage tone="error">{error}</InlineMessage>}
      </div>
    </Dialog>
  );
}
