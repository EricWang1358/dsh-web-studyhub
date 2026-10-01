import { ui, uiFormat } from "./i18n.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import noteCss from "./blog-notes.css";
import { useInjectCss } from "./shared.js";
import { renderNoteMarkdown } from "./note-markdown.js";
import PageScope, { usePageScope } from './PageScope.jsx';
import { draftKey, readDraft, writeDraft, clearDraft } from './writing-drafts.js';

const editorExtensions = [markdown()];
const csdnEditor = "https://mp.csdn.net/mp_blog/creation/editor";

export default function BlogNotes({ data, call, act, initialId, onSelect, onBack, backLabel, onOpenCard, theme = "dark" }) {
  useInjectCss(noteCss, "study-blog-notes");
  const [rememberedId, rememberId] = usePageScope(data.root, 'notes-open', '');
  const [id, changeId] = useState(initialId || rememberedId), [note, setNote] = useState(null);
  const [course, setCourse] = usePageScope(data.root, 'notes', data.focus?.course ?? '*');
  const [saving, setSaving] = useState(false), [publishing, setPublishing] = useState(false), [serverVersion, setServerVersion] = useState(null);
  const current = useRef(null), identity = useRef(null), pending = useRef(false);
  const setId = next => { changeId(next); rememberId(next); onSelect?.(next); };
  const [home, setHome] = useState(data.csdnHome || "");
  const [lookup, setLookup] = useState(null), [link, setLink] = useState("");
  const [query, setQuery] = useState(""), [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]), [newTitle, setNewTitle] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { if (initialId) changeId(initialId); }, [initialId]);
  useEffect(() => { rememberId(id); onSelect?.(id); }, [id, data.root, onSelect]); // eslint-disable-line react-hooks/exhaustive-deps
  function applyNote(next) { current.current = next; setNote(next); }
  function restore(next) {
    const key = draftKey(data.root, 'note', next.id);
    if (next.status === 'published') {
      clearDraft(key);
      setServerVersion(null);
      applyNote(next);
      return;
    }
    const recovery = readDraft(key);
    setServerVersion(recovery && recovery.value.baseRevision !== next.revision ? next : null);
    applyNote(recovery ? { ...next, ...recovery.value, revision: next.revision } : next);
    if (recovery) setMessage(ui('已恢复尚未保存的输入'));
  }
  useEffect(() => {
    const token = { root: data.root, id };
    identity.current = token;
    current.current = null;
    setNote(null); setLookup(null); setMessage(''); setSaving(false); setPublishing(false); setServerVersion(null); pending.current = false;
    if (id) call('note.get', { id }).then(next => { if (identity.current === token) restore(next); })
      .catch(error => { if (identity.current === token) setMessage(error.message); });
    return () => { if (identity.current === token) identity.current = null; };
  }, [call, data.root, id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Published longform is kept at the public article, including recovery copies.
  useEffect(() => {
    for (const item of data.notes || []) if (item.status === 'published') clearDraft(draftKey(data.root, 'note', item.id));
  }, [data.root, data.notes]);
  const summary = (data.notes || []).find((item) => item.id === id);
  useEffect(() => {
    if (!id || !summary || !(note?.generation?.status === 'running' && summary.generation?.status !== 'running' || summary.status === 'published' && note?.status !== 'published')) return;
    const token = identity.current;
    call('note.get', { id }).then(next => { if (identity.current === token) restore(next); })
      .catch(error => { if (identity.current === token) setMessage(error.message); });
  }, [call, id, note?.generation?.status, note?.status, summary?.generation?.status, summary?.status, summary?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => renderNoteMarkdown(note?.markdown || ""), [note?.markdown]);
  const notes = (data.notes || []).filter(item => course === '*' || (course === '' ? !item.courses?.length : item.courses?.includes(course)));
  function edit(patch) {
    const next = { ...current.current, ...patch };
    applyNote(next);
    try { writeDraft(draftKey(data.root, 'note', next.id), { title: next.title, markdown: next.markdown,
      cards: next.cards, baseRevision: next.revision }); }
    catch { setMessage(ui('浏览器暂存不可用，请及时保存草稿。')); }
  }
  async function persistCurrent() {
    const token = identity.current, submitted = current.current;
    const key = draftKey(data.root, 'note', submitted.id), recovery = readDraft(key);
    const saved = await call('note.save', { id: submitted.id, title: submitted.title,
      markdown: submitted.markdown, cards: submitted.cards, expectedRevision: submitted.revision });
    if (recovery) clearDraft(key, recovery.revision);
    if (identity.current !== token) return saved;
    if (current.current?.status === 'published') return saved;
    setServerVersion(null);
    if (current.current === submitted) applyNote(saved);
    else {
      // The save confirms only the submitted text. Keep later typing and move
      // its base revision forward so its next explicit save can succeed.
      applyNote({ ...current.current, revision: saved.revision });
      edit({});
    }
    return saved;
  }
  async function perform(work, { lockEditing = false } = {}) {
    if (pending.current) return;
    const token = identity.current;
    pending.current = true; setSaving(true); setPublishing(lockEditing);
    const live = () => identity.current === token;
    try { await work(live); }
    catch (error) { if (live()) setMessage(error.message); }
    finally { if (live()) { pending.current = false; setSaving(false); setPublishing(false); } }
  }
  async function save() {
    return perform(async live => { await persistCurrent(); if (live() && current.current?.status === 'draft') setMessage(ui('草稿已保存')); });
  }
  async function findPublished() {
    return perform(async live => {
      const saved = await persistCurrent();
      if (!live()) return;
      const result = await call('note.lookup', { id: saved.id, expectedRevision: saved.revision });
      if (!live()) return;
      if (result.linked) {
        restore(result.linked); setLookup(null);
        setMessage(ui("已找到新发布的公开文章，并关联到所选题目"));
      } else setLookup(result);
    }, { lockEditing: true });
  }
  async function addCard() {
    if (!query.trim()) return;
    const token = identity.current;
    try { const result = await call('card.search', { query, limit: 20, course });
      if (identity.current === token) setResults(result.results); }
    catch (error) { if (identity.current === token) setMessage(error.message); }
  }
  const linkArticle = async (url) => {
    return perform(async live => {
      const submitted = await persistCurrent();
      if (!live()) return;
      await act('note.link', { id: submitted.id, url, expectedRevision: submitted.revision }, (saved) => {
        clearDraft(draftKey(data.root, 'note', saved.id));
        if (!live()) return;
        applyNote(saved); setLookup(null); setMessage(ui("公开文章已关联到所选题目"));
      });
    }, { lockEditing: true });
  };
  return <section className="page blog-notes-page">
    <header className="section-heading"><h1 tabIndex={-1} data-context-heading>{ui("学习笔记")}</h1><button onClick={onBack}>{backLabel || ui("返回学习库")}</button></header>
    {message && <p role="status" className="muted">{message}</p>}
    {!note && <div className="note-list">
      <PageScope courses={data.focus?.courses} value={course} onChange={setCourse} />
      <details className="note-linking"><summary>{ui("＋ 挑题成文")}</summary>
        <label>{ui("笔记标题")}<input value={newTitle} placeholder={ui("写一个可公开的知识点标题")}
          onChange={(event) => setNewTitle(event.target.value)} /></label>
        <div className="note-card-search"><input value={query} placeholder={ui("搜索题目或知识点")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addCard(); }} />
          <button onClick={addCard}>{ui("搜索题目")}</button></div>
        {results.map((item) => <label key={item.cardId} className="note-search-result">
          <input type="checkbox" checked={picked.some((ref) => ref.cardId === item.cardId)}
            onChange={(event) => setPicked(event.target.checked
              ? [...picked, { deckId: item.deckId, cardId: item.cardId }]
              : picked.filter((ref) => ref.cardId !== item.cardId))} />
          {item.prompt}</label>)}
        <button className="primary" disabled={!newTitle.trim() || !picked.length}
          onClick={() => act("note.create", { title: newTitle, cards: picked }, (created) => {
            setId(created.id); setPicked([]); setNewTitle(""); setResults([]);
          })}>{uiFormat("创建笔记草稿 · {0} 题", [picked.length])}</button>
      </details>
      {notes.length ? notes.map((item) => <button key={item.id} onClick={() => setId(item.id)}>
        <strong>{item.title}</strong><small>{item.cardCount}{ui(" 题 · ")}{item.status === "published" ? ui("已发布笔记") : ui("笔记草稿")}</small>
      </button>) : <p className="muted">{ui("做题时选择“写笔记”，或在这里搜索并挑选题目。")}</p>}
    </div>}
    {note && <>
      <div className="note-actions">
        <button onClick={() => { setId(""); setLookup(null); }}>{ui("全部笔记")}</button>
        <button className="primary" disabled={saving || note.status === "published" || note.generation?.status === "running"} onClick={save}>{ui("保存草稿")}</button>
        {note.status === "draft" && <button disabled={saving || note.generation?.status === "running"}
          onClick={() => perform(async live => {
              const saved = await persistCurrent();
              if (!live()) return;
              await act('note.generate', { id: saved.id, expectedRevision: saved.revision }, () => {
                if (!live()) return;
                applyNote({ ...current.current, generation: { status: 'running' } });
                setMessage(ui("正在后台起草；完成后会进入信箱，你可以继续学习。"));
              });
          })}>{ui("AI 起草解析")}</button>}
        {note.status === "draft" && <button disabled={saving || note.generation?.status === "running"} onClick={() => perform(async live => {
          const editorTab = window.open("", "_blank");
          try {
            const saved = await persistCurrent();
            if (!live()) { editorTab?.close(); return; }
            let lookupHint = "";
            try { const prepared = await call("note.preparePublish", { id: saved.id });
              lookupHint = prepared.reason || ""; }
            catch (error) { lookupHint = error.message; }
            await navigator.clipboard.writeText(saved.markdown);
            if (editorTab) { editorTab.opener = null; editorTab.location.href = csdnEditor; }
            else window.open(csdnEditor, "_blank", "noopener,noreferrer");
            if (live()) setMessage(uiFormat("草稿已保存，Markdown 已复制；请在 CSDN 审阅并发布。{0}",[lookupHint]));
          } catch (error) { editorTab?.close(); throw error; }
        })}>{ui("复制内容并打开 CSDN")}</button>}
        {note.status === "draft" && <button disabled={saving} onClick={findPublished}>{ui("查找已发布文章")}</button>}
      </div>
      {note.generation?.status === "failed" && <p role="alert">{ui("起草失败：")}{note.generation.message}</p>}
      {serverVersion && <details className="note-linking"><summary>{ui('已保存版本有更新，展开核对；你的输入已保留')}</summary>
        <strong>{serverVersion.title}</strong><article className="note-preview" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(serverVersion.markdown || '') }} />
      </details>}
      <label className="note-title">{ui("文章标题")}<input value={note.title} disabled={publishing || note.status === "published" || note.generation?.status === "running"}
        onChange={(event) => edit({ title: event.target.value })} /></label>
      <p className="muted">{ui("公开文章请使用通用案例，不写课程、PPT 或个人信息。原题关联只保存在学习库。")}</p>
      {note.status === "draft" && <div className="note-editor">
        <div className="note-edit-pane"><strong>{ui("编辑 Markdown")}</strong>
          <CodeMirror value={note.markdown} height="560px" theme={theme === "light" ? "light" : "dark"} extensions={editorExtensions}
            editable={!publishing && note.status !== "published" && note.generation?.status !== "running"} onChange={(value) => edit({ markdown: value })} /></div>
        <div className="note-preview-pane"><strong>{ui("实时预览")}</strong>
          <article className="note-preview" dangerouslySetInnerHTML={{ __html: preview }} /></div>
      </div>}
      <details className="note-linking"><summary>{uiFormat("关联题目 · {0} 题", [note.cards.length])}</summary>
        <ul>{note.cards.map((ref) => <li key={ref.cardId}>
          <button disabled={ref.missing || !onOpenCard} onClick={() => onOpenCard(ref)}>{ref.missing ? ui('原题已移除') : ref.prompt || ui('查看原题')}</button>
          {ref.deckTitle && <small className="muted">{ref.deckTitle}</small>}
          {note.status === "draft" && <button onClick={() => edit({
            cards: note.cards.filter((item) => item.cardId !== ref.cardId) })}>{ui("移除")}</button>}</li>)}</ul>
        {note.status === "draft" && <><div className="note-card-search"><input value={query}
          placeholder={ui("搜索题目或知识点")} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addCard(); }} />
          <button onClick={addCard}>{ui("搜索题目")}</button></div>
          {results.map((item) => <button key={item.cardId} className="note-search-result"
            disabled={note.cards.some((ref) => ref.cardId === item.cardId)}
            onClick={() => edit({ cards: [...note.cards, { deckId: item.deckId, cardId: item.cardId, prompt: item.prompt }] })}>
            {item.prompt} <small>{ui("＋ 添加")}</small></button>)}</>}
      </details>
      <details className="note-publish"><summary>{ui("CSDN 公开主页与文章链接")}</summary>
        <div className="note-card-search"><input value={home} placeholder={ui("https://blog.csdn.net/用户名")}
          onChange={(event) => setHome(event.target.value)} />
          <button onClick={() => act("note.home", { home }, () => setMessage(ui("公开主页已保存")))}>{ui("保存主页")}</button></div>
        {lookup?.reason && <p>{lookup.reason}</p>}
        {lookup?.matches?.map((url) => <button key={url} onClick={() => linkArticle(url)}>{ui("确认这篇文章 · ")}{url}</button>)}
        {note.publicUrl && <p><a href={note.publicUrl} target="_blank" rel="noopener noreferrer">{ui("打开已发布文章 ↗")}</a></p>}
        {note.status === "draft" && <div className="note-card-search"><input value={link}
          placeholder={ui("找不到时粘贴文章链接")} onChange={(event) => setLink(event.target.value)} />
          <button disabled={saving || !link.trim()} onClick={() => linkArticle(link)}>{ui("手动关联")}</button></div>}
      </details>
    </>}
  </section>;
}
