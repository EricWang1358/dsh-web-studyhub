import React, { useEffect, useRef, useState } from 'react';
import { ui } from './i18n.js';
import Markdown from './Markdown.jsx';
import { Button, InlineMessage } from './components/index.js';
import { useSciencePreferences } from './SciencePreferences.jsx';
import { SCIENCE_DEFAULTS, FORMULA_SCALES, IMAGE_HEIGHTS } from './science-settings.js';

function ChemistryTool() {
  const [input, setInput] = useState('H2 + O2 -> H2O');
  const [result, setResult] = useState(null), [working, setWorking] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  async function run(event) {
    event.preventDefault();
    const token = ++request.current; setWorking(true); setResult(null);
    try {
      const { balanceEquation } = await import('../lib/chemistry-balance.js');
      const next = balanceEquation(input);
      if (request.current === token) setResult(next);
    } catch { if (request.current === token) setResult({ status: 'not_checked' }); }
    finally { if (request.current === token) setWorking(false); }
  }
  return <section className="science-tool" aria-label={ui('化学自动配平')}>
    <h3>{ui('化学自动配平')}</h3>
    <p className="settings-section__note">{ui('支持中性分子、括号下标和物态；只验证元素守恒，不判断反应能否发生。离子、氧化还原半反应和多解反应暂不自动配平。')}</p>
    <form onSubmit={run}><label>{ui('反应方程式')}<input value={input} maxLength={512}
      onChange={event => { request.current++; setInput(event.target.value); setResult(null); setWorking(false); }} /></label>
      <Button type="submit" variant="secondary" busy={working} disabled={!input.trim()}>{ui('配平方程式')}</Button></form>
    {result && <div className="science-result" aria-live="polite">
      <InlineMessage tone={result.status === 'balanced' ? 'success' : 'warning'}>
        {ui(result.status === 'balanced' ? '已配平：两侧元素数量一致。' : result.status === 'not_balanced' ? '这些物质无法得到全部为正的配平系数。' : '暂不能可靠配平；请检查写法或缩小表达式。')}
      </InlineMessage>
      {result.equation && <Markdown text={'$$\\ce{' + result.equation + '}$$'} />}
    </div>}
  </section>;
}
function SymbolicTool() {
  const [left, setLeft] = useState('(x + 1)^2'), [right, setRight] = useState('x^2 + 2*x + 1');
  const [result, setResult] = useState(null), [working, setWorking] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  function edit(setter, value) { request.current++; setter(value); setResult(null); setWorking(false); }
  async function run(event) {
    event.preventDefault();
    const token = ++request.current; setWorking(true); setResult(null);
    try {
      const { proveIdentity } = await import('../lib/symbolic-proof.js');
      const next = proveIdentity(left, right);
      if (request.current === token) setResult(next);
    } catch { if (request.current === token) setResult({ status: 'not_checked' }); }
    finally { if (request.current === token) setWorking(false); }
  }
  return <section className="science-tool" aria-label={ui('代数恒等式证明')}>
    <h3>{ui('代数恒等式证明')}</h3>
    <p className="settings-section__note">{ui('用精确分数展开并比较多项式。支持加减乘、常数除法及有限整数幂；函数、变量分母和一般定理暂不支持。多字母名称视为一个变量，乘法可写 *。')}</p>
    <form onSubmit={run}><div className="two-col">
      <label>{ui('等式左侧')}<input value={left} maxLength={512} onChange={event => edit(setLeft, event.target.value)} /></label>
      <label>{ui('等式右侧')}<input value={right} maxLength={512} onChange={event => edit(setRight, event.target.value)} /></label>
    </div><Button type="submit" variant="secondary" busy={working} disabled={!left.trim() || !right.trim()}>{ui('验证恒等式')}</Button></form>
    {result && <div className="science-result" aria-live="polite">
      <InlineMessage tone={result.status === 'proved' ? 'success' : 'warning'}>
        {ui(result.status === 'proved' ? '恒等式已证明；结果适用于下列条件。' : result.status === 'disproved' ? '展开结果不同，不是恒等式。' : '暂不能可靠证明；请检查写法或缩小表达式。')}
      </InlineMessage>
      {result.left && <><p>{ui('左侧展开')}<code>{result.left}</code></p><p>{ui('右侧展开')}<code>{result.right}</code></p></>}
      {result.assumptions?.length > 0 && <details><summary>{ui('适用条件')}</summary><ul>{result.assumptions.map((line, i) => <li key={i}>{line}</li>)}</ul></details>}
      {result.steps?.length > 0 && <details><summary>{ui('证明过程')}</summary><ol>{result.steps.map((line, i) => <li key={i}>{line}</li>)}</ol></details>}
    </div>}
  </section>;
}
export default function ScienceSettings({ onChange }) {
  const settings = useSciencePreferences();
  const choose = (key, value) => onChange?.({ ...settings, [key]: value });
  const switches = [['imageCaptions', '显示图片说明'], ['imageEnlarge', '点击图片放大'], ['localImages', '启用本地图片插入'], ['chemistry', '启用化学自动配平'], ['symbolic', '启用代数恒等式证明']];
  return <fieldset className="settings-section science-settings" data-tour="settings-science">
    <legend className="settings-section__title">{ui('公式、图片与计算工具')}</legend>
    <p className="settings-section__lead">{ui('修改立即生效并保存在当前浏览器；独立于阅读字号。配平和证明在本地计算，不调用模型。')}</p>
    <div className="settings-field"><label>{ui('公式大小')}<select aria-label={ui('公式大小')} value={settings.formulaScale} onChange={event => choose('formulaScale', Number(event.target.value))}>
      {FORMULA_SCALES.map(value => <option key={value} value={value}>{value}%</option>)}
    </select></label></div>
    <div className="settings-field"><label>{ui('公式对齐')}<select aria-label={ui('公式对齐')} value={settings.formulaAlign} onChange={event => choose('formulaAlign', event.target.value)}>
      <option value="center">{ui('居中')}</option><option value="left">{ui('靠左')}</option>
    </select></label></div>
    <div className="settings-field"><label>{ui('图片最大高度')}<select aria-label={ui('图片最大高度')} value={settings.imageHeight} onChange={event => choose('imageHeight', Number(event.target.value))}>
      {IMAGE_HEIGHTS.map(value => <option key={value} value={value}>{value} px</option>)}
    </select></label></div>
    {switches.map(([key, title]) => <label key={key} className="inline-check"><input type="checkbox" checked={settings[key]}
      onChange={event => choose(key, event.target.checked)} />{ui(title)}</label>)}
    <div className="settings-actions"><Button variant="quiet" onClick={() => onChange?.({ ...SCIENCE_DEFAULTS })}>{ui('恢复默认')}</Button></div>
    <div className="science-preview"><span className="muted small">{ui('公式预览')}</span><Markdown text={String.raw`$$\frac{x^2 + 2x + 1}{2}$$`} /></div>
    {settings.chemistry && <ChemistryTool />}
    {settings.symbolic && <SymbolicTool />}
  </fieldset>;
}
