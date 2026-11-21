import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { useStudyBusy } from '../study-context.jsx';
import { usePersistentState } from '../storage.js';
import { FullscreenButton, useCanvasFullscreen } from '../canvas/index.js';
import { Badge, Button, CloseButton, DisclosureToggle, SegmentedControl, foldLabel, useToast } from '../components/index.js';
import { cx } from '../components/css.js';
import css from './ink-garden.css';
import { normalizeGardenData, round1, useGardenPalette } from './seed-prng.js';
import { PLATE_HEIGHT, PLATE_WIDTH, buildHerbariumScene } from './herbarium-svg.js';
import { buildShanshuiScene } from './shanshui-svg.js';
import { buildAstrolabeScene } from './astrolabe-svg.js';
import { buildPosterFilename, exportPlatePng, exportPlateSvg } from './export-poster.js';

export const EDITIONS = Object.freeze(['herbarium', 'shanshui', 'astrolabe']);

const EDITION_KEY = 'study-ink-garden:edition';
const OPEN_KEY = 'study-ink-garden:open';

let roughLoaderPromise = null;
function loadRoughGenerator() {
  if (!roughLoaderPromise) {
    roughLoaderPromise = import('roughjs')
      .then((mod) => {
        const rough = mod?.default || mod;
        return typeof rough?.generator === 'function' ? rough.generator() : null;
      })
      .catch(() => null);
  }
  return roughLoaderPromise;
}

function stageLabel(stage) {
  switch (stage) {
    case 'mastered': return ui('已掌握');
    case 'learning': return ui('学习中');
    case 'weak': return ui('薄弱');
    default: return ui('未学');
  }
}

function stageTone(stage) {
  switch (stage) {
    case 'mastered': return 'success';
    case 'learning': return 'warning';
    case 'weak': return 'error';
    default: return 'neutral';
  }
}

function editionLabel(edition) {
  switch (edition) {
    case 'shanshui': return ui('千里山水卷');
    case 'astrolabe': return ui('铜版星象图');
    default: return ui('墨梅标本志');
  }
}

function editionPlateHeading(edition) {
  switch (edition) {
    case 'shanshui': return ui('第二卷 · 千里山水卷');
    case 'astrolabe': return ui('第三卷 · 铜版星象图');
    default: return ui('第一卷 · 墨梅标本志');
  }
}

function emptyEditionWhisper(edition) {
  switch (edition) {
    case 'shanshui': return ui('烟水初平，一舟待发');
    case 'astrolabe': return ui('星盘已刻，待点第一颗星');
    default: return ui('一枝初备，待你落笔');
  }
}

function StrokeList({ paths, prefix }) {
  return paths.map((p, idx) => (
    <path
      key={`${prefix}-${idx}`}
      d={p.d}
      stroke={p.stroke}
      strokeWidth={p.strokeWidth}
      fill={p.fill || 'none'}
      fillOpacity={p.fillOpacity}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={p.opacity}
    />
  ));
}

function DeckNodeGroup({ node, selected, onHover, onSelect }) {
  const { item, x, y, hitRadius, strokes } = node;
  const label = item.due > 0
    ? uiFormat('{0}，{1}，掌握进度 {2}%，待复习 {3} 题', [item.shortTitle, stageLabel(item.stage), item.mastery, item.due])
    : uiFormat('{0}，{1}，掌握进度 {2}%', [item.shortTitle, stageLabel(item.stage), item.mastery]);

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(item.id);
    }
  };

  return (
    <g
      className={cx('ink-garden__node', selected && 'is-selected')}
      role="button"
      tabIndex={0}
      data-deck-id={item.id}
      data-stage={item.stage}
      aria-label={label}
      aria-pressed={selected}
      onMouseEnter={() => onHover(item.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(item.id)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(item.id)}
      onKeyDown={handleKeyDown}
    >
      <circle className="ink-garden__node-hit" cx={x} cy={y} r={hitRadius} />
      <circle
        className="ink-garden__node-ring"
        data-export-omit="true"
        cx={x}
        cy={y}
        r={hitRadius - 2}
      />
      <StrokeList paths={strokes} prefix={`node-${item.id}`} />
    </g>
  );
}

