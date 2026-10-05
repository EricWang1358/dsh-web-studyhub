import React, { useState } from "react";
import { errorMessage, ui, uiFormat } from "../i18n.js";
import { useLiveEffect } from "../use-async.js";
import { Button, Hint, InlineMessage } from "../components/index.js";
import { formatBytes, formatDateTime } from "../format.js";

/** Search the session workspace for audio, like @ in the composer: type a few letters, pick one. */
export default function AudioWorkspace({ call, onPick }) {
  const [state, setState] = useState({ status: "idle", files: [], truncated: false, error: "" });
  const [query, setQuery] = useState(""), [opened, setOpened] = useState(false);
  useLiveEffect((alive) => {
    if (!opened || !call) return;
    const timer = setTimeout(() => {
      setState((previous) => ({ ...previous, status: "loading" }));
      call("audio.files", { query }).then(
        (result) => alive() && setState({ status: "ready", files: result.files || [], truncated: !!result.truncated, error: "" }),
        (error) => alive() && setState({ status: "error", files: [], truncated: false, error: errorMessage(error) }));
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [call, opened, query]);
  return (
    <details className="audio-workspace" onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>{ui("从工作区里找")}</summary>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ui("搜索文件名")} aria-label={ui("搜索文件名")} />
      {state.status === "loading" && !state.files.length && <Hint>{ui("正在查找…")}</Hint>}
      {state.status === "error" && <InlineMessage tone="error">{uiFormat("无法列出工作区里的文件：{0}", [state.error])}</InlineMessage>}
      {state.status === "ready" && !state.files.length && <Hint>{ui("工作区里没有找到音频文件。把录音放进工作区，或用上面的方式选择。")}</Hint>}
      {state.files.length > 0 && <ul className="audio-files">
        {state.files.map((file) => (
          <li key={file.path}>
            <Button variant="quiet" className="audio-file" onClick={() => onPick(file)}>
              <strong>{file.name}</strong>
              <small>{file.rel.slice(0, Math.max(0, file.rel.length - file.name.length)).replace(/[\\/]$/, "") || ui("工作区根目录")}</small>
              <small>{formatBytes(file.size)} · {formatDateTime(file.modified, "day")}</small>
            </Button>
          </li>
        ))}
      </ul>}
      {state.truncated && <Hint>{ui("只列出最近的一部分，请用搜索缩小范围。")}</Hint>}
    </details>
  );
}
