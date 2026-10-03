import React from "react";
import { Button, PageHeader } from "./components/index.js";
import { useUiLanguage } from "./i18n.js";

/** The 音频转写 page's header: the shared PageHeader, its two links to neighbouring pages as quiet Buttons. */
export function AudioPageHeader({ onSettings, onSources }) {
  const en = useUiLanguage() === "en";
  return <PageHeader title={en ? "Audio transcription" : "音频转写"}
    description={en ? "Import a recording. Transcription, proofreading and translation run in the background; updates arrive in your inbox." : "导入录音文件，后台完成转录、校对和翻译；进度与完成通知会进入信箱。"}
    actions={<>
      <Button variant="quiet" onClick={onSettings}>{en ? "Audio settings" : "音频设置"}</Button>
      <Button variant="quiet" onClick={onSources}>{en ? "View sources" : "查看资料"}</Button>
    </>} />;
}
