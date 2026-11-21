/* Round completion Carved Cinnabar Seal Press card for Review.jsx (.result-page).
   Derives an honest procedural traditional seal from real session facts, supports 朱文/白文 toggle,
   fires palette-locked CSP-safe confetti ONLY on first allCorrect arrival (>=3 questions) or
   explicit user seal press, and opens the 3D Collectible Postcard Studio & Local Seal Album. */
import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, SegmentedControl, Tooltip } from '../components/index.js';
import { cx } from '../components/css.js';
import { useInjectCss } from '../shared.js';
import { playSound } from '../sound-effects.js';
import InkMark from './InkMark.jsx';
import { buildSealSvg, deriveRoundSeal, svgToDataUri } from './seal-generator.js';
import { fireSealConfetti } from './confetti-burst.js';
import { getConqueredLeechCount, loadSealAlbum } from './seal-storage.js';
import { useSealPalette } from './use-seal-palette.js';
import sealPressCss from './seal-press.css';

const celebratedRuns = new Set();
let studioDialogCache = null;

export default function RoundSealSection({ run, title, course = '', allCorrect = false }) {
  useInjectCss(sealPressCss, 'study-seal-press');
  const cardRef = React.useRef(null);
  const stampBtnRef = React.useRef(null);
  const { palette, reducedMotion } = useSealPalette(cardRef);

  const conqueredCount = getConqueredLeechCount(run?.id);
  const seal = React.useMemo(
    () => deriveRoundSeal(run, { conqueredLeechCount: conqueredCount }),
    [run, conqueredCount],
  );

  const [sealStyle, setSealStyle] = React.useState(seal.defaultStyle);
  const [stampNonce, setStampNonce] = React.useState(0);
  const [studioTab, setStudioTab] = React.useState('');
  const [StudioDialog, setStudioDialog] = React.useState(() => studioDialogCache);
  const [albumCount, setAlbumCount] = React.useState(() => loadSealAlbum().length);

  React.useEffect(() => {
    setSealStyle(seal.defaultStyle);
  }, [run?.id, seal.defaultStyle]);

  React.useEffect(() => {
    if (!studioTab || StudioDialog) return undefined;
    let cancelled = false;
    import('./PostcardStudioDialog.jsx')
      .then((mod) => {
        const Comp = mod?.default || null;
        if (!Comp) return;
        studioDialogCache = Comp;
        if (!cancelled) setStudioDialog(() => Comp);
      })
      .catch(() => {
        if (!cancelled) setStudioTab('');
      });
    return () => { cancelled = true; };
  }, [studioTab, StudioDialog]);

  // Fire palette-locked confetti ONCE on first arrival of a clean sweep (>= 3 questions).
  React.useEffect(() => {
    const runKey = run?.id;
    const total = run?.questions ?? run?.total ?? 0;
    if (!runKey || !allCorrect || total < 3 || run?.mode === 'exam') return;
    if (celebratedRuns.has(runKey)) return;
    celebratedRuns.add(runKey);
    void fireSealConfetti({ anchorEl: stampBtnRef.current || cardRef.current, variant: 'clean-sweep' });
  }, [allCorrect, run?.id, run?.mode, run?.questions, run?.total]);

  if (!run || !run.complete || run.mode === 'exam') return null;

  const sealTitle = ui(seal.titleKey);
  const sealReason = seal.reasonArgs?.length ? uiFormat(seal.reasonKey, seal.reasonArgs) : ui(seal.reasonKey);
  const stampUri = svgToDataUri(buildSealSvg(seal, {
    style: sealStyle,
    size: 96,
    ink: palette.accent,
    paper: palette.paper,
  }));

  const handlePressSeal = () => {
    setStampNonce((n) => n + 1);
    playSound('tap');
    void fireSealConfetti({ anchorEl: stampBtnRef.current, variant: 'stamp' });
  };

  const styleOptions = [
    { value: 'yang', label: ui('朱文') },
    { value: 'yin', label: ui('白文') },
  ];

  return (
    <section
      ref={cardRef}
      className="sh-seal-card sh-paper-card"
      data-seal-id={seal.id}
      data-testid="round-seal-section"
      aria-label={ui('本轮印章与藏书明信片')}
    >
      <Tooltip layer content={ui('点按再盖一次章')}>
        <Button
          ref={stampBtnRef}
          variant="quiet"
          className={cx('sh-seal-press-trigger', stampNonce > 0 && !reducedMotion && 'is-stamping')}
          aria-label={uiFormat('盖章：{0}', [sealTitle])}
          onClick={handlePressSeal}
        >
          <img
            key={`stamp-${seal.id}-${sealStyle}-${stampNonce}`}
            className="sh-seal-stamp-img"
            src={stampUri}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        </Button>
      </Tooltip>

      <div className="sh-seal-card__info">
        <span className="sh-seal-card__kicker">{ui('本轮印记')}</span>
        <div className="sh-seal-card__heading">
          <InkMark type="underline" tone={seal.id === 'clean-sweep' ? 'success' : 'accent'} padding={2} strokeWidth={1.8}>
            <h3 className="sh-seal-card__title">{sealTitle}</h3>
          </InkMark>
        </div>
        <p className="sh-seal-card__reason">{sealReason}</p>
        <div className="sh-seal-card__style-row">
          <SegmentedControl
            size="xs"
            label={ui('印章阴刻或阳刻')}
            value={sealStyle}
            onChange={setSealStyle}
            options={styleOptions}
          />
        </div>
      </div>

      <div className="sh-seal-card__actions">
        <Button size="sm" variant="secondary" icon="sparkle" onClick={() => setStudioTab('studio')}>
          {ui('制作藏书明信片')}
        </Button>
        <Button size="sm" variant="quiet" icon="book" onClick={() => setStudioTab('album')}>
          {albumCount > 0 ? uiFormat('本地印谱 ({0})', [albumCount]) : ui('查看印谱')}
        </Button>
      </div>

      {studioTab && StudioDialog && (
        <StudioDialog
          run={run}
          title={title}
          course={course}
          seal={seal}
          initialSealStyle={sealStyle}
          initialTab={studioTab}
          onAlbumChange={setAlbumCount}
          onClose={() => setStudioTab('')}
        />
      )}
    </section>
  );
}
