import React from 'react';
import LegacyImportSection from './LegacyImportSection.jsx';
import { ScheduleSection } from './ScheduleSection.jsx';
import { BackupSection } from './BackupSection.jsx';

/** 导入、计划与备份. */
export default function DataPane({ data, settings, setSettings, legacy, setLegacy, exportData, onRestored }) {
  return <>
    <LegacyImportSection legacy={legacy} setLegacy={setLegacy} />
    <ScheduleSection key={data.root} root={data.root} settings={settings} saved={data.settings} setSettings={setSettings} />
    <BackupSection root={data.root} exportData={exportData} onRestored={onRestored} />
  </>;
}
