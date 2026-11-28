import React, { useContext, useEffect, useState } from 'react';
import { errorMessage, getUiLanguage, ui, uiFormat, useUiLanguage } from '../i18n.js';
import { cliOpeningMessage } from '../agent-prompts/message.js';
import { libraryRootOf } from '../app/library-root.js';
import { Hint, InlineMessage } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { AppContext } from '../app/app-context.js';
import { syncDesktopConcurrency } from './ipc.js';
import DesktopCliCard from './DesktopCliCard.jsx';
import DesktopOpenAiForm from './DesktopOpenAiForm.jsx';
import css from './desktop.css';

/* 「在学习库里打开 CLI」: the opening note is copied before the console window opens, because the clipboard refuses a page that has lost focus.
   It is the CLI's only way to learn that the library is read and written through the bundled study-cli. */
async function copyCliOpening(cliPaths, clipboard) {
  const opening = cliOpeningMessage({ ...(cliPaths?.() || {}), language: getUiLanguage() });
  if (!opening) return null;
  const copied = await Promise.resolve().then(() => clipboard.writeText(opening)).then(() => true, () => false);
  return { opening, copied };
}

export function createDesktopConfigActions({ call, refresh, setConfig, setError, setWorking, cliPaths = null, clipboard = globalThis.navigator?.clipboard }) {
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
    openCli: (providerId) => runAction(`open-${providerId}`, async () => {
      const note = await copyCliOpening(cliPaths, clipboard);
      const opened = await call('desktop.cli.open', { provider: providerId });
      return note ? { ...opened, ...note } : opened;
    }),
    scan: () => runAction('scan', async () => {
      const result = await call('desktop.providers.scan', { force: true });
      setConfig((prev) => (prev ? { ...prev, providers: result?.providers || [] } : prev));
      return result;
    }),
    recoverConfig: () => runAction('recover-config', async () => {
      const result = await call('desktop.config.recover', {});
      if (result?.config) return applyConfig(result.config);
      await refresh?.();
      return result;
    }),
  };
}

/* The library study-cli's --root names (not the folder the CLI opens in, which is the DSH workspace around it when one was picked), and the bundled
   study-cli and node the saved desktop config reports. */
export const desktopCliPaths = (refs, config) => ({ libraryRoot: libraryRootOf(refs), studyCliPath: config?.studyCliPath || '', studyNodePath: config?.studyNodePath || '' });

/** The setup panel's actions: createDesktopConfigActions with the host call, refresh and the opening note's paths read live from the app core and the config. */
export function desktopSetupActions({ core, config, ...rest }) {
  return createDesktopConfigActions({ ...rest, call: core.call, refresh: core.refresh, cliPaths: () => desktopCliPaths(core.refs, config) });
}

const hasReadyCli = (providers) => Array.isArray(providers) && providers.some((item) => item.supported && item.status === 'ready');

function CorruptConfigBanner({ config, actions, working }) {
  if (!config?.configProblem) return null;
  const pathText = config.configProblem.path || config.configPath || 'desktop.json';
  if (config.configProblem.code === 'config-unsupported-version') {
    return (
      <InlineMessage
        tone="warning"
        boxed
        title={ui('配置文件由更新版本写入')}
      >
        {uiFormat('配置文件版本高于当前程序支持范围（{0}），已保持原样未修改。请升级 StudyHub 后再保存设置或更改学习库目录。', [pathText])}
      </InlineMessage>
    );
  }
  return (
    <InlineMessage
      tone="warning"
      boxed
      title={ui('配置文件已损坏')}
      action={actions.recoverConfig ? { label: ui('备份并重置配置'), busy: working === 'recover-config', onClick: actions.recoverConfig } : undefined}
    >
      {uiFormat('配置文件无法读取（{0}）。请先备份并重置，再保存模型或更改学习库目录。', [pathText])}
    </InlineMessage>
  );
}

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
      <CorruptConfigBanner config={config} actions={actions} working={working} />
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
  const core = useContext(AppContext)?.core || {};
  const { call } = core;
  const { config, setConfig, error, setError } = useDesktopConfig(call);
  const [working, setWorking] = useState('');
  useOfferNote(onOffer, quick && hasReadyCli(config?.providers));

  const actions = desktopSetupActions({ core, config, setConfig, setError, setWorking });
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
