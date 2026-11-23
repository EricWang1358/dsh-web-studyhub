import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatNumber } from '../format.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useUndoable } from '../use-undoable.js';
import { AppContext } from '../app/app-context.js';
import { companionSlideCheck } from '../../lib/practice-settings.js';
import { courseScope } from '../../lib/course-tree.js';
import { companionDeckRefsMap } from './companion-cards.js';
import { Badge, Button, SegmentedControl, TextInput } from '../components/index.js';
import css from './companions.css';

export default function CourseCompanionsBar({ course, data }) {
  useInjectCss(css, 'study-companions');
  const { busy, call, openModal } = useStudy();
  const app = useContext(AppContext);
  const refresh = app?.core?.refresh;
  const slideCheckOn = companionSlideCheck(data?.settings?.practice);
  const deckRefsByCompanion = useMemo(
    () => (slideCheckOn && app?.intents?.practice ? companionDeckRefsMap(data?.decks, data?.sources, data?.courses) : new Map()),
    [app?.intents?.practice, data?.courses, data?.decks, data?.sources, slideCheckOn],
  );
  const undoable = useUndoable();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const prevCourseRef = useRef(course);

  // Reset search, progress filter and expand state when switching courses in place (e.g. StudyMap).
  useEffect(() => {
    if (prevCourseRef.current === course) return;
    prevCourseRef.current = course;
    setQuery('');
    setStatusFilter('all');
    setExpanded(false);
  }, [course]);

  const companions = useMemo(() => {
    if (!course) return [];
    const courses = data?.courses || [];
    const within = courseScope(course, courses.map(c => c?.name).filter(Boolean));
    return courses
      .filter(c => within(c.name) || (c.aliases || []).some(within))
      .flatMap(c => (c.companions || []).map(item => ({ ...item, course: c.name })))
      .filter(item => !undoable.hidden(`comp:${item.id}`));
  }, [course, data?.courses, undoable]);

  const toolbarShown = companions.length > 6;
  useEffect(() => {
    if (!toolbarShown && (query || statusFilter !== 'all')) {
      setQuery('');
      setStatusFilter('all');
    }
  }, [toolbarShown, query, statusFilter]);

  const effectiveQuery = toolbarShown ? query : '';
  const effectiveStatus = toolbarShown ? statusFilter : 'all';

  const filtered = useMemo(() => {
    const needle = effectiveQuery.trim().toLowerCase();
    return companions.filter(item => {
      if (effectiveStatus === 'done' && !item.progress?.completed) return false;
      if (effectiveStatus === 'active' && (!(item.progress?.slide > 1) || item.progress?.completed)) return false;
      if (!needle) return true;
      const hay = `${item.title || ''} ${item.lessonId || ''} ${item.relPath || ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [companions, effectiveQuery, effectiveStatus]);

  if (course === null || course === undefined) return null;

  const isEmpty = companions.length === 0;
  const isFiltering = Boolean(effectiveQuery.trim()) || effectiveStatus !== 'all';
  const collapseCap = isFiltering ? 24 : 6;
  const shown = expanded ? filtered : filtered.slice(0, collapseCap);
  const remove = item => undoable.commitLater({
    keys: [`comp:${item.id}`],
    message: uiFormat('已从课程移除伴学页「{0}」（工作区或原目录里的文件保留不变）。', [item.title]),
    commit: async () => {
      await call('companion.remove', { id: item.id, course: item.course || course });
      Promise.resolve(refresh?.()).catch(() => {});
      return true;
    },
  });

  return (
    <section className={`sh-comp-bar${isEmpty ? ' sh-comp-bar--empty' : ''}`} aria-label={ui('交互伴学')}>
      <div className="sh-comp-bar__head">
        <div className="sh-comp-bar__intro">
          <h3 className="sh-comp-bar__title">
            <span>{ui('交互伴学')}</span>
            {companions.length > 0 && <Badge size="sm" tone="neutral">{formatNumber(companions.length)}</Badge>}
          </h3>
          {isEmpty && (
            <p className="sh-comp-bar__empty">
              {ui('可为任意学科自由生成逐句互动的独立 HTML 伴学课（含公式推导、参数沙盒、反例矩阵），或一键挂载本地伴学目录。')}
            </p>
          )}
        </div>
        <div className="sh-comp-bar__btns">
          {companions.length > 6 && (filtered.length > collapseCap || expanded) && (
            <Button size="sm" variant="quiet" onClick={() => setExpanded(v => !v)}>
              {expanded ? ui('收起列表') : uiFormat('展开全部 {0} 节', [formatNumber(filtered.length)])}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => openModal({ type: 'companionBuild', course })}
          >
            {isEmpty ? ui('新建交互伴学课') : ui('生成 / 挂载伴学课')}
          </Button>
        </div>
      </div>

      {companions.length > 6 && (
        <div className="sh-comp-bar__toolbar">
          <TextInput
            type="search"
            className="sh-comp-bar__search"
            value={query}
            placeholder={ui('搜索伴学课标题…')}
            aria-label={ui('搜索伴学课标题…')}
            autoComplete="off"
            spellCheck={false}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229) return;
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          <SegmentedControl
            size="sm"
            label={ui('学习进度筛选')}
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: 'all', label: ui('全部') },
              { value: 'active', label: ui('进行中') },
              { value: 'done', label: ui('已学完') },
            ]}
          />
        </div>
      )}

      {isEmpty ? null : filtered.length === 0 ? (
        <div className="sh-comp-bar__empty-filter">
          <span className="sh-comp-bar__empty">{ui('没有匹配的伴学课。')}</span>
          <Button size="sm" variant="quiet" onClick={() => { setQuery(''); setStatusFilter('all'); }}>
            {ui('清空伴学筛选')}
          </Button>
        </div>
      ) : (
        <ul className="sh-comp-bar__list">
          {shown.map(item => (
            <li key={item.id} className="sh-comp-bar__row">
              <div className="sh-comp-bar__meta">
                <span className="sh-comp-bar__name">{item.title}</span>
                {item.progress?.completed ? (
                  <Badge size="sm" tone="success">{ui('已学完')}</Badge>
                ) : item.progress?.slide > 1 ? (
                  <Badge size="sm" tone="info">{uiFormat('{0}/{1} 页', [item.progress.slide, item.progress.slideTotal || item.slideCount || '?'])}</Badge>
                ) : item.slideCount ? (
                  <Badge size="sm" tone="neutral">{uiFormat('{0} 页', [item.slideCount])}</Badge>
                ) : null}
                {item.grounded === false && <Badge size="sm" tone="neutral">{ui('AI 推演')}</Badge>}
              </div>
              <div className="sh-comp-bar__btns">
                {(() => {
                  const cardRefs = slideCheckOn ? deckRefsByCompanion.get(item.id) || [] : [];
                  if (!cardRefs.length || !app?.intents?.practice) return null;
                  return (
                    <Button iconEnd="arrow-right" size="sm" variant="quiet" wrap lock={busy} onClick={() => app.intents.practice(cardRefs.slice(0, 200))}>
                      {uiFormat('练配套题 ({0})', [Math.min(200, cardRefs.length)])}
                    </Button>
                  );
                })()}
                <Button iconEnd="arrow-right" size="sm" onClick={() => openModal({ type: 'companion', id: item.id, course: item.course || course })}>
                  {item.progress?.slide > 1 && !item.progress?.completed ? ui('接着看') : ui('打开')}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => remove(item)}>{ui('移除')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
