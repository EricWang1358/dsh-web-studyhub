import { ui } from "./i18n.js";
import React from "react";
import { Button } from "./components/index.js";

export default function EmptyStudyActions({ data, busy, onStart, onLibrary, onCreate, onSources }) {
  const canStudy = data?.decks?.some((deck) => !deck.archived);
  return <div className="study-empty-actions">
    {canStudy ? <Button variant="primary" disabled={busy} onClick={onStart}>{ui("开始学习")}</Button>
      : data?.drafts?.length ? <Button variant="primary" disabled={busy} onClick={onLibrary}>{ui("查看待发布草稿")}</Button>
        : <>
          <Button variant="primary" disabled={busy} onClick={onCreate}>{ui("创建题组")}</Button>
          <Button disabled={busy} onClick={onSources}>{ui("添加学习资料")}</Button>
        </>}
  </div>;
}
