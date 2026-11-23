import React, { useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatIndex, joinMeta } from '../format.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  SegmentedControl,
  TextInput,
  Tooltip,
} from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useStudy } from '../study-context.jsx';
import { useOptionalAppSelector } from '../app/app-context.js';
import PaceMeta from '../pace/PaceMeta.jsx';
import { TERMS } from '../mastery-terms.js';
import { gapHintLabel } from '../evidence-hint.js';
import {
  INITIAL_VISIBLE_CHAPTERS,
  buildMasteryMapModel,
  chapterPreviewDots,
  filterMasteryChapters,
  isUncovered,
  nextMasteryGridIndex,
} from './model.js';
import css from './mastery-map.css';

/* 掌握度图谱界面 (Mastery Graph / Knowledge-Point Mastery Map UI).
   Visualizes chapter & knowledge-point mastery by combining course outline hierarchy, question
   coverage gaps, FSRS mastery levels, and PointEvidence signals, with interactive status filters,
   search, Heatmap Grid / Learning Spine layouts, and inline chapter → point drill-down actions. */

const STATE_BADGE = {
  mastered: { tone: 'success', label: '已掌握' },
  learning: { tone: 'warning', label: '巩固中' },
  weak: { tone: 'error', label: '薄弱' },
  unlearned: { tone: 'neutral', label: '未学' },
  uncovered: { tone: 'neutral', label: '尚无题目' },
  'draft-only': { tone: 'info', label: '草稿待发布' },
  pending: { tone: 'neutral', label: '未生成' },
};

function cellPctText(chapter) {
  if (chapter.pending) return ui('未生成');
  if (chapter.total === 0) return chapter.draftCards > 0 ? ui('草稿') : ui('尚无题目');
  if (chapter.learned === 0) return ui('未学');
  return `${chapter.mastery}%`;
}

function examTierBadge(tier) {
  if (tier === 'must') return { tone: 'warning', label: ui('必考') };
  if (tier === 'often') return { tone: 'neutral', label: ui('常考') };
  return null;
}

function pointCoverageText(point) {
  if (point.pending) return ui('章节尚未生成');
  if (point.total === 0) {
    return point.draftCards > 0
      ? uiFormat('草稿里有 {0} 题（尚未发布）', [point.draftCards])
      : ui('还没有题目覆盖此知识点');
  }
  return joinMeta([
    uiFormat('掌握 {0}%', [point.mastery]),
    uiFormat('已学 {0}/{1} 题', [point.learned, point.total]),
    point.weak > 0 ? uiFormat('薄弱 {0}', [point.weak]) : '',
    point.due > 0 ? uiFormat('到期 {0}', [point.due]) : '',
    point.draftCards > 0 ? uiFormat('草稿 {0}', [point.draftCards]) : '',
  ]);
}

