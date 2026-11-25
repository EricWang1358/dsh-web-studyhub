import React, { useContext, useEffect, useState } from 'react';
import { errorMessage, ui, useUiLanguage } from '../i18n.js';
import { Hint, InlineMessage } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { AppContext } from '../app/app-context.js';
import { syncDesktopConcurrency } from './ipc.js';
import DesktopCliCard from './DesktopCliCard.jsx';
import DesktopOpenAiForm from './DesktopOpenAiForm.jsx';
import css from './desktop.css';

export function createDesktopConfigActions({ call, refresh, setConfig, setError, setWorking }) {
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
    saveCli: (providerId, cliConfig) => runAction(`save-${providerId}`, async () => (
      applyConfig(await call('desktop.config.save', { mode: providerId, [providerId]: cliConfig }))
    )),
    testCli: (providerId, cliConfig) => runAction(`test-${providerId}`, () => (
      call('desktop.config.test', { mode: providerId, [providerId]: cliConfig })
    )),
    saveOpenAiEndpoint: (openai) => runAction('save-openai', async () => (
      applyConfig(await call('desktop.config.save', { mode: 'openai', openai }))
    )),
    saveOpenAi: async (openai) => {
      setError('');
      setWorking('save-openai');
      try {
        return await applyConfig(await call('desktop.config.save', { mode: 'openai', openai }));
      } finally {
        setWorking('');
      }
    },
    testOpenAi: (openai) => {
      setError('');
      return call('desktop.config.test', { mode: 'openai', openai });
    },
    openCli: (providerId) => runAction(`open-${providerId}`, () => call('desktop.cli.open', { provider: providerId })),
    scan: () => runAction('scan', async () => {
      const result = await call('desktop.providers.scan', { force: true });
      setConfig((prev) => (prev ? { ...prev, providers: result?.providers || [] } : prev));
      return result;
    }),
  };
}

const hasReadyCli = (providers) => Array.isArray(providers) && providers.some((item) => item.supported && item.status === 'ready');

/** The setup panel's body. `quick` (the first-run step): only the detected local CLI with its 一键启用, or nothing when none is ready. */
export function DesktopSetupBody({ config, actions, working, error, onDismissError, compact, quick = false }) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const readyCli = hasReadyCli(providers);
  const cliCard = (
    <DesktopCliCard providers={providers} mode={config.mode} agy={config.agy} codex={config.codex}
      actions={actions} working={working} compact={compact} />
  );
  if (quick) {
    if (!readyCli) return null;
    return (
      <div className="desktop-setup" data-desktop-model="quick">
        {cliCard}
        {error && <InlineMessage tone="error" onDismiss={onDismissError}>{error}</InlineMessage>}
      </div>
    );
  }
  const openAiCard = (
    <DesktopOpenAiForm openai={config.openai} active={config.mode === 'openai'} actions={actions} working={working} compact={compact} />
  );

  return (
    <div className="desktop-setup" data-desktop-model={config.effective?.ready ? 'ready' : 'missing'}>
      {readyCli ? <>{cliCard}{openAiCard}</> : <>{openAiCard}{cliCard}</>}
      {error && <InlineMessage tone="error" onDismiss={onDismissError}>{error}</InlineMessage>}
      {!compact && config.configPath && (
        <Hint className="desktop-model__note" data-desktop-config-path="">
          {ui('配置文件位置：')}{' '}<code translate="no">{config.configPath}</code>
        </Hint>
      )}
    </div>
  );
}

/** `quick` tells the page whether a one-click way is on offer (a ready local CLI), so the page's own button steps back beside it. */
function useOfferNote(onOffer, offers) {
  useEffect(() => { onOffer?.(offers); }, [onOffer, offers]);
}

/** Desktop model setup panel rendered via hostPart('ModelSetup'), hostPart('ModelGateForm') and hostPart('ModelQuickEnable') (`quick`). */
export default function DesktopModelSetup({ compact = false, quick = false, onOffer }) {
  useInjectCss(css, 'study-desktop');
  const { call, refresh } = useContext(AppContext)?.core || {};
  const { config, setConfig, error, setError } = useDesktopConfig(call);
  const [working, setWorking] = useState('');
  useOfferNote(onOffer, quick && hasReadyCli(config?.providers));

  const actions = createDesktopConfigActions({ call, refresh, setConfig, setError, setWorking });
  if (!call) return null;
  if (!config) return error && !quick ? <InlineMessage tone="error">{error}</InlineMessage> : null;

  return <DesktopSetupBody config={config} actions={actions} working={working} error={error} onDismissError={() => setError('')} compact={compact} quick={quick} />;
}

/** The saved desktop model config, read once per interface language (provider reasons come back in that language). */
function useDesktopConfig(call) {
  const language = useUiLanguage();
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');

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

  return { config, setConfig, error, setError };
}
