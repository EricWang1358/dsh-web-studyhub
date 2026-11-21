import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { ATELIER_PRESETS, getPresetById } from './atelier-presets.js';
import { useAtelierState } from './atelier-storage.js';
import { selectSoundscapePreset, toggleSoundscape } from './soundscape-engine.js';
import css from './desk-atelier.css';

/** Quick Desk Atelier soundscape bar mounted inside TodayTimer's fullscreen focus dialog. */
export default function FocusSoundscapePill() {
  useInjectCss(css, 'study-desk-atelier');
  const state = useAtelierState();
  const activePreset = getPresetById(state.preset);
  const presetLabel = activePreset ? ui(activePreset.label) : ui('自定义混音');

  return (
    <div className="desk-focus-sound" role="group" aria-label={ui('书房声景快捷控制')}>
      <Button
        variant={state.playing ? 'secondary' : 'quiet'}
        size="sm"
        shape="pill"
        icon={state.playing ? 'stop' : 'audio'}
        aria-pressed={state.playing}
        className={'desk-focus-sound__toggle' + (state.playing ? ' is-playing' : '')}
        onClick={() => toggleSoundscape()}
      >
        {state.captureMuted
          ? ui('声景已静音（录音中）')
          : state.playing
            ? uiFormat('声景：{0}', [presetLabel])
            : ui('开启书房声景')}
      </Button>
      <div className="desk-focus-sound__presets">
        {ATELIER_PRESETS.map((preset) => {
          const active = state.playing && state.preset === preset.id;
          return (
            <Button
              key={preset.id}
              variant="quiet"
              size="sm"
              shape="pill"
              aria-pressed={active}
              className={'desk-focus-sound__preset' + (active ? ' is-selected' : '')}
              onClick={() => selectSoundscapePreset(preset.id, { autoPlay: true })}
            >
              {ui(preset.label)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
