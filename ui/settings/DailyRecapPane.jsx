import React from 'react';
import DailyRecapSettings from '../DailyRecapSettings.jsx';

export default function DailyRecapPane({ data, busy, act, setNotice }) {
  return <DailyRecapSettings root={data.root} saved={data.settings?.dailyRecap} busy={busy} act={act} setNotice={setNotice} />;
}
