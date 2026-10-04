import React from 'react';
import LegacyImportSection from './LegacyImportSection.jsx';
import { ScheduleSection } from './ScheduleSection.jsx';
import { BackupSection } from './BackupSection.jsx';

/** 导入、计划与备份. */
export default function DataPane({ data, busy, act, setNotice, settings, setSettings, legacy, setLegacy, exportData, onRestored }) {
  return <>
    <LegacyImportSection busy={busy} act={act} setNotice={setNotice} legacy={legacy} setLegacy={setLegacy} />
    <ScheduleSection key={data.root} root={data.root} settings={settings} saved={data.settings} setSettings={setSettings} act={act} busy={busy} setNotice={setNotice} />
    <BackupSection root={data.root} busy={busy} exportData={exportData} act={act} onRestored={onRestored} />
  </>;
}
