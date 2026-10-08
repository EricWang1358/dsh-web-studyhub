import React, { useContext } from 'react';
import { ui } from '../i18n.js';
import { SettingsSection } from '../components/index.js';
import WorkspaceBindingPanel from '../app/WorkspaceBindingPanel.jsx';
import { AppContext } from '../app/app-context.js';
import ModelStatus from './ModelStatus.jsx';

/** 学习库与模型: whether a model is connected first, then the library binding and the model choice (the panel reads the app's binding itself). */
export default function ModelPane({ data, host }) {
  const refresh = useContext(AppContext)?.core?.refresh;
  return (
    <SettingsSection title={ui('学习库与模型')} tour="settings-model">
      <ModelStatus data={data} host={host} refresh={refresh} />
      <WorkspaceBindingPanel />
    </SettingsSection>
  );
}
