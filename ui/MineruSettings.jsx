import React, { useEffect, useId, useState } from 'react';
import { ui, uiFormat, uiMessage, errorMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Field, Hint, Icon, InlineMessage, RadioCard, RadioCardGroup, SecretKeyForm, SettingsSection, TextInput, useToast } from './components/index.js';
import MineruInstallCard from './MineruInstallCard.jsx';
import { useMineruState } from './use-mineru.js';
import { useStudy } from './study-context.jsx';
import css from './mineru.css';

/* 设置 › PDF 转换（MinerU）:
   - Default route: local MinerU on this computer (one-click install, zero upload).
   - Optional route: cloud / third-party MinerU-compatible API with custom baseUrl + Key (uploads PDF; requires first-use confirmation). */

const DEFAULT_BASE_URL = 'https://mineru.net/api/v4';
const TEST_TEXT = {
  valid: () => ui('可用：密钥有效，云端接口连得上'),
  invalid: () => ui('不可用：密钥无效，请检查接口地址并重新粘贴完整的密钥'),
  expired: () => ui('不可用：密钥已过期，请重新获取并粘贴'),
  'invalid-url': () => ui('不可用：接口地址格式不对，请填写以 http:// 或 https:// 开头的地址'),
  unreachable: () => ui('没有验证成功：连不上云端接口，请检查网络或接口地址'),
  unavailable: () => ui('没有验证成功：云端服务暂时不可用，请稍后再试'),
  missing: () => ui('还没有保存密钥'),
};
const tokenResultText = result => TEST_TEXT[result.state]?.() || uiMessage(result.message || ui('没有返回原因'));

const hostOf = url => {
  try { return new URL(url || DEFAULT_BASE_URL).host; }
  catch { return 'mineru.net'; }
};

