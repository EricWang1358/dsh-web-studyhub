import React from 'react';
import GenerationSettings from '../GenerationSettings.jsx';
import { useModelEfforts } from '../use-model-efforts.js';
import { followLabel } from '../follow-session.js';

export default function GenerationPane({ data, busy, act, call }) {
  // The stage levels are chosen among the levels of the model in use, as in the audio settings.
  const model = useModelEfforts(call, { enabled: typeof call === 'function' });
  return <GenerationSettings root={data.root} saved={data.settings?.generation} busy={busy} act={act} efforts={model.options} followLabel={followLabel(data.model?.session)} />;
}
