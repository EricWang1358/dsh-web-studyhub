/* WrongBook Cleared-Ledger Carved Seal (错题清零) & Commemorative Postcard Trigger.
   Renders a dignified 4-character carved vermilion seal, a rough-notation InkMark underline,
   optional one-time palette-locked confetti under data-motion="full" only, and 1-click triggers
   into PostcardStudioDialog (pre-filled with the cleared count) and SealAlbumDialog. */
import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { cx } from '../components/css.js';
import { useInjectCss } from '../shared.js';
import { playSound } from '../sound-effects.js';
import { useLiveEffect } from '../use-async.js';
import InkMark from './InkMark.jsx';
import { fireSealConfetti } from './confetti-burst.js';
import { findStudyRoot, prefersReducedMotion } from './palette.js';
import { buildSealSvg, deriveWrongBookClearSeal, svgToDataUri } from './seal-generator.js';
import { loadSealAlbum, SEAL_ALBUM_CHANGE_EVENT, SEAL_ALBUM_KEY } from './seal-storage.js';
import { useSealPalette } from './use-seal-palette.js';
import wrongbookClearCss from './wrongbook-clear.css';

const celebratedClears = new Set();
let studioDialogCache = null;
let albumDialogCache = null;

function isFullMotion(element) {
  if (typeof window === 'undefined' || prefersReducedMotion(element)) return false;
  const root = findStudyRoot(element);
  return root?.getAttribute?.('data-motion') === 'full';
}

export default function WrongBookClearStamp({ clearedCount = 0, course = '' }) {
  useInjectCss(wrongbookClearCss, 'study-wb-clear-stamp');
  const cardRef = React.useRef(null);
  const stampBtnRef = React.useRef(null);
  const { palette, reducedMotion } = useSealPalette(cardRef);

  const count = Math.max(0, Math.round(Number(clearedCount) || 0));
  const cleanCourse = course && course !== '*' ? String(course).trim() : '';
  const seal = React.useMemo(
    () => deriveWrongBookClearSeal({ clearedCount: count, course: cleanCourse }),
    [count, cleanCourse],
  );

  const [stampNonce, setStampNonce] = React.useState(0);
  const [modalKind, setModalKind] = React.useState('');
  const [StudioDialog, setStudioDialog] = React.useState(() => studioDialogCache);
  const [AlbumDialog, setAlbumDialog] = React.useState(() => albumDialogCache);
  const [albumCount, setAlbumCount] = React.useState(() => loadSealAlbum().length);

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = () => setAlbumCount(loadSealAlbum().length);
    const onStorage = (event) => {
      if (!event || !event.key || event.key === SEAL_ALBUM_KEY) sync();
    };
    window.addEventListener(SEAL_ALBUM_CHANGE_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SEAL_ALBUM_CHANGE_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // One-time restrained confetti burst on arrival ONLY when data-motion="full" and not reduced-motion.
  React.useEffect(() => {
    if (count <= 0) return;
    const key = `${cleanCourse || 'all'}:${count}`;
    if (celebratedClears.has(key)) return;
    if (!isFullMotion(cardRef.current)) return;
    celebratedClears.add(key);
    void fireSealConfetti({ anchorEl: stampBtnRef.current || cardRef.current, variant: 'clean-sweep' });
  }, [cleanCourse, count]);

  useLiveEffect((isLive) => {
    if (modalKind !== 'studio' || StudioDialog) return undefined;
    import('./PostcardStudioDialog.jsx')
      .then((mod) => {
        const Comp = mod?.default || null;
        if (!Comp) return;
        studioDialogCache = Comp;
        if (isLive()) setStudioDialog(() => Comp);
      })
      .catch(() => {
        if (isLive()) setModalKind('');
      });
    return undefined;
  }, [modalKind, StudioDialog]);

  useLiveEffect((isLive) => {
    if (modalKind !== 'album' || AlbumDialog) return undefined;
    import('./SealAlbumDialog.jsx')
      .then((mod) => {
        const Comp = mod?.default || null;
        if (!Comp) return;
        albumDialogCache = Comp;
        if (isLive()) setAlbumDialog(() => Comp);
      })
      .catch(() => {
        if (isLive()) setModalKind('');
      });
    return undefined;
  }, [modalKind, AlbumDialog]);

  if (count <= 0) return null;

  const sealTitle = ui(seal.titleKey);
  const stampUri = svgToDataUri(buildSealSvg(seal, {
    style: seal.defaultStyle,
    size: 84,
    ink: palette.accent,
    paper: palette.paper,
  }));

  const postcardTitle = cleanCourse
    ? uiFormat('{0} · 错题清零纪念', [cleanCourse])
    : ui('错题清零纪念');
  const syntheticRun = {
    id: `wrongbook-clear-${cleanCourse || 'all'}-${count}`,
    title: postcardTitle,
  };

  const handlePressSeal = () => {
    setStampNonce((n) => n + 1);
    playSound('tap');
    if (isFullMotion(cardRef.current)) {
      void fireSealConfetti({ anchorEl: stampBtnRef.current, variant: 'stamp' });
    }
  };

  return (
    <div
      ref={cardRef}
      className="sh-wb-clear"
      data-seal-id={seal.id}
      data-testid="wb-clear-stamp"
      role="region"
      aria-label={ui('错题清零纪念印章')}
    >
      <Tooltip layer content={ui('点按再盖一次章')}>
        <Button
          ref={stampBtnRef}
          variant="quiet"
          className={cx('sh-wb-clear__trigger', stampNonce > 0 && !reducedMotion && 'is-stamping')}
          aria-label={uiFormat('盖章：{0}', [sealTitle])}
          onClick={handlePressSeal}
        >
          <img
            key={`wb-seal-${count}-${stampNonce}`}
            className="sh-wb-clear__seal-img"
            src={stampUri}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        </Button>
      </Tooltip>

      <div className="sh-wb-clear__body">
        <span className="sh-wb-clear__kicker">{ui('清零纪念印')}</span>
        <div className="sh-wb-clear__heading">
          <InkMark type="underline" tone="success" padding={2} strokeWidth={1.8}>
            <span className="sh-wb-clear__title">{ui('错题清零')}</span>
          </InkMark>
        </div>
        <p className="sh-wb-clear__note">
          {uiFormat('已累计攻克并订正 {0} 道错题，可压印成纪念明信片收进印谱。', [count])}
        </p>
        <div className="sh-wb-clear__actions">
          <Button
            size="sm"
            variant="secondary"
            icon="sparkle"
            data-testid="wb-clear-postcard-btn"
            onClick={() => setModalKind('studio')}
          >
            {ui('生成清零纪念明信片')}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            icon="book"
            data-testid="wb-clear-album-btn"
            onClick={() => setModalKind('album')}
          >
            {albumCount > 0 ? uiFormat('藏书印谱馆 ({0})', [albumCount]) : ui('藏书印谱馆')}
          </Button>
        </div>
      </div>

      {modalKind === 'studio' && StudioDialog && (
        <StudioDialog
          run={syntheticRun}
          title={postcardTitle}
          course={cleanCourse}
          seal={seal}
          initialSealStyle={seal.defaultStyle}
          initialTab="studio"
          onAlbumChange={setAlbumCount}
          onClose={() => setModalKind('')}
        />
      )}

      {modalKind === 'album' && AlbumDialog && (
        <AlbumDialog
          onAlbumChange={setAlbumCount}
          onClose={() => setModalKind('')}
        />
      )}
    </div>
  );
}
