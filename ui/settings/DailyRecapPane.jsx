import React from 'react';
import DailyRecapSettings from '../DailyRecapSettings.jsx';

export default function DailyRecapPane({ data }) {
  return <DailyRecapSettings root={data.root} saved={data.settings?.dailyRecap} />;
}
