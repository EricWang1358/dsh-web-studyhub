/* Browsable Local Seal Album inside the Postcard Studio dialog.
   Displays up to 60 saved collectible postcards with 3D tilt preview, SVG/2x PNG export,
   and safe inline delete confirmation (never window.confirm). */
import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import PostcardTilt from './PostcardTilt.jsx';
import { buildSealSvg, SEAL_CATALOG } from './seal-generator.js';
import { buildPostcardSvg, exportPostcardPng, exportPostcardSvg, POSTCARD_EDITIONS, svgToDataUri } from './postcard-svg.js';
import studioCss from './postcard-studio.css';

function editionLabel(editionId) {
  const found = POSTCARD_EDITIONS.find((item) => item.id === editionId);
  return ui(found ? found.labelKey : '活字藏书票');
}

function sealTitleFor(entry) {
  const catalog = SEAL_CATALOG[entry?.sealId] || SEAL_CATALOG['round-done'];
  return ui(catalog.titleKey);
}

function sealEmblemFor(entry) {
  const catalog = SEAL_CATALOG[entry?.sealId] || SEAL_CATALOG['round-done'];
  return catalog.englishEmblem;
}

export default function SealAlbumView({ entries = [], palette, reducedMotion = false, onRemove, onGoStudio }) {
  useInjectCss(studioCss, 'study-seal-press-studio');
  const [selectedId, setSelectedId] = React.useState(() => entries[0]?.id || '');
  const [confirmRemoveId, setConfirmRemoveId] = React.useState('');
  const [exportingPng, setExportingPng] = React.useState(false);
  const [notice, setNotice] = React.useState('');

  const active = entries.find((item) => item.id === selectedId) || entries[0] || null;
  const activeId = active?.id || '';

  React.useEffect(() => {
    setConfirmRemoveId('');
    setNotice('');
  }, [activeId]);

  if (!entries.length) {
    return (
      <div className="sh-seal-album__empty" data-testid="seal-album-empty">
        <p className="sh-seal-album__empty-title">{ui('印谱里还没有收藏')}</p>
        <p className="sh-seal-album__empty-body">
          {ui('切回「制卡印制」，选一款藏书票或书签版式存进本地印谱，以后随时可以翻看或导出。')}
        </p>
        {onGoStudio && (
          <Button size="sm" variant="secondary" iconEnd="arrow-right" onClick={onGoStudio}>
            {ui('去制作一张明信片')}
          </Button>
        )}
      </div>
    );
  }

  const labels = {
    ariaLabel: uiFormat('{0} · {1}', [active.title, editionLabel(active.edition)]),
    sealTitle: sealTitleFor(active),
    sealReason: active.note || uiFormat('本轮正确率 {0}%', [active.accuracy]),
    sealEmblem: sealEmblemFor(active),
    scoreCaption: ui('本轮成绩'),
    accuracyCaption: ui('正确率'),
  };
  const { svg } = buildPostcardSvg(active, { palette, labels });
  const previewUri = svgToDataUri(svg);

  const handleExportSvg = () => {
    exportPostcardSvg(active, { palette, labels });
    setNotice(ui('已开始下载 SVG 文件'));
  };

  const handleExportPng = async () => {
    setExportingPng(true);
    setNotice('');
    try {
      const ok = await exportPostcardPng(active, { palette, labels, scale: 2 });
      setNotice(ok ? ui('已开始下载 2x 高清 PNG') : ui('当前环境未能生成 PNG，可改用导出 SVG。'));
    } catch {
      setNotice(ui('当前环境未能生成 PNG，可改用导出 SVG。'));
    } finally {
      setExportingPng(false);
    }
  };

  return (
    <div className="sh-seal-album" data-testid="seal-album-view">
      <div className="sh-seal-album__feature">
        <PostcardTilt reducedMotion={reducedMotion} edition={active.edition}>
          <img
            className="sh-postcard-stage__img"
            src={previewUri}
            alt={labels.ariaLabel}
            draggable={false}
          />
        </PostcardTilt>
        <div className="sh-seal-album__toolbar">
          <span className="sh-seal-album__meta">
            {uiFormat('{0} · {1} · {2}/{3}', [active.dateLabel || '', editionLabel(active.edition), active.correct, active.answered || active.total])}
          </span>
          <div className="sh-seal-studio__actions">
            <Button size="sm" variant="secondary" icon="download" onClick={handleExportSvg}>
              {ui('导出 SVG')}
            </Button>
            <Button size="sm" variant="secondary" icon="download" busy={exportingPng} onClick={handleExportPng}>
              {ui('导出高清 PNG')}
            </Button>
            {confirmRemoveId === active.id ? (
              <>
                <Button size="sm" variant="danger" onClick={() => { onRemove?.(active.id); setConfirmRemoveId(''); }}>
                  {ui('确认移出印谱')}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => setConfirmRemoveId('')}>
                  {ui('取消')}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="quiet" icon="trash" onClick={() => setConfirmRemoveId(active.id)}>
                {ui('移出印谱')}
              </Button>
            )}
          </div>
        </div>
        {notice && <span className="sh-seal-studio__status" role="status">{notice}</span>}
      </div>

      <ul className="sh-seal-album__grid" aria-label={ui('已收藏的明信片')}>
        {entries.map((item) => {
          const isCurrent = item.id === active.id;
          const thumbUri = svgToDataUri(buildSealSvg(
            { id: item.sealId, chars: item.sealChars, seed: item.seed, defaultStyle: item.sealStyle },
            { style: item.sealStyle, size: 44, ink: palette.accent, paper: palette.paper },
          ));
          return (
            <li key={item.id}>
              <Button
                variant="quiet"
                align="start"
                className="sh-seal-album__item-btn"
                aria-pressed={isCurrent}
                onClick={() => setSelectedId(item.id)}
              >
                <img className="sh-seal-album__thumb" src={thumbUri} alt="" aria-hidden="true" draggable={false} />
                <span className="sh-seal-album__item-text">
                  <span className="sh-seal-album__item-title">{item.title}</span>
                  <span className="sh-seal-album__item-sub">
                    {item.dateLabel} · {item.accuracy}% · {editionLabel(item.edition)}
                  </span>
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
