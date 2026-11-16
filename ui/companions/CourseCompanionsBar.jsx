import React, { useContext, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatNumber } from '../format.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useUndoable } from '../use-undoable.js';
import { AppContext } from '../app/app-context.js';
import { Badge, Button, SegmentedControl, TextInput } from '../components/index.js';
import css from './companions.css';

export default function CourseCompanionsBar({ course, data }) {
  useInjectCss(css, 'study-companions');
  const { call, openModal } = useStudy();
  const refresh = useContext(AppContext)?.core?.refresh;
  const undoable = useUndoable();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const companions = useMemo(() => {
    if (!course) return [];
    const rec = (data?.courses || []).find(c => c.name === course || (c.aliases || []).includes(course));
    return (rec?.companions || []).filter(item => !undoable.hidden(`comp:${item.id}`));
  }, [course, data?.courses, undoable]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return companions.filter(item => {
      if (statusFilter === 'done' && !item.progress?.completed) return false;
      if (statusFilter === 'active' && (!(item.progress?.slide > 1) || item.progress?.completed)) return false;
      if (!needle) return true;
      const hay = `${item.title || ''} ${item.lessonId || ''} ${item.relPath || ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [companions, query, statusFilter]);

  if (course === null || course === undefined) return null;

  const isEmpty = companions.length === 0;
  const isFiltering = Boolean(query.trim()) || statusFilter !== 'all';
  const collapseCap = isFiltering ? 24 : 6;
  const shown = expanded ? filtered : filtered.slice(0, collapseCap);
  const remove = item => undoable.commitLater({
    keys: [`comp:${item.id}`],
    message: uiFormat('已从课程移除伴学页「{0}」（工作区或原目录里的文件保留不变）。', [item.title]),
    commit: async () => {
      await call('companion.remove', { id: item.id, course });
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
            icon={isEmpty ? 'play' : 'plus'}
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
                <Button size="sm" onClick={() => openModal({ type: 'companion', id: item.id, course })}>
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
