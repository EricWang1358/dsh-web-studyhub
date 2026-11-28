/* Ultra-lightweight trigger for the standalone Seal Album Gallery Dialog.
   Reads the saved count directly via readJSON('study-seal-album', []) without importing
   seal rendering, postcard SVG, or dialog CSS into DAILY page closures, and dynamically
   imports SealAlbumDialog.jsx via useLiveEffect only on user click. */
import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/Button.jsx';
import { readJSON } from '../storage.js';
import { useAppearance } from '../use-appearance.js';
import { useLiveEffect } from '../use-async.js';

const ALBUM_KEY = 'study-seal-album';
const ALBUM_EVENT = 'study-seal-album-change';
let dialogCache = null;

function readAlbumCount() {
  const list = readJSON(ALBUM_KEY, []);
  return Array.isArray(list) ? list.length : 0;
}

export default function LazySealAlbumTrigger({
  onlyWhenNonEmpty = false,
  size,
  variant = 'quiet',
  className,
}) {
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const [count, setCount] = React.useState(readAlbumCount);
  const [open, setOpen] = React.useState(false);
  const [DialogComp, setDialogComp] = React.useState(() => dialogCache);

  React.useEffect(() => {
    if (minimal) setOpen(false);
  }, [minimal]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = () => setCount(readAlbumCount());
    const onStorage = (event) => {
      if (!event || !event.key || event.key === ALBUM_KEY) sync();
    };
    window.addEventListener(ALBUM_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(ALBUM_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useLiveEffect((isLive) => {
    if (minimal || !open || DialogComp) return undefined;
    import('./SealAlbumDialog.jsx')
      .then((mod) => {
        const Comp = mod?.default || null;
        if (!Comp) return;
        dialogCache = Comp;
        if (isLive()) setDialogComp(() => Comp);
      })
      .catch(() => {
        if (isLive()) setOpen(false);
      });
    return undefined;
  }, [minimal, open, DialogComp]);

  if (minimal || (onlyWhenNonEmpty && count <= 0)) return null;

  return (
    <>
      <Button
        size={size}
        variant={variant}
        icon="book"
        className={className}
        data-testid="seal-album-trigger"
        onClick={() => setOpen(true)}
      >
        {count > 0 ? uiFormat('藏书印谱 ({0})', [count]) : ui('藏书印谱')}
      </Button>
      {open && DialogComp && (
        <DialogComp
          onAlbumChange={setCount}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