function ActiveNodeLabel({ node, palette }) {
  if (!node) return null;
  const text = node.item.shortTitle.length > 22
    ? `${node.item.shortTitle.slice(0, 21)}…`
    : node.item.shortTitle;
  const nearRight = node.x > PLATE_WIDTH - 190;
  const nearLeft = node.x < 170;
  const anchor = nearRight ? 'end' : nearLeft ? 'start' : 'middle';
  const tx = round1(nearRight ? node.x - 16 : nearLeft ? node.x + 16 : node.x);
  const ty = round1(node.y < 86 ? node.y + node.hitRadius + 16 : node.y - node.hitRadius - 8);
  return (
    <text
      className="ink-garden__node-tag"
      data-export-omit="true"
      x={tx}
      y={ty}
      textAnchor={anchor}
      fill={palette.ink}
    >
      {text}
    </text>
  );
}

function HerbariumArtwork({ scene, palette }) {
  return (
    <>
      <StrokeList paths={scene.guidePaths} prefix="herb-guide" />
      <StrokeList paths={scene.branchPaths} prefix="herb-branch" />
      <StrokeList paths={scene.emptyBuds} prefix="herb-empty-bud" />
      <StrokeList paths={scene.framePaths} prefix="herb-frame" />
      <g className="ink-garden__seal" aria-hidden="true">
        <StrokeList paths={scene.sealPaths} prefix="herb-seal" />
        {scene.sealPetals.map((p, idx) => (
          <circle key={`seal-p-${idx}`} cx={p.cx} cy={p.cy} r={p.r} fill={palette.accent} opacity={0.84} />
        ))}
        <circle cx={scene.sealCenter.x} cy={scene.sealCenter.y} r={1.8} fill={palette.paper} opacity={0.95} />
      </g>
    </>
  );
}

function ShanshuiArtwork({ scene, palette, mistGradId }) {
  return (
    <>
      <defs>
        <linearGradient id={mistGradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.paper} stopOpacity="0" />
          <stop offset="50%" stopColor={palette.paper} stopOpacity="0.88" />
          <stop offset="100%" stopColor={palette.paper} stopOpacity="0" />
        </linearGradient>
      </defs>
      <StrokeList paths={scene.sunPaths} prefix="ss-sun" />
      {scene.ranges.map((range, idx) => (
        <React.Fragment key={range.id}>
          <path d={range.fillD} fill={range.fill} fillOpacity={range.opacity} stroke="none" />
          {scene.mistBands[idx] && (
            <rect
              x={scene.mistBands[idx].x}
              y={scene.mistBands[idx].y}
              width={scene.mistBands[idx].width}
              height={scene.mistBands[idx].height}
              fill={`url(#${mistGradId})`}
              opacity={scene.mistBands[idx].opacity}
            />
          )}
        </React.Fragment>
      ))}
      <StrokeList paths={scene.ridgeOutlines} prefix="ss-ridge" />
      <StrokeList paths={scene.cunfaPaths} prefix="ss-cunfa" />
      <StrokeList paths={scene.riverPaths} prefix="ss-river" />
      <StrokeList paths={scene.pavilionPaths} prefix="ss-pavilion" />
      <StrokeList paths={scene.boatPaths} prefix="ss-boat" />
      <StrokeList paths={scene.framePaths} prefix="ss-frame" />
      <g className="ink-garden__seal" aria-hidden="true">
        <StrokeList paths={scene.sealPaths} prefix="ss-seal" />
      </g>
    </>
  );
}

function AstrolabeArtwork({ scene, palette }) {
  return (
    <>
      <g aria-hidden="true">
        {scene.dustDots.map((dot, idx) => (
          <circle key={`astro-dust-${idx}`} cx={dot.cx} cy={dot.cy} r={dot.r} fill={palette.inkMuted} opacity={dot.opacity} />
        ))}
      </g>
      <StrokeList paths={scene.meridianPaths} prefix="astro-meridian" />
      <StrokeList paths={scene.ringPaths} prefix="astro-ring" />
      <StrokeList paths={scene.tickPaths} prefix="astro-tick" />
      <StrokeList paths={scene.corePaths} prefix="astro-core" />
      <StrokeList paths={scene.filamentPaths} prefix="astro-filament" />
      <StrokeList paths={scene.framePaths} prefix="astro-frame" />
      <g className="ink-garden__seal" aria-hidden="true">
        <StrokeList paths={scene.sealPaths} prefix="astro-seal" />
      </g>
    </>
  );
}

