import React from 'react';
import GenerationSettings from '../GenerationSettings.jsx';
import { useModelEfforts } from '../use-model-efforts.js';
import { useStudy } from '../study-context.jsx';

export default function GenerationPane({ data }) {
  const { call } = useStudy();
  // The stage levels are chosen among the levels of the model in use, as in the audio settings.
  const model = useModelEfforts(call, { enabled: typeof call === 'function' });
  return <GenerationSettings root={data.root} saved={data.settings?.generation} efforts={model.options} session={data.model?.session} />;
}
