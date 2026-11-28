import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ui, uiFormat, useUiLanguage } from '../i18n.js';
import { Icon, IconButton, Popover, Spinner } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useAppearance } from '../use-appearance.js';
import { useLiveEffect } from '../use-async.js';
import { getPresetById } from './atelier-presets.js';
import { useAtelierState } from './atelier-storage.js';
import AtmosphereLayer from './AtmosphereLayer.jsx';
import triggerCss from './desk-atelier-trigger.css';

let cachedPanel = null;
let cachedChimeDialog = null;

/** Compact top-bar Desk Atelier button + lazy Popover + hoisted lazy DeskChimeDialog + opt-in AtmosphereLayer.
    Memoised leaf component; DeskAtelierPanel (soundscape-engine.js) and DeskChimeDialog (chime-synth.js)
    are dynamically imported only when opened so the workspace first-load closure stays lean. */
const DeskAtelierButton = React.memo(function DeskAtelierButton() {
  useUiLanguage();
  useInjectCss(triggerCss, 'study-desk-atelier-trigger');
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const state = useAtelierState();
  const anchorWrapRef = useRef(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [PanelComponent, setPanelComponent] = useState(() => cachedPanel);
  const [chimeOpen, setChimeOpen] = useState(false);
  const [ChimeDialog, setChimeDialog] = useState(() => cachedChimeDialog);

  useLiveEffect((isLive) => {
    if (minimal || !panelOpen || PanelComponent) return undefined;
    import('./DeskAtelierPanel.jsx')
      .then((mod) => {
        cachedPanel = mod?.default || null;
        if (!isLive()) return;
        if (cachedPanel) setPanelComponent(() => cachedPanel);
        else setPanelOpen(false);
      })
      .catch(() => {
        if (isLive()) setPanelOpen(false);
      });
    return undefined;
  }, [minimal, panelOpen, PanelComponent]);

  useLiveEffect((isLive) => {
    if (minimal || !chimeOpen || ChimeDialog) return undefined;
    import('./DeskChimeDialog.jsx')
      .then((mod) => {
        cachedChimeDialog = mod?.default || null;
        if (!isLive()) return;
        if (cachedChimeDialog) setChimeDialog(() => cachedChimeDialog);
        else setChimeOpen(false);
      })
      .catch(() => {
        if (isLive()) setChimeOpen(false);
      });
    return undefined;
  }, [minimal, chimeOpen, ChimeDialog]);

  // Stop active soundscape playback and close popovers when Minimal Mode turns on (preserving saved prefs).
  useEffect(() => {
    if (!minimal) return;
    setPanelOpen(false);
    setChimeOpen(false);
    if (state.playing) {
      import('./soundscape-engine.js')
        .then((mod) => mod?.stopSoundscape?.())
        .catch(() => {});
    }
  }, [minimal, state.playing]);

  // Global Alt+Shift+A shortcut toggles Desk Atelier (guarded against editable fields, open dialogs & Minimal Mode).
  useEffect(() => {
    if (minimal) return undefined;
    const onKeyDown = (event) => {
      if (event.repeat || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      if (event.code !== 'KeyA' && String(event.key || '').toUpperCase() !== 'A') return;
      const target = event.target;
      const tag = typeof target?.tagName === 'string' ? target.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (typeof document !== 'undefined' && document.querySelector?.('dialog[open]')) return;
      event.preventDefault();
      setPanelOpen((open) => !open);
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }
    return undefined;
  }, [minimal]);

  const handleToggleChime = useCallback(() => {
    setPanelOpen(false);
    setChimeOpen(true);
  }, []);

  if (minimal) return null;

  const activePreset = getPresetById(state.preset);
  const presetLabel = activePreset ? ui(activePreset.label) : ui('自定义混音');
  const isAudiblyPlaying = state.playing && !state.captureMuted;

  const buttonLabel = state.captureMuted
    ? ui('书房声景（录音中已静音）')
    : state.playing
      ? uiFormat('书房声景：{0}（播放中）', [presetLabel])
      : ui('书房声景与光影');

  return (
    <div
      ref={anchorWrapRef}
      className={'desk-atelier-anchor' + (state.playing ? ' is-playing' : '')}
    >
      <Popover
        label={ui('书房声景与光影')}
        placement="bottom-end"
        open={panelOpen}
        onOpenChange={setPanelOpen}
        panelClassName="desk-atelier__panel"
        trigger={({ props, ref, open }) => (
          <IconButton
            ref={ref}
            icon={<Icon name="audio" size={16} />}
            label={buttonLabel}
            className={
              'desk-atelier__toggle'
              + (isAudiblyPlaying ? ' is-playing' : '')
              + (state.captureMuted ? ' is-muted' : '')
              + (open ? ' is-open' : '')
            }
            {...props}
          >
            {isAudiblyPlaying && (
              <span className="desk-atelier__wave" aria-hidden="true">
                <i className="desk-atelier__bar" />
                <i className="desk-atelier__bar" />
                <i className="desk-atelier__bar" />
              </span>
            )}
          </IconButton>
        )}
      >
        {PanelComponent ? (
          <PanelComponent onToggleChime={handleToggleChime} />
        ) : (
          <div className="desk-atelier__loading">
            <Spinner />
          </div>
        )}
      </Popover>
      {chimeOpen && ChimeDialog && (
        <ChimeDialog onClose={() => setChimeOpen(false)} />
      )}
      <AtmosphereLayer anchorRef={anchorWrapRef} />
    </div>
  );
});

export default DeskAtelierButton;
