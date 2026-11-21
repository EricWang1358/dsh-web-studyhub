import React, { useState } from 'react';
import { useLiveEffect } from '../use-async.js';

let cachedDialog = null;

/**
 * Dynamically imports `InkScratchpadDialog.jsx` (plus canvas and ink-engine) only
 * when the scratchpad opens, keeping ~26 KB off the workspace first-load closure.
 */
export default function LazyInkScratchpadDialog(props) {
  const [DialogImpl, setDialogImpl] = useState(() => cachedDialog);

  useLiveEffect((isLive) => {
    if (DialogImpl) return;
    import('./InkScratchpadDialog.jsx')
      .then((mod) => {
        cachedDialog = mod.default;
        if (isLive()) setDialogImpl(() => mod.default);
      })
      .catch(() => { /* ignore transient chunk load failure */ });
  }, [DialogImpl]);

  return DialogImpl ? <DialogImpl {...props} /> : null;
}
