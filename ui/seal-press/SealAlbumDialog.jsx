/* Standalone Cross-Surface Seal Album Gallery Dialog (藏书印谱馆).
   Reuses Wave 1 SealAlbumView, seal-storage, seal-generator, use-seal-palette, and postcard-studio.css,
   adding the 5-Seal Specimen Shelf (全胜/破顽/夜读/精进/笃行) and clickable seal filter chips. */
import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Chip, Dialog } from '../components/index.js';
import { cx } from '../components/css.js';
import { useInjectCss } from '../shared.js';
import SealAlbumView from './SealAlbumView.jsx';
import { buildSealSvg, escapeXml, hashSeed, SEAL_CATALOG, SPECIMEN_SEALS, svgToDataUri } from './seal-generator.js';
import { loadSealAlbum, removeSealAlbumEntry } from './seal-storage.js';
import { useSealPalette } from './use-seal-palette.js';
import studioCss from './postcard-studio.css';

const SILHOUETTE_FONT = "'Songti SC', 'Noto Serif SC', 'Source Han Serif SC', 'KaiTi', 'STKaiti', Georgia, serif";

/** Faint archaic glyph silhouette SVG encoded as a CSP-safe data URI (keeps English HTML Han-free). */
function buildSilhouetteUri(chars, inkColor) {
  const first = escapeXml(chars?.[0] || '笃');
  const second = escapeXml(chars?.[1] || '行');
  const color = escapeXml(inkColor || '#7a7267');
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="44" height="44" aria-hidden="true">',
    `<line x1="60" y1="20" x2="60" y2="100" stroke="${color}" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.45" />`,
    `<g fill="${color}" font-family="${escapeXml(SILHOUETTE_FONT)}" font-weight="700" text-anchor="middle" opacity="0.65">`,
    `<text x="82" y="65" font-size="38" transform="translate(82 60) scale(0.86 1.2) translate(-82 -60)">${first}</text>`,
    `<text x="38" y="65" font-size="38" transform="translate(38 60) scale(0.86 1.2) translate(-38 -60)">${second}</text>`,
    '</g></svg>',
  ].join('');
  return svgToDataUri(svg);
}

