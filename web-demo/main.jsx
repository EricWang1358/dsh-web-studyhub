import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/style.css';
import '../ui/audio-dashboard.css';
import App from '../ui/App.jsx';
import { setUiLanguage, useUiLanguage } from '../ui/i18n.js';
import { call } from './transport.js';
import { resetDemo } from './store.js';
import './banner.css';
try { if (!localStorage.getItem('study-ui-language')) setUiLanguage('en'); } catch { setUiLanguage('en'); }
function Demo() {
  const language=useUiLanguage(), [reset,setReset]=useState(false), dialog=useRef(null);
  const t=(en,zh)=>language==='en'?en:zh;
  useEffect(()=>{document.documentElement.lang=language==='en'?'en':'zh-CN';},[language]);
  useEffect(()=>{if(reset)dialog.current?.showModal();},[reset]);
  return <><div className="public-demo-banner"><div><strong>{t('Interactive demo','交互体验版')}</strong><span>{t('Sample history & preset AI · no API key · changes stay in this browser','含示例学习记录与预置 AI 内容 · 无需 API Key · 修改仅存于本浏览器')}</span></div><button onClick={()=>setReset(true)}>{t('Reset demo','重置体验')}</button></div>
    <App call={call} host={{defaultContentLanguage:"English",sessionModel:t('Preset demo — no model calls','预置演示 — 不调用模型')}}/>
    {reset&&<dialog ref={dialog} className="public-demo-dialog" onCancel={()=>setReset(false)} aria-labelledby="demo-reset-title"><h2 id="demo-reset-title">{t('Reset this demo?','重置体验？')}</h2><p>{t('This clears only the sample library and practice records in this browser. Your language choice is kept.','只清除本浏览器的示例题库和练习记录，保留语言选择。')}</p><button onClick={()=>setReset(false)}>{t('Cancel','取消')}</button><button onClick={()=>{resetDemo();location.reload();}}>{t('Reset','重置')}</button></dialog>}
  </>;
}
createRoot(document.getElementById('root')).render(<Demo/>);