function ChapterInspector({
  chapter,
  basis,
  hasBookNotes,
  activeFilter,
  query,
  focusedPointId,
  onClose,
  onPracticeChapter,
  onPracticePoint,
  onGoGenerate,
  onOpenDeck,
  onOpenBook,
}) {
  const { busy } = useStudy();
  const [showAllPoints, setShowAllPoints] = useState(false);
  const allPoints = chapter.points || [];
  const filteredPoints = chapter.matchedPoints || allPoints;
  const isSubset = filteredPoints.length < allPoints.length;
  const shownPoints = showAllPoints ? allPoints : filteredPoints;
  const chapterUncoveredTitles = allPoints.filter((pt) => isUncovered(pt) && pt.title).map((pt) => pt.title);

  const meta = joinMeta([
    chapter.total > 0 ? uiFormat('掌握度 {0}%', [chapter.mastery]) : ui('尚无已发布题目'),
    chapter.total > 0 ? uiFormat('已学 {0}/{1} 题', [chapter.learned, chapter.total]) : '',
    allPoints.length > 0 && basis === 'outline'
      ? uiFormat('已覆盖 {0}/{1} 知识点', [chapter.coveredPoints, allPoints.length])
      : '',
    chapter.weak > 0 ? uiFormat('薄弱 {0}', [chapter.weak]) : '',
    chapter.due > 0 ? uiFormat('到期 {0}', [chapter.due]) : '',
  ]);

  return (
    <div className="mm-inspector" role="region" aria-label={chapter.title} data-mm-inspector={chapter.id}>
      <div className="mm-inspector__head">
        <div>
          <h3 className="mm-inspector__title">{`${formatIndex(chapter.index + 1)} · ${chapter.title}`}</h3>
          <p className="mm-inspector__meta">{meta}</p>
          {chapter.intro && <p className="mm-inspector__intro">{chapter.intro}</p>}
        </div>
        <div className="mm-inspector__actions">
          {chapter.total > 0 && onPracticeChapter && (
            <Button
              size="sm"
              variant="primary"
              iconEnd="arrow-right"
              lock={busy}
              data-mm-practice-chapter=""
              onClick={() => onPracticeChapter(chapter)}
            >
              {chapter.resume ? ui('继续本章') : ui('练这一章')}
            </Button>
          )}
          {chapterUncoveredTitles.length > 0 && onGoGenerate && (
            <Button
              size="sm"
              variant="secondary"
              iconEnd="arrow-right"
              lock={busy}
              data-mm-chapter-gapfill=""
              onClick={() => onGoGenerate(chapterUncoveredTitles)}
            >
              {uiFormat('补本章缺口题 ({0})', [chapterUncoveredTitles.length])}
            </Button>
          )}
          {chapter.kind === 'deck' && chapter.deckId && onOpenDeck && (
            <Button
              size="sm"
              variant="secondary"
              iconEnd="arrow-right"
              lock={busy}
              onClick={() => onOpenDeck(chapter.deckId)}
            >
              {ui('管理题组')}
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={onClose}>
            {ui('收起')}
          </Button>
        </div>
      </div>

      {isSubset && (
        <div className="mm-controls">
          <span className="mm-point__sub">
            {showAllPoints
              ? uiFormat('正在显示本章全部 {0} 项', [allPoints.length])
              : uiFormat('当前筛选命中 {0} / {1} 项', [filteredPoints.length, allPoints.length])}
          </span>
          <Button size="sm" variant="quiet" onClick={() => setShowAllPoints((v) => !v)}>
            {showAllPoints ? ui('只看筛选命中') : ui('查看本章全部')}
          </Button>
        </div>
      )}

      {shownPoints.length > 0 ? (
        <ul className="mm-points">
          {shownPoints.map((pt) => {
            const stateBadge = STATE_BADGE[pt.state] || STATE_BADGE.unlearned;
            const tierBadge = examTierBadge(pt.examTier);
            const hint = gapHintLabel(pt.evidence?.gapHint);
            const prereqs = Array.isArray(pt.evidence?.prereqGaps)
              ? pt.evidence.prereqGaps.map((g) => g?.title).filter(Boolean)
              : [];
            const ratio = pt.total > 0 ? Math.max(0, Math.min(1, pt.mastery / 100)) : 0;
            const isFocused = focusedPointId === pt.id;
            const uncovered = isUncovered(pt);
            return (
              <li
                key={pt.id}
                className="mm-point"
                data-point-id={pt.id}
                data-point-state={pt.state}
                data-focused={isFocused ? 'true' : undefined}
              >
                <div className="mm-point__main">
                  <div className="mm-point__top">
                    {pt.sectionTitle && <span className="mm-point__section">{`${pt.sectionTitle} ›`}</span>}
                    <span className="mm-point__title">{pt.title}</span>
                    <Badge size="sm" tone={stateBadge.tone}>{ui(stateBadge.label)}</Badge>
                    {tierBadge && <Badge size="sm" tone={tierBadge.tone}>{tierBadge.label}</Badge>}
                  </div>
                  <div className="mm-point__meter">
                    <span
                      className={uncovered ? 'mm-point__bar mm-point__bar--gap' : 'mm-point__bar'}
                      aria-hidden="true"
                    >
                      {pt.total > 0 && (
                        <span
                          className="mm-point__bar-fill"
                          data-state={pt.state}
                          style={{ transform: `scaleX(${ratio})` }}
                        />
                      )}
                    </span>
                    <span className="mm-point__sub">{pointCoverageText(pt)}</span>
                  </div>
                  {hint && <span className="mm-point__hint" data-mm-gap-hint="">{hint}</span>}
                  {prereqs.length > 0 && (
                    <span className="mm-point__prereqs" data-mm-prereqs="">
                      {uiFormat('前置待补：{0}', [prereqs.slice(0, 3).join('、')])}
                    </span>
                  )}
                </div>

                <div className="mm-point__actions">
                  {pt.total > 0 && onPracticePoint && (
                    <Button
                      size="sm"
                      variant="secondary"
                      iconEnd="arrow-right"
                      lock={busy}
                      data-mm-practice-point={pt.id}
                      onClick={() => onPracticePoint(pt)}
                    >
                      {pt.resume ? ui('继续') : ui('去练')}
                    </Button>
                  )}
                  {uncovered && onGoGenerate && pt.title && (
                    <Button
                      size="sm"
                      variant="secondary"
                      iconEnd="arrow-right"
                      lock={busy}
                      data-mm-generate-point={pt.id}
                      onClick={() => onGoGenerate([pt.title])}
                    >
                      {ui('去出题')}
                    </Button>
                  )}
                  {hasBookNotes && pt.key && onOpenBook && (
                    <Button
                      size="sm"
                      variant="quiet"
                      iconEnd="arrow-right"
                      lock={busy}
                      data-mm-book-point={pt.id}
                      onClick={() => onOpenBook(pt.key)}
                    >
                      {ui('打开书页')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mm-point__sub">
          {activeFilter !== 'all' || query
            ? ui('本章在当前筛选条件下没有匹配的知识点。')
            : ui('本章暂无可下钻的子知识点。')}
        </p>
      )}
    </div>
  );
}

export default function MasteryMap({
  outline = null,
  decks = [],
  progress = {},
  course = '*',
  route = null,
  loading = false,
  error = '',
  onRetry,
  onPracticeChapter,
  onPracticePoint,
  onPracticeWeakAll,
  onGoGenerate,
  onOpenDeck,
  onOpenOutline,
  onOpenBook,
  onOpenWrongBook,
  defaultLayout = 'heatmap',
  paceForecast: propPaceForecast,
  practising = false,
}) {
  useInjectCss(css, 'study-mastery-map');
  const { busy: studyBusy } = useStudy();
  const busy = studyBusy || practising;
  const storePaceForecast = useOptionalAppSelector((state) => state.data?.paceForecast);
  const paceForecast = propPaceForecast ?? storePaceForecast;
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState(defaultLayout === 'spine' ? 'spine' : 'heatmap');
  const [selectedId, setSelectedId] = useState(null);
  const [focusedPointId, setFocusedPointId] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [activeGridIndex, setActiveGridIndex] = useState(0);
  const gridRef = useRef(null);

  const model = useMemo(
    () => buildMasteryMapModel({ outline, decks, progress, course, route }),
    [outline, decks, progress, course, route],
  );

  const activeFilter = filter !== 'all' && model.countsByFilter[filter] === 0 ? 'all' : filter;
  const filtered = useMemo(
    () => filterMasteryChapters(model.chapters, { filter: activeFilter, query }),
    [model.chapters, activeFilter, query],
  );
  const visible = showAll || filtered.length <= INITIAL_VISIBLE_CHAPTERS
    ? filtered
    : filtered.slice(0, INITIAL_VISIBLE_CHAPTERS);

  const selected = useMemo(
    () => filtered.find((c) => c.id === selectedId) || model.chapters.find((c) => c.id === selectedId) || null,
    [filtered, model.chapters, selectedId],
  );

  if (loading && !model.chapters.length) {
    return <LoadingState label={ui('正在生成掌握度图谱…')} />;
  }
  if (error && !model.chapters.length) {
    return <ErrorState error={error} title={ui('掌握度图谱加载失败')} onRetry={onRetry} />;
  }
  if (!model.chapters.length) {
    return (
      <EmptyState
        icon="book"
        title={ui('当前范围还没有可展示的章节或知识点')}
        description={ui('发布题组或在总纲中整理课程资料后，这里会按章节和知识点展示掌握度与题库缺口。')}
        primary={onOpenOutline ? { label: ui('前往总纲'), iconEnd: 'arrow-right', onClick: onOpenOutline } : undefined}
      />
    );
  }

  const { totals } = model;
  const coursePace = paceForecast
    ? (course != null && course !== '*'
      ? (paceForecast.courses?.[course] || null)
      : (paceForecast.library || null))
    : null;
  const canPracticeWeak = (model.weakKeys.length > 0 || model.weakScopes.length > 0) && Boolean(onPracticeWeakAll);
  const canGapFillAll = model.uncoveredTitles.length > 0 && Boolean(onGoGenerate);

  const filterOptions = [
    { id: 'all', label: uiFormat('全部 {0}', [model.countsByFilter.all]), show: true },
    { id: 'weak', label: uiFormat('薄弱与到期 {0}', [model.countsByFilter.weak]), show: model.countsByFilter.weak > 0 },
    { id: 'uncovered', label: uiFormat('尚无题目 {0}', [model.countsByFilter.uncovered]), show: model.countsByFilter.uncovered > 0 },
    { id: 'learning', label: uiFormat('巩固中 {0}', [model.countsByFilter.learning]), show: model.countsByFilter.learning > 0 },
    { id: 'mastered', label: uiFormat('已掌握 {0}', [model.countsByFilter.mastered]), show: model.countsByFilter.mastered > 0 },
    { id: 'new', label: uiFormat('未开始 {0}', [model.countsByFilter.new]), show: model.countsByFilter.new > 0 },
  ].filter((opt) => opt.show);

  const rovingIndex = visible.length ? Math.max(0, Math.min(visible.length - 1, activeGridIndex)) : 0;

  const handleGridKeyDown = (event) => {
    if (!visible.length) return;
    const cellEl = event.target?.closest?.('[data-mm-grid-index]');
    const current = cellEl ? Number(cellEl.dataset.mmGridIndex) : rovingIndex;
    let cols = 4;
    if (gridRef.current && typeof window !== 'undefined' && window.getComputedStyle) {
      const tracks = window.getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').filter(Boolean).length;
      if (tracks > 0) cols = tracks;
    }
    const next = nextMasteryGridIndex(current, event.key, visible.length, cols);
    if (next == null) return;
    event.preventDefault();
    setActiveGridIndex(next);
    gridRef.current?.querySelector?.(`[data-mm-grid-index="${next}"]`)?.focus?.();
  };

  const selectChapter = (chapterId, pointId = null) => {
    setSelectedId((prev) => (prev === chapterId && pointId == null ? null : chapterId));
    setFocusedPointId(pointId);
  };

  const headSubtitle = model.basis === 'outline'
    ? joinMeta([
      uiFormat('共 {0} 章', [totals.chaptersCount]),
      uiFormat('{0} 个知识点', [totals.pointsCount]),
      uiFormat('{0} 题', [totals.totalCards]),
      ui('点击任意章节下钻并直接开练或补题'),
    ])
    : joinMeta([
      uiFormat('共 {0} 章', [totals.chaptersCount]),
      uiFormat('{0} 题', [totals.totalCards]),
      ui('点击任意章节查看子主题并直接开练'),
    ]);

  return (
    <div className="mm-root" data-testid="mastery-map" data-mm-basis={model.basis} data-mm-layout={layout}>
      <div className="mm-summary" role="region" aria-label={ui('掌握度与覆盖概览')}>
        <div className="mm-summary__lead">
          <Tooltip layer content={ui(TERMS.mastery.hint)}>
            <div className="mm-summary__score" tabIndex={0}>
              <span className="mm-summary__num" data-mm-overall-mastery="">{totals.overallMastery}</span>
              <span className="mm-summary__unit">%</span>
              <span className="mm-summary__label">{ui(TERMS.mastery.label)}</span>
            </div>
          </Tooltip>
          <span className="mm-summary__bar" aria-hidden="true">
            {totals.masteredCards > 0 && <span className="mm-summary__seg mm-summary__seg--mastered" style={{ flexGrow: totals.masteredCards }} />}
            {totals.familiarCards > 0 && <span className="mm-summary__seg mm-summary__seg--familiar" style={{ flexGrow: totals.familiarCards }} />}
            {totals.learningCards > 0 && <span className="mm-summary__seg mm-summary__seg--learning" style={{ flexGrow: totals.learningCards }} />}
            {totals.weakCards > 0 && <span className="mm-summary__seg mm-summary__seg--weak" style={{ flexGrow: totals.weakCards }} />}
            {totals.newCards > 0 && <span className="mm-summary__seg mm-summary__seg--new" style={{ flexGrow: totals.newCards }} />}
          </span>
          <div className="mm-summary__metrics">
            {model.basis === 'outline' && (
              <span className="mm-summary__metric" data-mm-coverage-ratio="">
                {uiFormat('知识点覆盖 {0}/{1}', [totals.coveredPoints, totals.pointsCount])}
              </span>
            )}
            <span className="mm-summary__metric mm-summary__metric--ok">
              {uiFormat('已掌握与熟悉 {0}', [totals.masteredCards + totals.familiarCards])}
            </span>
            <span className="mm-summary__metric mm-summary__metric--warn">
              {uiFormat('巩固中 {0}', [totals.learningCards])}
            </span>
            <span className="mm-summary__metric mm-summary__metric--bad">
              {uiFormat('薄弱 {0}', [totals.weakCards])}
            </span>
            <span className="mm-summary__metric">
              {uiFormat('到期 {0}', [totals.dueCards])}
            </span>
            {totals.uncoveredPoints > 0 && (
              <span className="mm-summary__metric mm-summary__metric--warn" data-mm-uncovered-count="">
                {uiFormat('尚无题目 {0}', [totals.uncoveredPoints])}
              </span>
            )}
          </div>
        </div>

        <div className="mm-summary__actions">
          {canPracticeWeak && (
            <Button
              size="sm"
              variant="secondary"
              iconEnd="arrow-right"
              lock={busy}
              data-mm-practice-weak=""
              onClick={() => onPracticeWeakAll({ keys: model.weakKeys, scopes: model.weakScopes })}
            >
              {ui('专练薄弱与到期')}
            </Button>
          )}
          {canGapFillAll && (
            <Button
              size="sm"
              variant="quiet"
              iconEnd="arrow-right"
              lock={busy}
              data-mm-gapfill-all=""
              onClick={() => onGoGenerate(model.uncoveredTitles.slice(0, 10))}
            >
              {uiFormat('补出缺口题 ({0})', [model.uncoveredTitles.length])}
            </Button>
          )}
          {totals.weakCards > 0 && onOpenWrongBook && (
            <Button size="sm" variant="link" iconEnd="arrow-right" onClick={onOpenWrongBook}>
              {ui('去错题本')}
            </Button>
          )}
          {model.basis !== 'outline' && model.hasOutlineMaterials && onOpenOutline && (
            <Button size="sm" variant="link" iconEnd="arrow-right" onClick={onOpenOutline}>
              {ui('去总纲整理知识点')}
            </Button>
          )}
        </div>
      </div>

      {coursePace && (
        <PaceMeta
          variant="course"
          forecast={coursePace}
          pace={paceForecast?.pace}
          asOf={paceForecast?.asOf}
          uncoveredPoints={totals.uncoveredPoints}
        />
      )}

      {model.stale && (
        <p className="mm-stale" role="status" data-mm-stale="">
          <span>{ui('课程资料有更新，当前图谱基于上一版总纲；重新整理总纲后可同步最新知识点。')}</span>
          {onOpenOutline && (
            <Button size="sm" variant="link" iconEnd="arrow-right" onClick={onOpenOutline}>
              {ui('打开总纲')}
            </Button>
          )}
        </p>
      )}

      <div className="mm-panel">
        <div className="mm-head">
          <div className="mm-head__copy">
            <h2 className="mm-head__title">{ui('章节与知识点掌握图谱')}</h2>
            <p className="mm-head__sub">{headSubtitle}</p>
          </div>
          <SegmentedControl
            size="sm"
            label={ui('图谱排布')}
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'heatmap', label: ui('热力矩阵') },
              { value: 'spine', label: ui('层级图谱') },
            ]}
          />
        </div>

        <div className="mm-controls">
          <div className="mm-filters" role="group" aria-label={ui('按掌握状态筛选章节')}>
            {filterOptions.map((opt) => (
              <Button
                key={opt.id}
                size="sm"
                variant="secondary"
                className="mm-filter-btn"
                data-mm-filter={opt.id}
                aria-pressed={activeFilter === opt.id}
                onClick={() => { setFilter(opt.id); setShowAll(false); }}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <div className="mm-search-wrap">
            <TextInput
              type="search"
              className="mm-search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setShowAll(false); }}
              onKeyDown={(event) => {
                if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                if (query) {
                  setQuery('');
                  setShowAll(false);
                } else {
                  event.currentTarget?.blur?.();
                }
              }}
              placeholder={ui('搜索章节或知识点…')}
              aria-label={ui('搜索章节或知识点')}
              autoComplete="off"
              spellCheck={false}
            />
            {(query || activeFilter !== 'all') && (
              <Button
                size="sm"
                variant="quiet"
                onClick={() => { setQuery(''); setFilter('all'); }}
              >
                {ui('清除筛选')}
              </Button>
            )}
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="mm-empty" role="status">
            <span>{ui('当前筛选条件下没有匹配的章节或知识点。')}</span>
            <Button size="sm" variant="quiet" onClick={() => { setFilter('all'); setQuery(''); }}>
              {ui('显示全部')}
            </Button>
          </div>
        ) : layout === 'heatmap' ? (
          <div
            ref={gridRef}
            className="mm-grid"
            role="group"
            aria-label={ui('章节掌握热力矩阵')}
            onKeyDown={handleGridKeyDown}
          >
            {visible.map((ch, idx) => {
              const isSelected = selected?.id === ch.id;
              const dots = chapterPreviewDots(ch);
              const cellAria = joinMeta([
                `${formatIndex(ch.index + 1)} ${ch.title}`,
                cellPctText(ch),
                ch.total > 0 ? uiFormat('已学 {0}/{1}', [ch.learned, ch.total]) : '',
                ch.uncoveredPoints > 0 ? uiFormat('缺 {0} 个知识点', [ch.uncoveredPoints]) : '',
                ch.weak > 0 ? uiFormat('薄弱 {0}', [ch.weak]) : '',
              ]);
              return (
                <Button
                  key={ch.id}
                  variant="quiet"
                  className="mm-cell"
                  data-mm-chapter={ch.id}
                  data-mm-grid-index={idx}
                  data-tier={ch.tier}
                  data-selected={isSelected ? 'true' : undefined}
                  aria-pressed={isSelected}
                  aria-label={cellAria}
                  tabIndex={idx === rovingIndex ? 0 : -1}
                  onFocus={() => setActiveGridIndex(idx)}
                  onClick={() => selectChapter(ch.id, null)}
                >
                  <span className="mm-cell__body">
                    <span className="mm-cell__top">
                      <span className="mm-cell__idx">{formatIndex(ch.index + 1)}</span>
                      <span className="mm-cell__pct">{cellPctText(ch)}</span>
                    </span>
                    <span className="mm-cell__title">{ch.title}</span>
                    {dots.length > 0 && (
                      <span className="mm-cell__dots" aria-hidden="true">
                        {dots.map((dot) => (
                          <span key={dot.id} className="mm-dot" data-state={dot.state} />
                        ))}
                      </span>
                    )}
                    <span className="mm-cell__foot">
                      <span>{ch.total > 0 ? `${ch.learned}/${ch.total}` : uiFormat('{0} 点', [ch.points.length])}</span>
                      {ch.weak > 0 ? (
                        <span className="mm-cell__flag--bad">{uiFormat('薄弱 {0}', [ch.weak])}</span>
                      ) : ch.uncoveredPoints > 0 ? (
                        <span className="mm-cell__flag--warn">{uiFormat('缺 {0} 点', [ch.uncoveredPoints])}</span>
                      ) : ch.due > 0 ? (
                        <span>{uiFormat('到期 {0}', [ch.due])}</span>
                      ) : null}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        ) : (
          <ol className="mm-spine" aria-label={ui('章节与知识点层级图谱')}>
            {visible.map((ch) => {
              const isSelected = selected?.id === ch.id;
              const ratio = ch.total > 0 ? Math.max(0, Math.min(1, ch.mastery / 100)) : 0;
              const tone = ch.weak > 0 ? 'weak' : ch.mastery >= 80 ? 'mastered' : 'learning';
              const shownPts = ch.matchedPoints || ch.points || [];
              return (
                <li key={ch.id} className="mm-spine__item" data-mm-spine-chapter={ch.id}>
                  <div className="mm-spine__head">
                    <Button
                      size="sm"
                      variant="quiet"
                      className="mm-spine__chapter-btn"
                      aria-pressed={isSelected}
                      onClick={() => selectChapter(ch.id, null)}
                    >
                      {`${formatIndex(ch.index + 1)} · ${ch.title}`}
                    </Button>
                    <span className="mm-spine__bar-wrap">
                      <span className="mm-spine__track" aria-hidden="true">
                        {ch.total > 0 && (
                          <span
                            className="mm-spine__fill"
                            data-tone={tone}
                            style={{ transform: `scaleX(${ratio})` }}
                          />
                        )}
                      </span>
                      <span>{cellPctText(ch)}</span>
                      <span>{ch.total > 0 ? `${ch.learned}/${ch.total}` : uiFormat('{0} 点', [ch.points.length])}</span>
                    </span>
                  </div>
                  {shownPts.length > 0 && (
                    <div className="mm-spine__points">
                      {shownPts.map((pt) => (
                        <Button
                          key={pt.id}
                          size="sm"
                          variant="quiet"
                          className="mm-pill"
                          data-mm-spine-point={pt.id}
                          data-state={pt.state}
                          data-focused={selected?.id === ch.id && focusedPointId === pt.id ? 'true' : undefined}
                          onClick={() => selectChapter(ch.id, pt.id)}
                        >
                          {pt.total > 0 ? `${pt.title} · ${pt.mastery}%` : pt.title}
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {selected && (
          <ChapterInspector
            key={selected.id}
            chapter={selected}
            basis={model.basis}
            hasBookNotes={model.hasBookNotes}
            activeFilter={activeFilter}
            query={query}
            focusedPointId={focusedPointId}
            onClose={() => { setSelectedId(null); setFocusedPointId(null); }}
            onPracticeChapter={onPracticeChapter}
            onPracticePoint={onPracticePoint}
            onGoGenerate={onGoGenerate}
            onOpenDeck={onOpenDeck}
            onOpenBook={onOpenBook}
          />
        )}

        <div className="mm-foot">
          <div className="mm-legend" aria-hidden="true">
            <span className="mm-legend__scale">
              <span className="mm-swatch" data-tier="gap" />
              <span>{ui('尚无题目')}</span>
            </span>
            <span className="mm-legend__scale">
              <span>{ui('未学')}</span>
              <span className="mm-swatch" data-tier="0" />
              <span className="mm-swatch" data-tier="1" />
              <span className="mm-swatch" data-tier="2" />
              <span className="mm-swatch" data-tier="3" />
              <span className="mm-swatch" data-tier="4" />
              <span>{ui('已掌握')}</span>
            </span>
          </div>

          <div className="mm-summary__actions">
            {model.unplacedTotal > 0 && onOpenOutline && (
              <Button size="sm" variant="link" iconEnd="arrow-right" onClick={onOpenOutline}>
                {uiFormat('另有 {0} 题未归位，去总纲查看', [model.unplacedTotal])}
              </Button>
            )}
            {filtered.length > INITIAL_VISIBLE_CHAPTERS && (
              <Button size="sm" variant="quiet" onClick={() => setShowAll((v) => !v)}>
                {showAll
                  ? uiFormat('只看前 {0} 章', [INITIAL_VISIBLE_CHAPTERS])
                  : uiFormat('展开全部 {0} 章', [filtered.length])}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