export default function MineruSettings({ initialLocal = null, initialPlan = null, initialSettings = null, initialMore = false, pickDirectory }) {
  useInjectCss(css, 'study-mineru');
  const { call } = useStudy();
  const toast = useToast();
  const baseUrlId = useId();
  const modeGroup = useId();
  const { local, settings, setSettings } = useMineruState({ call, initialLocal, initialSettings, enabled: typeof call === 'function' });
  const [mode, setMode] = useState(() => (initialSettings?.mode === 'cloud' ? 'cloud' : 'local'));
  const [baseUrlInput, setBaseUrlInput] = useState(() => initialSettings?.baseUrl || '');
  const [savingMode, setSavingMode] = useState(false);
  const [savingUrl, setSavingUrl] = useState(false);
  const [savingAck, setSavingAck] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (settings?.mode === 'cloud' || settings?.mode === 'local') setMode(settings.mode);
  }, [settings?.mode]);
  useEffect(() => {
    if (typeof settings?.baseUrl === 'string') setBaseUrlInput(settings.baseUrl);
  }, [settings?.baseUrl]);

  const savePatch = async patch => {
    if (typeof call !== 'function') return null;
    const next = await call('mineru.settings.set', patch);
    setSettings(next);
    return next;
  };

  const selectMode = async nextMode => {
    setMode(nextMode);
    if (typeof call !== 'function') return;
    setSavingMode(true); setError('');
    try {
      await savePatch({ mode: nextMode });
    } catch (failure) {
      setMode(settings?.mode === 'cloud' ? 'cloud' : 'local');
      setError(errorMessage(failure));
    } finally {
      setSavingMode(false);
    }
  };

  const saveBaseUrl = async event => {
    event.preventDefault();
    if (typeof call !== 'function') return;
    setSavingUrl(true); setError('');
    try {
      const next = await savePatch({ baseUrl: baseUrlInput.trim() });
      toast?.success?.(next?.baseUrl ? ui('已保存云端接口地址。') : ui('已恢复为 MinerU 官方默认接口地址。'));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSavingUrl(false);
    }
  };

  const withdrawAck = async () => {
    if (typeof call !== 'function') return;
    setSavingAck(true); setError('');
    try {
      await savePatch({ acknowledge: false });
      toast?.success?.(ui('已撤回上传确认；下次云端解析前会再弹出确认对话框。'));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSavingAck(false);
    }
  };

  const effectiveUrl = settings?.effectiveBaseUrl || DEFAULT_BASE_URL;
  const endpoint = hostOf(effectiveUrl);
  const urlDirty = baseUrlInput.trim() !== (settings?.baseUrl || '');

  return (
    <SettingsSection className="mineru-settings" tour="settings-mineru" title={ui('PDF 转换（MinerU）')}
      lead={ui('把 PDF 转成带页码的文字：支持扫描件、公式、表格和中文。默认在本机解析、不上传；也可以改用云端或兼容的第三方接口。')}>
      <RadioCardGroup legend={ui('解析方式')} disabled={savingMode}>
        <RadioCard name={`${modeGroup}-mode`} value="local" checked={mode === 'local'} onSelect={selectMode}
          title={ui('本机（默认）')}
          badges={<Badge size="sm" tone="success">{ui('不上传')}</Badge>}
          hint={ui('在这台电脑上解析，不上传任何内容')} />
        <RadioCard name={`${modeGroup}-mode`} value="cloud" checked={mode === 'cloud'} onSelect={selectMode}
          title={ui('云端（会把文件上传）')}
          badges={settings?.token?.set ? <Badge size="sm" tone="info">{uiFormat('已保存 {0}', [settings.token.hint])}</Badge> : <Badge size="sm">{ui('可选')}</Badge>}
          hint={ui('使用 MinerU 官方或兼容的第三方接口，免本机下载大模型')} />
      </RadioCardGroup>

      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      {mode === 'local' ? (
        <MineruInstallCard initialLocal={local} initialPlan={initialPlan} initialMore={initialMore} pickDirectory={pickDirectory} />
      ) : (
        <div className="mineru-cloud" data-route="cloud">
          <InlineMessage tone="info">
            {ui('云端解析会把 PDF 文件上传到下面配置的接口。留空接口地址则默认使用 MinerU 官方服务。')}
          </InlineMessage>

          <form className="mineru-cloud__url-form" onSubmit={saveBaseUrl}>
            <Field label={ui('接口地址（baseUrl）')} htmlFor={baseUrlId}
              hint={ui('留空使用 MinerU 官方地址（https://mineru.net/api/v4）；也可填写兼容 MinerU API 的第三方 http:// 或 https:// 地址。')}>
              <div className="mineru-cloud__url-row">
                <TextInput id={baseUrlId} type="url" value={baseUrlInput} disabled={savingUrl || !call}
                  placeholder={settings?.defaultBaseUrl || DEFAULT_BASE_URL}
                  onChange={event => { setBaseUrlInput(event.target.value); if (error) setError(''); }} />
                <Button type="submit" variant="secondary" size="sm" busy={savingUrl} disabled={!call || !urlDirty}>
                  {ui('保存地址')}
                </Button>
              </div>
            </Field>
          </form>

          <SecretKeyForm name="mineru-token" label={ui('云端密钥（Key）')}
            placeholder={ui('粘贴 MinerU 令牌或第三方接口密钥（Key）')}
            saved={settings?.token} busy={!call} primary={true}
            resultText={tokenResultText}
            clearLabel={ui('清除已保存的密钥')}
            footnote={<p className="sh-secret__note">{ui('验证只发一次不含文档的请求；密钥只保存在 DSH 主目录里，不进学习库、备份或快照。')}</p>}
            onSave={token => savePatch({ token })}
            onClear={() => savePatch({ token: '' })}
            onVerify={() => Promise.resolve(call('mineru.test', {}))} />

          <div className="mineru-cloud__ack">
            {settings?.acknowledged ? (
              <>
                <p className="mineru-acked">
                  <Icon className="sh-icon--inline" name="success" />
                  {uiFormat('已确认上传至 {0}。', [endpoint])}
                </p>
                <Button variant="quiet" size="sm" busy={savingAck} disabled={!call} onClick={withdrawAck}>
                  {ui('撤回上传确认')}
                </Button>
              </>
            ) : (
              <Hint>{ui('首次开始云端解析时会弹出确认对话框，确认后才会上传文件。')}</Hint>
            )}
          </div>

          {settings?.settingsFile && (
            <Hint>{uiFormat('密钥保存在 {0}，不在学习库里，也不会出现在导出或备份中。', [settings.settingsFile])}</Hint>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
