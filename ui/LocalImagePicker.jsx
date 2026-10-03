import React, { useEffect, useId, useRef, useState } from 'react';
import { Button } from './components/Button.jsx';
import { InlineMessage } from './components/Feedback.jsx';
import { ui } from './i18n.js';
import { localImageMarkdown } from './local-study-image.js';

export default function LocalImagePicker({ onInsert, disabled = false }) {
  const input = useRef(null), active = useRef(true), pending = useRef(false), disabledRef = useRef(disabled), insertRef = useRef(onInsert), generation = useRef(0);
  disabledRef.current = disabled;
  insertRef.current = onInsert;
  const hintId = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const mounted = generation.current + 1;
    active.current = true; generation.current = mounted;
    return () => { active.current = false; generation.current = mounted + 1; };
  }, [disabled]);
  async function select(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || pending.current || disabledRef.current) return;
    const reading = generation.current;
    pending.current = true; setBusy(true); setError('');
    try {
      const markdown = await localImageMarkdown(file);
      if (active.current && !disabledRef.current && generation.current === reading) insertRef.current(markdown);
    } catch (failure) {
      if (active.current) setError(failure.message);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <div className="local-image-picker">
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={disabled || busy} onChange={select} />
    <Button size="sm" variant="quiet" icon="upload" busy={busy} disabled={disabled} aria-describedby={hintId}
      onClick={() => input.current?.click()}>{ui(busy ? '正在读取图片…' : '插入本地图片')}</Button>
    <p id={hintId} className="muted small">{ui('PNG、JPEG、WebP、GIF，每张不超过 2 MiB。图片将随学习库保存。')}</p>
    {error && <InlineMessage>{ui(error)}</InlineMessage>}
  </div>;
}
