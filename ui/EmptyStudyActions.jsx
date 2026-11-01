import { ui } from "./i18n.js";
import React from "react";
import { Button } from "./components/index.js";
import { useStudy } from "./study-context.jsx";

export default function EmptyStudyActions({ data, onStart, onLibrary, onCreate, onSources }) {
  const { busy } = useStudy();
  const canStudy = data?.decks?.some((deck) => !deck.archived);
  return <div className="study-empty-actions">
    {canStudy ? <Button variant="primary" lock={busy} onClick={onStart}>{ui("开始学习")}</Button>
      : data?.drafts?.length ? <Button variant="primary" lock={busy} onClick={onLibrary}>{ui("查看待发布草稿")}</Button>
        : <>
          <Button variant="primary" lock={busy} onClick={onCreate}>{ui("创建题组")}</Button>
          <Button lock={busy} onClick={onSources}>{ui("添加资料")}</Button>
        </>}
  </div>;
}