function SpecimenInspector({ item, onStartScope, onClose }) {
  const busy = useStudyBusy();
  if (!item) return null;
  const metaParts = [
    uiFormat('掌握进度 {0}% · 共 {1} 题', [item.mastery, item.total]),
    ...(item.due > 0 ? [uiFormat('待复习 {0} 题', [item.due])] : []),
    ...(item.weakTopics.length > 0
      ? [uiFormat('需补强主题：{0}', [item.weakTopics.slice(0, 2).map((t) => t.topic).filter(Boolean).join('、')])]
      : []),
  ];

  return (
    <div className="ink-garden__inspector" data-testid="ink-garden-inspector" data-deck-id={item.id}>
      <div className="ink-garden__inspector-main">
        <div className="ink-garden__inspector-head">
          <h4 className="ink-garden__inspector-title">{item.title}</h4>
          <Badge size="sm" tone={stageTone(item.stage)} dot>{stageLabel(item.stage)}</Badge>
        </div>
        <p className="ink-garden__inspector-meta">{metaParts.join(' · ')}</p>
      </div>
      <div className="ink-garden__inspector-actions">
        {onStartScope && item.weakCards.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            iconEnd="arrow-right"
            lock={busy}
            onClick={() => onStartScope(item.weakCards)}
          >
            {ui('先练薄弱题')}
          </Button>
        )}
        {onStartScope && (
          <Button
            variant="primary"
            size="sm"
            iconEnd="arrow-right"
            lock={busy}
            onClick={() => onStartScope(item.scope)}
          >
            {ui('练这组题')}
          </Button>
        )}
        <CloseButton size="sm" label={ui('关闭题组详情')} onClick={onClose} />
      </div>
    </div>
  );
}

/**
 * Living Ink Gallery (手绘墨韵标本馆): three live generative ink print editions
 * driven by real study decks, mastery progress, and heatmap cadence.
 */
