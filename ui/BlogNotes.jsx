import React, { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import noteCss from "./blog-notes.css";
import { useInjectCss } from "./shared.js";
import { renderNoteMarkdown } from "./note-markdown.js";

const editorExtensions = [markdown()];
const csdnEditor = "https://mp.csdn.net/mp_blog/creation/editor";

export default function BlogNotes({ data, call, act, initialId, onBack, theme = "dark" }) {
  useInjectCss(noteCss, "study-blog-notes");
  const [id, setId] = useState(initialId || ""), [note, setNote] = useState(null);
  const [home, setHome] = useState(data.csdnHome || "");
  const [lookup, setLookup] = useState(null), [link, setLink] = useState("");
  const [query, setQuery] = useState(""), [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]), [newTitle, setNewTitle] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { if (initialId) setId(initialId); }, [initialId]);
  useEffect(() => {
    let active = true;
    if (!id) { setNote(null); return; }
    call("note.get", { id }).then((next) => { if (active) setNote(next); })
      .catch((error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [call, id]);
  const summary = (data.notes || []).find((item) => item.id === id);
  useEffect(() => {
    if (!id || note?.generation?.status !== "running" || !summary || summary.generation?.status === "running") return;
    call("note.get", { id }).then(setNote).catch((error) => setMessage(error.message));
  }, [call, id, note?.generation?.status, summary?.generation?.status, summary?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => renderNoteMarkdown(note?.markdown || ""), [note?.markdown]);
  async function persistCurrent() {
    const saved = await call("note.save", { id: note.id, title: note.title,
      markdown: note.markdown, cards: note.cards });
    setNote(saved);
    return saved;
  }
  async function save() {
    try {
      await persistCurrent(); setMessage("草稿已保存");
    } catch (error) { setMessage(error.message); }
  }
  async function findPublished() {
    try {
      await persistCurrent();
      const result = await call("note.lookup", { id: note.id });
      if (result.linked) {
        setNote(result.linked); setLookup(null);
        setMessage("已找到新发布的公开文章，并关联到所选题目");
      } else setLookup(result);
    }
    catch (error) { setLookup({ matches: [], reason: error.message }); }
  }
  async function addCard() {
    if (!query.trim()) return;
    try { setResults((await call("card.search", { query, limit: 20 })).results); }
    catch (error) { setMessage(error.message); }
  }
  const linkArticle = async (url) => {
    try {
      await persistCurrent();
      await act("note.link", { id: note.id, url }, (saved) => {
        setNote(saved); setLookup(null); setMessage("公开文章已关联到所选题目");
      });
    } catch (error) { setMessage(error.message); }
  };
  return <section className="page blog-notes-page">
    <header className="section-heading"><h1>学习笔记</h1><button onClick={onBack}>返回学习库</button></header>
    {!note && <div className="note-list">
      <details className="note-linking"><summary>＋ 挑题成文</summary>
        <label>笔记标题<input value={newTitle} placeholder="写一个可公开的知识点标题"
          onChange={(event) => setNewTitle(event.target.value)} /></label>
        <div className="note-card-search"><input value={query} placeholder="搜索题目或知识点"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addCard(); }} />
          <button onClick={addCard}>搜索题目</button></div>
        {results.map((item) => <label key={item.cardId} className="note-search-result">
          <input type="checkbox" checked={picked.some((ref) => ref.cardId === item.cardId)}
            onChange={(event) => setPicked(event.target.checked
              ? [...picked, { deckId: item.deckId, cardId: item.cardId }]
              : picked.filter((ref) => ref.cardId !== item.cardId))} />
          {item.prompt}</label>)}
        <button className="primary" disabled={!newTitle.trim() || !picked.length}
          onClick={() => act("note.create", { title: newTitle, cards: picked }, (created) => {
            setId(created.id); setPicked([]); setNewTitle(""); setResults([]);
          })}>创建笔记草稿 · {picked.length} 题</button>
      </details>
      {(data.notes || []).length ? data.notes.map((item) => <button key={item.id} onClick={() => setId(item.id)}>
        <strong>{item.title}</strong><small>{item.cardCount} 题 · {item.status === "published" ? "已发布笔记" : "笔记草稿"}</small>
      </button>) : <p className="muted">做题时选择“写笔记”，或在这里搜索并挑选题目。</p>}
    </div>}
    {note && <>
      <div className="note-actions">
        <button onClick={() => { setId(""); setLookup(null); }}>全部笔记</button>
        <button className="primary" disabled={note.status === "published" || note.generation?.status === "running"} onClick={save}>保存草稿</button>
        {note.status === "draft" && <button disabled={note.generation?.status === "running"}
          onClick={async () => {
            try {
              const saved = await persistCurrent();
              await act("note.generate", { id: note.id }, () => {
                setNote({ ...saved, generation: { status: "running" } });
                setMessage("正在后台起草；完成后会进入信箱，你可以继续学习。");
              });
            } catch (error) { setMessage(error.message); }
          }}>AI 起草解析</button>}
        {note.status === "draft" && <button disabled={note.generation?.status === "running"} onClick={async () => {
          const editorTab = window.open("", "_blank");
          try {
            const saved = await persistCurrent();
            let lookupHint = "";
            try { const prepared = await call("note.preparePublish", { id: note.id });
              lookupHint = prepared.reason || ""; }
            catch (error) { lookupHint = error.message; }
            await navigator.clipboard.writeText(saved.markdown);
            if (editorTab) { editorTab.opener = null; editorTab.location.href = csdnEditor; }
            else window.open(csdnEditor, "_blank", "noopener,noreferrer");
            setMessage(`草稿已保存，Markdown 已复制；请在 CSDN 审阅并发布。${lookupHint}`);
          } catch (error) { editorTab?.close(); setMessage(error.message); }
        }}>复制内容并打开 CSDN</button>}
        {note.status === "draft" && <button onClick={findPublished}>查找已发布文章</button>}
      </div>
      {note.generation?.status === "failed" && <p role="alert">起草失败：{note.generation.message}</p>}
      {message && <p role="status" className="muted">{message}</p>}
      <label className="note-title">文章标题<input value={note.title} disabled={note.status === "published" || note.generation?.status === "running"}
        onChange={(event) => setNote({ ...note, title: event.target.value })} /></label>
      <p className="muted">公开文章请使用通用案例，不写课程、PPT 或个人信息。原题关联只保存在学习库。</p>
      {note.status === "draft" && <div className="note-editor">
        <div className="note-edit-pane"><strong>编辑 Markdown</strong>
          <CodeMirror value={note.markdown} height="560px" theme={theme === "light" ? "light" : "dark"} extensions={editorExtensions}
            editable={note.status !== "published" && note.generation?.status !== "running"} onChange={(value) => setNote({ ...note, markdown: value })} /></div>
        <div className="note-preview-pane"><strong>实时预览</strong>
          <article className="note-preview" dangerouslySetInnerHTML={{ __html: preview }} /></div>
      </div>}
      <details className="note-linking"><summary>关联题目 · {note.cards.length} 题</summary>
        <ul>{note.cards.map((ref) => <li key={ref.cardId}>{ref.cardId}
          {note.status === "draft" && <button onClick={() => setNote({ ...note,
            cards: note.cards.filter((item) => item.cardId !== ref.cardId) })}>移除</button>}</li>)}</ul>
        {note.status === "draft" && <><div className="note-card-search"><input value={query}
          placeholder="搜索题目或知识点" onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addCard(); }} />
          <button onClick={addCard}>搜索题目</button></div>
          {results.map((item) => <button key={item.cardId} className="note-search-result"
            disabled={note.cards.some((ref) => ref.cardId === item.cardId)}
            onClick={() => setNote({ ...note, cards: [...note.cards, { deckId: item.deckId, cardId: item.cardId }] })}>
            {item.prompt} <small>＋ 添加</small></button>)}</>}
      </details>
      <details className="note-publish"><summary>CSDN 公开主页与文章链接</summary>
        <div className="note-card-search"><input value={home} placeholder="https://blog.csdn.net/用户名"
          onChange={(event) => setHome(event.target.value)} />
          <button onClick={() => act("note.home", { home }, () => setMessage("公开主页已保存"))}>保存主页</button></div>
        {lookup?.reason && <p>{lookup.reason}</p>}
        {lookup?.matches?.map((url) => <button key={url} onClick={() => linkArticle(url)}>确认这篇文章 · {url}</button>)}
        {note.publicUrl && <p><a href={note.publicUrl} target="_blank" rel="noopener noreferrer">打开已发布文章 ↗</a></p>}
        {note.status === "draft" && <div className="note-card-search"><input value={link}
          placeholder="找不到时粘贴文章链接" onChange={(event) => setLink(event.target.value)} />
          <button disabled={!link.trim()} onClick={() => linkArticle(link)}>手动关联</button></div>}
      </details>
    </>}
  </section>;
}
