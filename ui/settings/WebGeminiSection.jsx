import React, { useEffect, useState } from 'react';
import { errorMessage, ui, uiFormat } from '../i18n.js';
import { Button, Field, Hint, InlineMessage, NumberInput, Select, Switch, useToast } from '../components/index.js';
import { useAsyncAction } from '../use-async.js';
import { useStudy } from '../study-context.jsx';

/* Settings › 学习库与模型: route non-concurrent, single-shot, tool-less subagent/job calls
   through an installed web-Gemini MCP bridge (e.g. ask-gemini-mcp / ask_gemini_web). */

const FALLBACK_STATUS = Object.freeze({
  enabled: false,
  toolName: '',
  waitSeconds: 600,
  minWaitSeconds: 30,
  maxWaitSeconds: 1800,
  effectiveTool: null,
  missing: null,
  available: false,
  hasToolRegistry: false,
  tools: [],
  active: false,
});

function toolOptionLabel(tool) {
  if (!tool?.name) return '';
  const base = tool.server ? `${tool.server} · ${tool.label || tool.name}` : (tool.label || tool.name);
  return tool.matched ? `${base} (${ui('推荐')})` : base;
}

export default function WebGeminiSection({ initialStatus = null }) {
  const toast = useToast();
  const { call } = useStudy();
  const [status, setStatus] = useState(initialStatus);
  const [waitDraft, setWaitDraft] = useState(null);
  const [probe, setProbe] = useState(null);
  const { run, working, error } = useAsyncAction({ exclusive: true });

  useEffect(() => {
    if (initialStatus) {
      setStatus(initialStatus);
      return undefined;
    }
    let active = true;
    Promise.resolve()
      .then(() => call?.('webGemini.status', {}))
      .then(next => { if (active && next && typeof next === 'object') setStatus(next); })
      .catch(() => {});
    return () => { active = false; };
  }, [call, initialStatus]);

  const current = status || FALLBACK_STATUS;
  const minWait = current.minWaitSeconds ?? 30;
  const maxWait = current.maxWaitSeconds ?? 1800;
  const shownWait = waitDraft ?? String(current.waitSeconds ?? 600);
  const parsedWait = Number(shownWait);
  const validWait = Number.isInteger(parsedWait) && parsedWait >= minWait && parsedWait <= maxWait;
  const dirtyWait = waitDraft !== null && parsedWait !== current.waitSeconds;

  const refresh = () => run('refresh', async () => {
    const next = await call('webGemini.status', {});
    if (next && typeof next === 'object') setStatus(next);
  });

  const toggleEnabled = checked => {
    setProbe(null);
    return run('toggle', async () => {
      const next = await call('webGemini.set', { enabled: checked === true });
      setStatus(next);
      toast.success(ui(next?.enabled ? '已开启网页 Gemini 代理' : '已关闭网页 Gemini 代理'));
    });
  };

  const selectTool = value => {
    setProbe(null);
    return run('tool', async () => {
      const next = await call('webGemini.set', { toolName: value });
      setStatus(next);
      toast.success(ui('已更新网页 Gemini 工具选择'));
    });
  };

  const saveWait = event => {
    event?.preventDefault?.();
    if (!validWait) return undefined;
    return run('wait', async () => {
      const next = await call('webGemini.set', { waitSeconds: parsedWait });
      setStatus(next);
      setWaitDraft(null);
      toast.success(ui('已保存网页等待时长'));
    });
  };

  const testConnection = () => {
    setProbe(null);
    return run('test', async () => {
      const result = await call('webGemini.test', {
        toolName: current.toolName,
        ...(validWait ? { waitSeconds: parsedWait } : {}),
      });
      setProbe(result);
    });
  };

  const toolOptions = [
    { value: '', label: ui('自动识别（优先 ask_gemini_web）') },
    ...(current.tools || []).map(tool => ({ value: tool.name, label: toolOptionLabel(tool) })),
    ...(current.missing ? [{ value: current.missing, label: `${current.missing} (${ui('当前未检测到')})` }] : []),
  ];

  return (
    <section className="web-gemini" data-tour="settings-web-gemini">
      <div className="web-gemini__head">
        <h3 className="settings-subtitle">{ui('网页 Gemini 代理（ask-gemini-mcp）')}</h3>
        <Hint>{ui('将无需调用工具的非并发单次子代理任务（知识骨架、讲解生成、每日合集、生成笔记、书籍 AI、案例卡与助教）交给网页 Gemini MCP 执行。并发批量出题、逐块翻译、音频与轻量提示仍走原模型。')}</Hint>
      </div>

      {status && current.missing && (
        <InlineMessage tone="warning" boxed title={uiFormat('已选网页工具「{0}」当前未检测到', [current.missing])}>
          {ui('请确认 DSH 中已启用该 MCP 服务器并打开了网页端，或改回自动识别。')}
        </InlineMessage>
      )}

      {status && !current.missing && current.available && current.enabled && (
        <InlineMessage tone="success" boxed title={uiFormat('网页 Gemini 代理已就绪：{0}', [current.effectiveTool])}>
          {ui('同一时间会按队列串行发送请求，避免单个浏览器标签页冲突。')}
        </InlineMessage>
      )}

      {status && !current.available && !current.missing && (
        <InlineMessage tone="info" boxed title={ui('尚未检测到网页 Gemini MCP 工具')}>
          {ui('在 DSH 配置并启用 ask-gemini-mcp（ask_gemini_web）后，点「重新检测工具」即可使用。')}
        </InlineMessage>
      )}

      <Switch
        name="webGeminiEnabled"
        label={ui('将非并发单次无工具子代理任务交给网页 Gemini')}
        hint={ui('开启后，优先通过 DSH 中的 ask-gemini-mcp 网页端执行上述单次任务。')}
        checked={current.enabled === true}
        disabled={!!working}
        onChange={toggleEnabled}
      />

      <div className="web-gemini__controls">
        <Field label={ui('网页 MCP 工具')} hint={ui('默认自动识别 ask_gemini_web；如注册了自定义 MCP 工具名称，可在这里手动指定。')}>
          <Select value={current.toolName || ''} disabled={!!working} options={toolOptions} onChange={selectTool} />
        </Field>

        <form className="web-gemini__wait-form" onSubmit={saveWait}>
          <Field
            label={ui('等待回答超时时长')}
            error={waitDraft !== null && !validWait ? uiFormat('请填写 {0}–{1} 之间的整数秒', [minWait, maxWait]) : undefined}
            hint={ui('网页普通模式建议 180 秒，开启 Extended Thinking 深度思考建议设为 600 秒及以上。')}
          >
            <NumberInput
              name="webGeminiWaitSeconds"
              min={minWait}
              max={maxWait}
              step={10}
              suffix={ui('秒')}
              value={shownWait}
              disabled={!!working}
              invalid={waitDraft !== null && !validWait}
              onChange={event => setWaitDraft(event.target.value)}
            />
          </Field>
          <Button variant="secondary" type="submit" busy={working === 'wait'} disabled={!!working || !dirtyWait || !validWait}>
            {ui('保存等待时长')}
          </Button>
        </form>
      </div>

      <div className="web-gemini__actions">
        <Button variant="primary" busy={working === 'test'} disabled={!!working} onClick={testConnection}>
          {ui('手动测试连通与回答')}
        </Button>
        <Button variant="secondary" busy={working === 'refresh'} disabled={!!working} onClick={refresh}>
          {ui('重新检测工具')}
        </Button>
      </div>

      {error && <InlineMessage tone="error" role="alert">{errorMessage(error)}</InlineMessage>}

      {probe?.ok && (
        <InlineMessage
          tone="success"
          boxed
          className="web-gemini__probe"
          title={uiFormat('测试通过：网页已连通并回答（用时 {0} 秒 · {1}）', [((probe.latencyMs || 0) / 1000).toFixed(1), probe.toolName])}
        >
          {probe.reply ? uiFormat('回答预览：{0}', [probe.reply]) : ui('网页端已返回有效回答。')}
        </InlineMessage>
      )}

      {probe && !probe.ok && (
        <InlineMessage
          tone="error"
          boxed
          className="web-gemini__probe"
          title={uiFormat('测试未通过（{0}）', [probe.toolName || 'ask-gemini-mcp'])}
        >
          {errorMessage(probe.message) || ui('未能收到网页回答，请检查 Chrome 扩展与 Gemini 页面是否就绪。')}
        </InlineMessage>
      )}
    </section>
  );
}
