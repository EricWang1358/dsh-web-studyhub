import React, { useId } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, InlineMessage, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import {
  ATELIER_CHANNELS,
  ATELIER_PRESETS,
  ATMOSPHERE_MODES,
  getAtmosphereById,
  getPresetById,
  resolveAtmosphereLighting,
} from './atelier-presets.js';
import { useAtelierState } from './atelier-storage.js';
import {
  resetSoundscapeMix,
  selectSoundscapePreset,
  setDeskAtmosphere,
  setSoundscapeChannel,
  setSoundscapeMaster,
  toggleSoundscape,
} from './soundscape-engine.js';
import css from './desk-atelier.css';

/** Bespoke minimalist 18px ink-line SVG glyphs for the 5 soundscape channels. */
function ChannelGlyph({ id }) {
  const shared = {
    className: 'desk-atelier__channel-icon',
    width: 16,
    height: 16,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  };
  if (id === 'rain') {
    return (
      <svg {...shared}>
        <path d="M5 10.5a3.5 3.5 0 0 1 .4-6.98A4.8 4.8 0 0 1 14.8 5a2.8 2.8 0 0 1-.3 5.5H5Z" />
        <path d="M6.8 13.5 5.8 16.5M10.4 13.5 9.4 16.5M14 13.5 13 16.5" />
      </svg>
    );
  }
  if (id === 'vinyl') {
    return (
      <svg {...shared}>
        <circle cx="10" cy="10" r="7.2" />
        <circle cx="10" cy="10" r="2.2" />
        <path d="M10 5.4a4.6 4.6 0 0 1 4.6 4.6" />
      </svg>
    );
  }
  if (id === 'hearth') {
    return (
      <svg {...shared}>
        <path d="M10.2 3.2c.4 2.6-2.4 4-2.4 6.6a3.4 3.4 0 0 0 6.8 0c0-2.5-1.6-4.2-4.4-6.6Z" />
        <path d="M4.5 16.2h11" />
      </svg>
    );
  }
  if (id === 'bamboo') {
    return (
      <svg {...shared}>
        <path d="M10 3v14" />
        <path d="M10 7.5c2.2-1.8 4.2-1.8 5.2-.7-1.2 1.5-3 2-5.2.7Z" />
        <path d="M10 11.8c-2.2-1.6-4.2-1.6-5.2-.5 1.2 1.4 3 1.8 5.2.5Z" />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      <path d="M3 10c1.4-2.8 2.8-2.8 4.2 0s2.8 2.8 4.2 0 2.8-2.8 4.2 0 1.2 1.4 1.4 1" />
    </svg>
  );
}

export default function DeskAtelierPanel() {
  useInjectCss(css, 'study-desk-atelier');
  const state = useAtelierState();
  const baseId = useId();
  const activePreset = getPresetById(state.preset);
  const presetTitle = activePreset ? ui(activePreset.label) : ui('自定义混音');
  const masterPct = Math.round(state.master * 100);
  const solarResolved = state.atmosphere === 'solar' ? resolveAtmosphereLighting('solar') : 'none';
  const solarLabel = solarResolved !== 'none' ? ui(getAtmosphereById(solarResolved).label) : '';

  const subtitle = state.captureMuted
    ? ui('录音中已静音')
    : state.playing
      ? uiFormat('{0} · 播放中', [presetTitle])
      : ui('本机离线合成 · 默认静音');

  return (
    <div className="desk-atelier__body">
      <header className="desk-atelier__head">
        <div className="desk-atelier__titles">
          <h3 className="desk-atelier__title">{ui('书房声景与光影')}</h3>
          <p className="desk-atelier__sub">{subtitle}</p>
        </div>
        <Button
          variant={state.playing ? 'secondary' : 'primary'}
          size="sm"
          icon={state.playing ? 'stop' : 'audio'}
          onClick={() => toggleSoundscape()}
        >
          {state.playing ? ui('停止') : ui('播放')}
        </Button>
      </header>

      {state.captureMuted && (
        <InlineMessage tone="info" className="desk-atelier__notice">
          {ui('正在录音或进行实时课堂，声景已自动静音。')}
        </InlineMessage>
      )}

      <section className="desk-atelier__section" aria-label={ui('推荐声景')}>
        <div className="desk-atelier__section-head">
          <span className="desk-atelier__section-title">{ui('精选声景')}</span>
          <Button
            variant="quiet"
            size="sm"
            className="desk-atelier__reset"
            onClick={() => resetSoundscapeMix()}
          >
            {ui('恢复默认')}
          </Button>
        </div>
        <div className="desk-atelier__presets">
          {ATELIER_PRESETS.map((preset) => {
            const active = state.preset === preset.id;
            return (
              <Button
                key={preset.id}
                variant="quiet"
                size="sm"
                align="start"
                wrap
                className={'desk-atelier__preset' + (active ? ' is-selected' : '')}
                aria-pressed={active}
                onClick={() => selectSoundscapePreset(preset.id, { autoPlay: true })}
              >
                <span className="desk-atelier__preset-copy">
                  <span className="desk-atelier__preset-name">{ui(preset.label)}</span>
                  <span className="desk-atelier__preset-hint">{ui(preset.hint)}</span>
                </span>
              </Button>
            );
          })}
        </div>
      </section>

      <section className="desk-atelier__section" aria-label={ui('声道调音台')}>
        <div className="desk-atelier__master">
          <label htmlFor={`${baseId}-master`} className="desk-atelier__master-label">
            {ui('总音量')}
          </label>
          <input
            id={`${baseId}-master`}
            type="range"
            className="desk-atelier__slider"
            min={0}
            max={100}
            step={1}
            value={masterPct}
            aria-label={ui('总音量')}
            onChange={(event) => setSoundscapeMaster(Number(event.target.value) / 100)}
          />
          <span className="desk-atelier__pct">{`${masterPct}%`}</span>
        </div>

        <ul className="desk-atelier__channels">
          {ATELIER_CHANNELS.map((channel) => {
            const pct = Math.round((state.channels[channel.id] || 0) * 100);
            const sliderId = `${baseId}-ch-${channel.id}`;
            return (
              <li key={channel.id} className={'desk-atelier__channel' + (pct > 0 ? ' is-active' : '')}>
                <ChannelGlyph id={channel.id} />
                <Tooltip layer content={ui(channel.hint)} anchorClassName="desk-atelier__channel-tip">
                  <label htmlFor={sliderId} className="desk-atelier__channel-name">
                    {ui(channel.label)}
                  </label>
                </Tooltip>
                <input
                  id={sliderId}
                  type="range"
                  className="desk-atelier__slider"
                  min={0}
                  max={100}
                  step={1}
                  value={pct}
                  aria-label={uiFormat('{0}音量', [ui(channel.label)])}
                  onChange={(event) => setSoundscapeChannel(channel.id, Number(event.target.value) / 100)}
                />
                <span className="desk-atelier__pct">{`${pct}%`}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="desk-atelier__section desk-atelier__section--mood" aria-label={ui('案头光影')}>
        <div className="desk-atelier__section-head">
          <span className="desk-atelier__section-title">{ui('案头光影')}</span>
          {solarLabel && (
            <span className="desk-atelier__solar-tag">{uiFormat('当前：{0}', [solarLabel])}</span>
          )}
        </div>
        <div className="desk-atelier__moods">
          {ATMOSPHERE_MODES.map((mode) => {
            const active = state.atmosphere === mode.id;
            return (
              <Button
                key={mode.id}
                variant="quiet"
                size="sm"
                shape="pill"
                className={'desk-atelier__mood' + (active ? ' is-selected' : '')}
                aria-pressed={active}
                onClick={() => setDeskAtmosphere(mode.id)}
              >
                {ui(mode.label)}
              </Button>
            );
          })}
        </div>
        <p className="desk-atelier__footnote">{ui('轻度环境光晕，高对比度下自动关闭；全部声景纯本机离线合成。')}</p>
      </section>
    </div>
  );
}
