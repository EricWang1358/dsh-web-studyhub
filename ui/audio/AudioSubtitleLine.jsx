import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, createDropHandlers, partitionFiles } from '../components/index.js';
import { SUBTITLE_EXTENSIONS } from '../../lib/audio-formats.js';
import { subtitleFormatNames } from './formats.js';

const SUBTITLE_RULES = { accept: SUBTITLE_EXTENSIONS, multiple: false };

/** Under the setup card: subtitles need no transcription, so they can come in now. One line of text and a button, with no frame of its own
 * (#578: the setup card is the page's one card); the whole line still takes a dropped file, and shows it only while one is dragged over it. */
export default function AudioSubtitleLine({ disabled, onFiles }) {
  const zone = useRef(null), picker = useRef(null), latest = useRef(null);
  const [over, setOver] = useState(false);
  latest.current = { options: { ...SUBTITLE_RULES, disabled }, onFiles };
  useEffect(() => {
    const element = zone.current;
    const handlers = createDropHandlers({ getOptions: () => latest.current.options, onDragState: setOver,
      onFiles: (accepted, rejected) => latest.current.onFiles(accepted, rejected) });
    Object.entries(handlers).forEach(([type, handler]) => element.addEventListener(type, handler));
    return () => Object.entries(handlers).forEach(([type, handler]) => element.removeEventListener(type, handler));
  }, []);
  return (
    <div ref={zone} className="audio-subtitle-only" data-over={over || undefined}>
      <p>{uiFormat("字幕文件（{0}）不需要转写服务，现在就可以导入：选择文件，或把它拖到这一行。", [subtitleFormatNames().join(' · ')])}</p>
      <Button size="sm" icon="plus" disabled={disabled} onClick={() => picker.current?.click()}>{ui("选择字幕文件")}</Button>
      <input ref={picker} type="file" hidden tabIndex={-1} accept={SUBTITLE_EXTENSIONS.join(',')} disabled={disabled}
        onChange={event => {
          const chosen = Array.from(event.target.files || []);
          event.target.value = '';
          if (!chosen.length) return;
          const { accepted, rejected } = partitionFiles(chosen, SUBTITLE_RULES);
          onFiles(accepted, rejected);
        }} />
    </div>
  );
}
