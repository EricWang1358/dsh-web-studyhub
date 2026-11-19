import React, { useContext, useState } from 'react';
import { errorMessage, ui, useUiLanguage } from '../i18n.js';
import { InlineMessage } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { AppContext } from '../app/app-context.js';
import { syncDesktopConcurrency } from './ipc.js';
import DesktopCliCard from './DesktopCliCard.jsx';
import DesktopOpenAiForm from './DesktopOpenAiForm.jsx';
import css from './desktop.css';

function useDesktopConfigActions({ call, refresh, setConfig, setError, setWorking }) {
  const applyConfig = async (next) => {
    setConfig(next);
    syncDesktopConcurrency(next?.effective);
    await refresh?.();
    return next;
  };

  const runAction = async (tag, work) => {
    setError('');
    setWorking(tag);
    try {
      return await work();
    } catch (failure) {
      setError(errorMessage(failure));
      return null;
    } finally {
      setWorking('');
    }
  };

  return {
    saveAgy: (agy) => runAction('save-agy', async () => applyConfig(await call('desktop.config.save', { mode: 'agy', agy }))),
    testAgy: (agy) => runAction('test-agy', () => call('desktop.config.test', { mode: 'agy', agy })),
    saveOpenAi: async (openai) => {
      setError('');
      setWorking('save-openai');
      try {
        return await applyConfig(await call('desktop.config.save', { mode: 'openai', openai }));
      } catch (failure) {
        setError(errorMessage(failure));
        throw failure;
      } finally {
        setWorking('');
      }
    },
    testOpenAi: (openai) => call('desktop.config.test', { mode: 'openai', openai }),
    scan: () => runAction('scan', async () => {
      const result = await call('desktop.providers.scan', { force: true });
      setConfig((prev) => (prev ? { ...prev, providers: result?.providers || [] } : prev));
      return result;
    }),
  };
}

function SetupBody({ config, actions, working, error, onDismissError, compact }) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const hasReadyCli = providers.some((item) => item.supported && item.status === 'ready');
  const cliCard = (
    <DesktopCliCard providers={providers} mode={config.mode} agy={config.agy} actions={actions} working={working} compact={compact} />
  );
  const openAiCard = (
    <DesktopOpenAiForm openai={config.openai} active={config.mode === 'openai'} actions={actions} working={working} compact={compact} />
  );

  return (
    <div className="desktop-setup" data-desktop-model={config.effective?.ready ? 'ready' : 'missing'}>
      {hasReadyCli ? <>{cliCard}{openAiCard}</> : <>{openAiCard}{cliCard}</>}
      {error && <InlineMessage tone="error" onDismiss={onDismissError}>{error}</InlineMessage>}
      {!compact && config.configPath && (
        <InlineMessage tone="info">
          {ui('配置文件位置：')}{' '}<code translate="no">{config.configPath}</code>
        </InlineMessage>
      )}
    </div>
  );
}

/** Desktop model setup panel rendered via hostPart('ModelSetup') and hostPart('ModelGateForm'). */
export default function DesktopModelSetup({ compact = false }) {
  useInjectCss(css, 'study-desktop');
  const language = useUiLanguage();
  const app = useContext(AppContext);
  const call = app?.core?.call;
  const refresh = app?.core?.refresh;
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');

  useLiveEffect((live) => {
    if (!call) return;
    call('desktop.config.get', {}).then(
      (value) => {
        if (!live()) return;
        setConfig(value);
        syncDesktopConcurrency(value?.effective);
      },
      (failure) => {
        if (live()) setError(errorMessage(failure));
      },
    );
  }, [call, language]);

  const actions = useDesktopConfigActions({ call, refresh, setConfig, setError, setWorking });
  if (!call) return null;
  if (!config) return error ? <InlineMessage tone="error">{error}</InlineMessage> : null;

  return <SetupBody config={config} actions={actions} working={working} error={error} onDismissError={() => setError('')} compact={compact} />;
}