export default function InkGardenSection({
  stats,
  decks = [],
  progress = null,
  course = '*',
  onStartScope,
  defaultEdition = 'herbarium',
  defaultOpen = true,
  roughGenerator = null,
}) {
  useInjectCss(css, 'study-ink-garden');
  const busy = useStudyBusy();
  const toast = useToast();
  const fullscreen = useCanvasFullscreen();
  const svgRef = useRef(null);
  const bodyId = useId();
  const titleId = useId();
  const descId = useId();
  const mistGradId = useId();

  const parseEdition = useCallback((raw) => {
    try {
      const parsed = JSON.parse(raw);
      return EDITIONS.includes(parsed) ? parsed : undefined;
    } catch {
      return EDITIONS.includes(raw) ? raw : undefined;
    }
  }, []);

  const [edition, setEdition] = usePersistentState(
    EDITION_KEY,
    EDITIONS.includes(defaultEdition) ? defaultEdition : 'herbarium',
    { parse: parseEdition },
  );
  const [open, setOpen] = usePersistentState(OPEN_KEY, defaultOpen);
  const [loadedRough, setLoadedRough] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [exportingPng, setExportingPng] = useState(false);

  const activeRough = roughGenerator || loadedRough;
  const palette = useGardenPalette(fullscreen.ref);

  useLiveEffect((isLive) => {
    if (roughGenerator || !open) return;
    loadRoughGenerator().then((gen) => {
      if (isLive() && gen) setLoadedRough(gen);
    });
  }, [roughGenerator, open]);

  const garden = useMemo(
    () => normalizeGardenData({ stats, decks, progress, course }),
    [stats, decks, progress, course],
  );

  const scene = useMemo(() => {
    if (edition === 'shanshui') return buildShanshuiScene(garden, palette, activeRough);
    if (edition === 'astrolabe') return buildAstrolabeScene(garden, palette, activeRough);
    return buildHerbariumScene(garden, palette, activeRough);
  }, [edition, garden, palette, activeRough]);

  const nodeById = useMemo(
    () => new Map(scene.nodes.map((n) => [n.id, n])),
    [scene.nodes],
  );

  const selectedNode = selectedId ? (nodeById.get(selectedId) || null) : null;
  const hoveredNode = hoveredId ? (nodeById.get(hoveredId) || null) : null;
  const focusedNode = hoveredNode || selectedNode;

  const handlePractice = useCallback((scope) => {
    if (busy || !onStartScope || !Array.isArray(scope) || !scope.length) return;
    if (fullscreen.full) fullscreen.exit();
    onStartScope(scope.slice(0, 200));
  }, [busy, onStartScope, fullscreen]);

  const handleToggleFullscreen = useCallback(() => {
    if (!open) setOpen(true);
    fullscreen.toggle();
  }, [open, setOpen, fullscreen]);

  const handleExportSvg = useCallback(() => {
    const ok = exportPlateSvg(
      svgRef.current,
      buildPosterFilename(edition, 'svg', garden.today),
      { palette, width: PLATE_WIDTH, height: PLATE_HEIGHT },
    );
    if (ok) toast.success(ui('已导出 SVG 画卷。'));
    else toast.error(ui('导出图片未成功，请重试。'));
  }, [edition, garden.today, palette, toast]);

  const handleExportPng = useCallback(async () => {
    if (exportingPng) return;
    setExportingPng(true);
    try {
      const ok = await exportPlatePng(
        svgRef.current,
        buildPosterFilename(edition, 'png', garden.today),
        { palette, width: PLATE_WIDTH, height: PLATE_HEIGHT, scale: 2 },
      );
      if (ok) toast.success(ui('已导出高清 PNG 海报。'));
      else toast.error(ui('导出图片未成功，请重试。'));
    } catch {
      toast.error(ui('导出图片未成功，请重试。'));
    } finally {
      setExportingPng(false);
    }
  }, [edition, exportingPng, garden.today, palette, toast]);

  const subtitle = garden.totals.deckCount > 0
    ? [
      uiFormat('{0} 个题组', [garden.totals.deckCount]),
      uiFormat('整体掌握 {0}%', [garden.totals.overallMastery]),
      ...(garden.totals.due > 0 ? [uiFormat('待复习 {0} 题', [garden.totals.due])] : []),
    ].join(' · ')
    : ui('素纸待墨，完成第一组练习后这里会慢慢长出花枝与山峦。');

  const captionText = focusedNode
    ? (focusedNode.item.due > 0
      ? uiFormat('{0} · 掌握 {1}% · 待复习 {2} 题', [focusedNode.item.shortTitle, focusedNode.item.mastery, focusedNode.item.due])
      : uiFormat('{0} · 掌握 {1}% · {2}', [focusedNode.item.shortTitle, focusedNode.item.mastery, stageLabel(focusedNode.item.stage)]))
    : garden.items.length > 0
      ? ui('点选画中的花枝、山峰或星点，查看对应题组并直接开练。')
      : emptyEditionWhisper(edition);

  const editionOptions = [
    { value: 'herbarium', label: ui('墨梅标本志') },
    { value: 'shanshui', label: ui('千里山水卷') },
    { value: 'astrolabe', label: ui('铜版星象图') },
  ];

  return (
    <section
      ref={fullscreen.ref}
      className={cx('ink-garden', !open && 'is-collapsed', fullscreen.full && 'is-expanded', fullscreen.className)}
      data-edition={edition}
      data-testid="ink-garden-section"
      aria-label={ui('手绘墨韵标本馆')}
      onKeyDown={(event) => fullscreen.onEscape(event)}
    >
      <div className="ink-garden__head">
        <div className="ink-garden__title-group">
          {!fullscreen.full && (
            <DisclosureToggle
              open={open}
              onToggle={setOpen}
              label={foldLabel(open, ui('手绘墨韵标本馆'))}
              controls={bodyId}
            />
          )}
          <div className="ink-garden__heading">
            <div className="ink-garden__title-row">
              <h2 className="ink-garden__title">{ui('手绘墨韵标本馆')}</h2>
            </div>
            <p className="ink-garden__subtitle">{subtitle}</p>
          </div>
        </div>

        <div className="ink-garden__controls">
          {open && (
            <SegmentedControl
              size="sm"
              label={ui('画卷版本')}
              value={edition}
              onChange={(next) => { setEdition(next); setHoveredId(null); }}
              options={editionOptions}
            />
          )}
          {open && (
            <div className="ink-garden__actions">
              <Button variant="quiet" size="sm" icon="download" onClick={handleExportSvg}>
                {ui('导出 SVG')}
              </Button>
              <Button
                variant="quiet"
                size="sm"
                icon="download"
                busy={exportingPng}
                busyLabel={ui('导出中…')}
                onClick={handleExportPng}
              >
                {ui('导出高清 PNG')}
              </Button>
              <FullscreenButton
                full={fullscreen.full}
                variant="quiet"
                icon="fit"
                onToggle={handleToggleFullscreen}
              />
            </div>
          )}
        </div>
      </div>

      {open && (
        <div id={bodyId} className="ink-garden__body">
          <div className="ink-garden__stage">
            <svg
              ref={svgRef}
              className="ink-garden__svg"
              role="group"
              viewBox={`0 0 ${PLATE_WIDTH} ${PLATE_HEIGHT}`}
              aria-labelledby={`${titleId} ${descId}`}
              onMouseLeave={() => setHoveredId(null)}
            >
              <title id={titleId}>{uiFormat('手绘墨韵标本馆：{0}', [editionLabel(edition)])}</title>
              <desc id={descId}>{ui('根据你的题组掌握进度与学习节奏实时绘制的手绘版画。')}</desc>

              <rect x={0} y={0} width={PLATE_WIDTH} height={PLATE_HEIGHT} fill={palette.paper} />

              {edition === 'herbarium' && <HerbariumArtwork scene={scene} palette={palette} />}
              {edition === 'shanshui' && <ShanshuiArtwork scene={scene} palette={palette} mistGradId={mistGradId} />}
              {edition === 'astrolabe' && <AstrolabeArtwork scene={scene} palette={palette} />}

              <text className="ink-garden__plate-label" x={46} y={54} fill={palette.inkFaint}>
                {editionPlateHeading(edition)}
              </text>

              {garden.isEmpty && (
                <text className="ink-garden__plate-note" x={46} y={PLATE_HEIGHT - 44} fill={palette.inkMuted}>
                  {emptyEditionWhisper(edition)}
                </text>
              )}

              {scene.nodes.map((node) => (
                <DeckNodeGroup
                  key={node.id}
                  node={node}
                  selected={selectedId === node.id}
                  onHover={setHoveredId}
                  onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
                />
              ))}

              <ActiveNodeLabel node={focusedNode} palette={palette} />
            </svg>
          </div>

          <div className="ink-garden__bar">
            <p className="ink-garden__caption" aria-live="polite" data-testid="ink-garden-caption">
              {captionText}
            </p>
            <ul className="ink-garden__legend">
              <li className="ink-garden__legend-item">
                <span className="ink-garden__swatch ink-garden__swatch--mastered" aria-hidden="true" />
                <span>{ui('已掌握')}</span>
              </li>
              <li className="ink-garden__legend-item">
                <span className="ink-garden__swatch ink-garden__swatch--learning" aria-hidden="true" />
                <span>{ui('学习中')}</span>
              </li>
              <li className="ink-garden__legend-item">
                <span className="ink-garden__swatch ink-garden__swatch--weak" aria-hidden="true" />
                <span>{ui('薄弱')}</span>
              </li>
              <li className="ink-garden__legend-item">
                <span className="ink-garden__swatch ink-garden__swatch--fresh" aria-hidden="true" />
                <span>{ui('未学')}</span>
              </li>
            </ul>
          </div>

          {selectedNode && (
            <SpecimenInspector
              item={selectedNode.item}
              onStartScope={onStartScope ? handlePractice : undefined}
              onClose={() => setSelectedId(null)}
            />
          )}

          {garden.items.length > 0 && (
            <table className="sh-visually-hidden">
              <caption>{uiFormat('手绘墨韵标本馆：{0}', [editionLabel(edition)])}</caption>
              <tbody>
                <tr>
                  <th scope="col">{ui('题组')}</th>
                  <th scope="col">{ui('状态')}</th>
                  <th scope="col">{ui('掌握进度')}</th>
                  <th scope="col">{ui('待复习')}</th>
                </tr>
                {garden.items.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">{item.title}</th>
                    <td>{stageLabel(item.stage)}</td>
                    <td>{item.mastery}%</td>
                    <td>{item.due}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