export default function SealAlbumDialog({ entries: entriesProp, onAlbumChange, onClose }) {
  useInjectCss(studioCss, 'study-seal-press-studio');
  const rootRef = React.useRef(null);
  const { palette, reducedMotion } = useSealPalette(rootRef);
  const [entries, setEntries] = React.useState(() => (Array.isArray(entriesProp) ? entriesProp : loadSealAlbum()));
  const [sealFilter, setSealFilter] = React.useState('all');

  const countsBySeal = React.useMemo(() => {
    const map = new Map();
    for (const item of entries) {
      map.set(item.sealId, (map.get(item.sealId) || 0) + 1);
    }
    return map;
  }, [entries]);

  const earnedSpecimenCount = React.useMemo(
    () => SPECIMEN_SEALS.reduce((sum, spec) => sum + ((countsBySeal.get(spec.id) || 0) > 0 ? 1 : 0), 0),
    [countsBySeal],
  );

  const hasClearancePostcard = (countsBySeal.get('wrongbook-cleared') || 0) > 0;
  const visibleEntries = React.useMemo(
    () => (sealFilter === 'all' ? entries : entries.filter((item) => item.sealId === sealFilter)),
    [entries, sealFilter],
  );

  const handleRemove = (id) => {
    const next = removeSealAlbumEntry(id);
    setEntries(next);
    onAlbumChange?.(next.length);
  };

  const selectedSpec = SPECIMEN_SEALS.find((spec) => spec.id === sealFilter) || null;
  const selectedCatalog = SEAL_CATALOG[sealFilter] || null;

  return (
    <Dialog
      size="lg"
      title={ui('藏书印谱馆')}
      description={ui('收录每一轮留下的朱砂印记与藏书明信片；点按印章可筛选对应的收藏。')}
      onClose={onClose}
    >
      <div ref={rootRef} className="sh-seal-gallery" data-testid="seal-album-dialog">
        <section className="sh-seal-shelf" aria-label={ui('五方传统印谱')} data-testid="seal-specimen-shelf">
          <div className="sh-seal-shelf__head">
            <h3 className="sh-seal-shelf__title">{ui('五方传统印谱')}</h3>
            <span className="sh-seal-shelf__progress">
              {earnedSpecimenCount >= SPECIMEN_SEALS.length
                ? ui('五方印记已全部点亮')
                : uiFormat('已集齐 {0} / 5 方', [earnedSpecimenCount])}
            </span>
          </div>

          <ul className="sh-seal-shelf__grid">
            {SPECIMEN_SEALS.map((spec) => {
              const catalog = SEAL_CATALOG[spec.id];
              const count = countsBySeal.get(spec.id) || 0;
              const earned = count > 0;
              const active = sealFilter === spec.id;
              const sealUri = earned
                ? svgToDataUri(buildSealSvg(
                  { id: catalog.id, chars: catalog.chars, seed: hashSeed(catalog.id), defaultStyle: catalog.defaultStyle },
                  { style: catalog.defaultStyle, size: 44, ink: palette.accent, paper: palette.paper },
                ))
                : buildSilhouetteUri(catalog.chars, palette.textMuted);

              return (
                <li key={spec.id}>
                  <Button
                    variant="quiet"
                    className={cx('sh-seal-shelf__card', earned ? 'is-earned' : 'is-unearned')}
                    aria-pressed={active}
                    data-seal-specimen={spec.id}
                    data-earned={earned ? 'true' : 'false'}
                    onClick={() => setSealFilter((prev) => (prev === spec.id ? 'all' : spec.id))}
                  >
                    <span className={earned ? 'sh-seal-shelf__seal-wrap' : 'sh-seal-shelf__silhouette'} aria-hidden="true">
                      <img className="sh-seal-shelf__img" src={sealUri} alt="" aria-hidden="true" draggable={false} />
                    </span>
                    <span className="sh-seal-shelf__name">{ui(catalog.titleKey)}</span>
                    {earned ? (
                      <Badge size="sm" tone="accent">{uiFormat('{0} 张', [count])}</Badge>
                    ) : (
                      <span className="sh-seal-shelf__hint">{ui(spec.hintKey)}</span>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>

        <div className="sh-seal-gallery__filters" role="group" aria-label={ui('按印章筛选收藏')} data-testid="seal-album-filters">
          <Chip size="sm" selected={sealFilter === 'all'} onClick={() => setSealFilter('all')}>
            {uiFormat('全部收藏 ({0})', [entries.length])}
          </Chip>
          {SPECIMEN_SEALS.map((spec) => {
            const catalog = SEAL_CATALOG[spec.id];
            const count = countsBySeal.get(spec.id) || 0;
            const label = ui(catalog.titleKey);
            return (
              <Chip
                key={spec.id}
                size="sm"
                tone={count > 0 ? 'accent' : 'neutral'}
                selected={sealFilter === spec.id}
                onClick={() => setSealFilter(spec.id)}
              >
                {count > 0 ? `${label} (${count})` : label}
              </Chip>
            );
          })}
          {hasClearancePostcard && (
            <Chip
              size="sm"
              tone="success"
              selected={sealFilter === 'wrongbook-cleared'}
              onClick={() => setSealFilter('wrongbook-cleared')}
            >
              {`${ui(SEAL_CATALOG['wrongbook-cleared'].titleKey)} (${countsBySeal.get('wrongbook-cleared')})`}
            </Chip>
          )}
        </div>

        {!entries.length ? (
          <div className="sh-seal-album__empty" data-testid="seal-gallery-empty">
            <p className="sh-seal-album__empty-title">{ui('印谱里还没有收藏')}</p>
            <p className="sh-seal-album__empty-body">
              {ui('完成一轮练习或在错题本清零后，可以把纪念明信片存进这里，随时翻看或导出。')}
            </p>
          </div>
        ) : !visibleEntries.length ? (
          <div className="sh-seal-album__empty" data-testid="seal-gallery-filter-empty">
            <p className="sh-seal-album__empty-title">
              {selectedCatalog ? ui(selectedCatalog.titleKey) : ui('印谱里还没有收藏')}
            </p>
            <p className="sh-seal-album__empty-body">
              {selectedSpec && selectedCatalog
                ? uiFormat('「{0}」还没有收藏卡片，{1}后便可在制卡台收进印谱。', [ui(selectedCatalog.titleKey), ui(selectedSpec.hintKey)])
                : ui('完成一轮练习或在错题本清零后，可以把纪念明信片存进这里，随时翻看或导出。')}
            </p>
            <Button size="sm" variant="secondary" onClick={() => setSealFilter('all')}>
              {ui('查看全部收藏')}
            </Button>
          </div>
        ) : (
          <SealAlbumView
            entries={visibleEntries}
            palette={palette}
            reducedMotion={reducedMotion}
            onRemove={handleRemove}
          />
        )}
      </div>
    </Dialog>
  );
}
