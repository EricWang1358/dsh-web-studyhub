import { ui } from "./i18n.js";
import React from "react";

export default function EmptyStudyActions({ data, busy, onStart, onLibrary, onCreate, onSources }) {
  const canStudy = data?.decks?.some((deck) => !deck.archived);
  return <div className="study-empty-actions">
    {canStudy ? <button className="primary" disabled={busy} onClick={onStart}>{ui("开始学习")}</button>
      : data?.drafts?.length ? <button className="primary" disabled={busy} onClick={onLibrary}>{ui("查看待发布草稿")}</button>
        : <>
          <button className="primary" disabled={busy} onClick={onCreate}>{ui("创建题组")}</button>
          <button disabled={busy} onClick={onSources}>{ui("添加学习资料")}</button>
        </>}
  </div>;
}
