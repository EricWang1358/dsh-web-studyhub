import React, { useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Icon, IconButton, Popover, Spinner } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { getPresetById } from './atelier-presets.js';
import { useAtelierState } from './atelier-storage.js';
import AtmosphereLayer from './AtmosphereLayer.jsx';
import triggerCss from './desk-atelier-trigger.css';

let cachedPanel = null;

/** Compact top-bar Desk Atelier button + lazy Popover + opt-in AtmosphereLayer.
    Memoised leaf component; DeskAtelierPanel (and soundscape-engine.js) are dynamically imported
    only when opened so the workspace first-load closure stays lean. */
const DeskAtelierButton = React.memo(function DeskAtelierButton() {
  useInjectCss(triggerCss, 'study-desk-atelier-trigger');
  const state = useAtelierState();
  const anchorWrapRef = useRef(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [PanelComponent, setPanelComponent] = useState(() => cachedPanel);

  useLiveEffect((isLive) => {
    if (!panelOpen || PanelComponent) return undefined;
    import('./DeskAtelierPanel.jsx')
      .then((mod) => {
        cachedPanel = mod?.default || null;
        if (isLive() && cachedPanel) setPanelComponent(() => cachedPanel);
      })
      .catch(() => {});
    return undefined;
  }, [panelOpen, PanelComponent]);

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
          <PanelComponent />
        ) : (
          <div className="desk-atelier__loading">
            <Spinner />
          </div>
        )}
      </Popover>
      <AtmosphereLayer anchorRef={anchorWrapRef} />
    </div>
  );
});

export default DeskAtelierButton;
