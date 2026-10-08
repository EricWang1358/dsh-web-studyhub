import { ui, uiFormat, uiMessage, useUiLanguage } from "./i18n.js";
import React, { useEffect, useRef, useState } from "react";
import { parseCourses } from './CourseField.jsx';
import { Button, FileDrop, Hint, Icon, IconButton, InlineMessage, ProgressBar, useToast } from './components/index.js';
import { AudioSetupGate } from './AudioSettings.jsx';
import { openAudioSettings } from './audio-focus.js';
import { useInjectCss } from './shared.js';
import { TokenEstimate } from './TokenUsage.jsx';
import settingsCss from './audio-settings.css';
import audioCss from './audio/audio-import.css';
import { formatBytes } from './format.js';
import { baseName } from './file-names.js';
import { unquotePath } from './paths.js';
import { SUBTITLE_EXTENSIONS } from '../lib/audio-formats.js';
import { AudioJobs, aboutSettings } from './audio/AudioJobs.jsx';
import AudioWorkspace from './audio/AudioWorkspace.jsx';
import { AUDIO_ACCEPT, audioFileProblem, audioFormatNames, audioLimitLabel, isSubtitleName, pathsFromDrop, subtitleFormatNames, subtitleProblem } from './audio/formats.js';
import AudioMoreSettings from './audio/AudioMoreSettings.jsx';
import { inputOf, preflightNotes } from './audio/preflight.js';
import { estimateRequest, startLabel } from './audio/run-plan.js';
import { useAudioPreflight } from './audio/useAudioPreflight.js';
import { useAudioUpload } from './audio/useAudioUpload.js';
import { useHostQuery } from './host-query.js';
import { useStudy } from './study-context.jsx';

/* 音频导入：录音 → 转写 → 校对识别错误的词 → 中英对照逐字稿，存为一份资料。
   这里只管导入表单；出题仍走「资料 → 生成」。转写在后台进行，进度来自快照里的
   audio-import 任务（卡片在 ui/audio/AudioJobs.jsx），取消后已转写的部分会保留，重新导入接着做。

   还没有配置转写服务时，这里显示配置卡片而不是拖放区（字幕文件不需要转写，仍可导入），
   文件也不会开始上传。选好文件后先做预检（ui/audio/useAudioPreflight.js）：格式、时长、要几次请求；
   超过 1 小时的录音由「开始」一并无损分段（按钮写明几段、几次请求），读不了的文件给出「跳过此文件继续 / 换一个文件」，其余文件写明在等谁。
   名称、讲什么、术语、付费密钥在「更多设置」里；几个录音总是合成一份逐字稿，开始按钮上写明。

   选文件不用输路径：拖进来或点击选择（浏览器把文件分块传给插件，ui/audio/useAudioUpload.js），从工作区里搜，
   或在对话输入框里用 @ 选。手输路径留在「高级」里。 */

const subtitleAlone = () => ui("字幕文件请单独导入：一次选一个字幕文件，不和音频混在一起。");

export default function AudioImport({
  data,
  canAsk = false,
  openAgent,
  onOpenSources,
  onStarted,
  onGenerate,
  incoming,
  onIncomingTaken,
  initialFile = null,
  initialFiles,
  defaultCourse,
  defaultCourses,
  recoveryJobId = '',
  onRecoveryChange,
  onOpenSettings,
  initialReadiness = null,
  initialChecks,
}) {
  const { busy, act, call, askInChat } = useStudy();
  useInjectCss(settingsCss, 'study-audio-settings');
  useInjectCss(audioCss, 'study-audio-import');
  const language = useUiLanguage(), toast = useToast();
  const [files, setFiles] = useState(() => (initialFiles || (initialFile ? [initialFile] : [])).map((file, index) => ({ ...file, key: file.key || `initial-${index}` })));
  const [pathText, setPathText] = useState(""), [problem, setProblem] = useState("");
  // 更多设置: this recording's name, what it covers, its terms, and the paid-key choice (which starts from the default in Settings).
  const [more, setMore] = useState({}), [moreOpen, setMoreOpen] = useState(!!recoveryJobId);
  const [submitError, setSubmitError] = useState(''), [starting, setStarting] = useState(false);
  const { data: audioSettings } = useHostQuery('audio.settings.get', {}, { call, enabled: typeof call === 'function' });
  const { title = '', subject = '', terms = '' } = more, paidOnly = more.paidOnly ?? audioSettings?.paidOnlyByDefault === true;
  // Inside the add-material dialog the course is that dialog's own line; on its own page this form asks for it.
  const inDialog = Array.isArray(defaultCourses);
  const course = inDialog ? defaultCourses.join('; ') : more.course ?? defaultCourse ?? data.focus?.course ?? '';
  const picker = useRef(null), nextKey = useRef(0), moving = useRef(null);
  const append = file => setFiles(current => [...current, { ...file, key: `chosen-${++nextKey.current}` }]);
  const uploads = useAudioUpload({ call, onFile: append });
  const { upload } = uploads;
  const { readiness, checks, setChecks, refreshReadiness, recheck, audioFiles } = useAudioPreflight({ call, files, paidOnly, initialReadiness, initialChecks });
  const courses = data.focus?.courses?.map(item => item.name) || [...new Set((data.decks || []).map((deck) => deck.course).filter(Boolean))];
  const openSettings = openAudioSettings(onOpenSettings);
  const gated = !!readiness && !readiness.transcription && !files.length && !upload && !recoveryJobId;

  // Recordings and subtitles dropped on the Files tab of the dialog arrive here (their own confirmation, with the estimate, is below).
  useEffect(() => {
    if (!incoming?.files?.length) return;
    onIncomingTaken?.();
    void send(incoming.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.nonce]);

  const reject = (message) => { setProblem(message); return false; };
  function check(name, size) {
    setProblem("");
    const message = audioFileProblem(name, size);
    return message ? reject(message) : true;
  }
  /** Send browser files to the host in chunks (the import then uses their upload ids); a subtitle file is read as text instead. */
  async function send(chosenFiles) {
    if (uploads.isBusy()) return;
    if (recoveryJobId && chosenFiles.length !== 1) { setProblem(ui('旧任务请选择同一份原录音。')); return; }
    const subtitles = chosenFiles.filter(chosen => isSubtitleName(chosen.name));
    if (subtitles.length) {
      setProblem("");
      if (subtitles.length !== chosenFiles.length || chosenFiles.length !== 1 || files.length || recoveryJobId) return void reject(subtitleAlone());
      const tooBig = subtitleProblem(subtitles[0].size);
      if (tooBig) return void reject(tooBig);
      await uploads.run(async (cancelled) => {
        try {
          const text = await subtitles[0].text();
          if (!cancelled()) append({ kind: 'subtitle', name: subtitles[0].name, size: subtitles[0].size, text });
        } catch { if (!cancelled()) reject(ui("读取文件失败，请重试。")); }
      });
      return;
    }
    if (files.some(file => file.kind === 'subtitle')) { setProblem(subtitleAlone()); return; }
    if (!call || !chosenFiles.length || !chosenFiles.every(chosen => check(chosen.name, chosen.size))) return;
    // No upload starts before a transcription provider is configured: a big file would travel for nothing.
    const ready = readiness || await refreshReadiness();
    if (ready && !ready.transcription) { setProblem(ui("请先配置转写服务，再选择录音：文件还没有上传。")); return; }
    await uploads.sendFiles(chosenFiles);
  }
  function pickPath(path, size) {
    if (uploads.isBusy()) return;
    if (files.some(file => file.kind === 'subtitle')) return void reject(subtitleAlone());
    if (!check(path, size)) return;
    append({ kind: "path", path, name: baseName(path), size });
    setPathText('');
  }
  function remove(index, list = files) {
    const file = list[index];
    const next = list.filter((_, at) => at !== index);
    setFiles(next);
    setSubmitError('');
    if (file?.uploadId) uploads.release(file.uploadId);
    return next;
  }
  function move(from, to) {
    if (from === to || from < 0 || to < 0 || to >= files.length) return;
    setFiles(current => { const next = [...current], [file] = next.splice(from, 1); next.splice(to, 0, file); return next; });
  }
  /** Paths dragged as text (file trees give text, not files): file drags are taken by the drop zone itself. */
  function dropPaths(text) {
    const paths = pathsFromDrop(text);
    if (paths.length) paths.forEach(path => pickPath(path)); else reject(ui("请拖入音频文件。"));
  }
  function dropText(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    if (types.includes('Files') || !types.includes('text/plain')) return;
    event.preventDefault();
    dropPaths(event.dataTransfer.getData('text/plain'));
  }
  function drop(event) {
    event.preventDefault();
    event.stopPropagation();
    const dropped = Array.from(event.dataTransfer?.files || []);
    if (dropped.length) return void send(dropped);
    dropPaths(event.dataTransfer?.getData('text/plain'));
  }
  const failed = (error) => setSubmitError(String(error?.message || error || ''));
  async function start(event, { list = files } = {}) {
    event?.preventDefault?.();
    if (!list.length || upload || starting) return;
    setSubmitError('');
    if (list.some(file => file.kind === 'subtitle') && list.length !== 1) return void reject(subtitleAlone());
    if (recoveryJobId && list.length !== 1) { setProblem(ui('旧任务请选择同一份原录音。')); return; }
    const accepted = new Set(list.map(file => file.key));
    const settings = {
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      ...(terms.trim() ? { terms: terms.trim() } : {}),
      courses: parseCourses(course),
      ...(paidOnly ? { paidOnly: true } : {}),
    };
    if (list[0].kind === 'subtitle') {
      try {
        await act("audio.subtitles.import", { filename: list[0].name, text: list[0].text, ...settings }, () => {
          setFiles([]);
          setMore(current => ({ ...current, title: '' }));
          toast.success(ui("已开始后台校对字幕（不需要转写）。完成后会出现在「资料」页的「今天」分组里。"));
          onStarted?.();
        }, { rethrow: true });
      } catch (error) { failed(error); }
      return;
    }
    // Pre-flight every file again right before starting: nothing is sent to a provider until all of them can go.
    let current = checks;
    if (call) {
      setStarting(true);
      try {
        const answer = await recheck(list);
        if (answer.checks) {
          current = answer.checks;
          if (!answer.status.transcription) return void failed(answer.status.reason === 'paid-missing'
            ? ui("选择了「只用付费密钥」，但还没有配置 Gemini 付费密钥：去掉这个勾选，或在音频设置的「高级」里填写。")
            : ui("还没有配置转写服务：请先在音频设置里填一个密钥。"));
        }
      } catch (error) { return void failed(error); }
      finally { setStarting(false); }
    }
    const notes = preflightNotes(list, current, accepted);
    if (list.some(file => ['blocked', 'split'].includes(notes[file.key]?.kind))) return void failed(ui("有文件需要先处理：见上面每个文件下的提示。"));
    const inputs = list.map(inputOf);
    try {
      await act("audio.import", {
        ...(list.length > 1 ? { files: inputs } : inputs[0]),
        ...settings,
        ...(recoveryJobId ? { recoveryJobId } : {}),
      }, (started) => {
        uploads.claim(list.map(file => file.uploadId));
        setFiles([]);
        setMore(current => ({ ...current, title: '' }));
        setChecks({});
        onRecoveryChange?.('');
        toast.success(started?.status === "queued"
          ? uiFormat("已加入队列（前面还有 {0} 个）：轮到它时自动开始，完成后会出现在「资料」页的「今天」分组里。", [started.queuedBehind])
          : ui("已开始后台转写。长录音需要几分钟到十几分钟，可以先做别的；完成后会出现在「资料」页的「今天」分组里。"));
        onStarted?.(started);
      }, { rethrow: true });
    } catch (error) { failed(error); }
  }
  function skipAndContinue(index) {
    const next = remove(index);
    if (next.length) void start(null, { list: next });
  }
  function replaceFile(index) { remove(index); picker.current?.click(); }
  // Pressing start accepts a lossless split, and the button says so; every file counts as accepted here.
  const notes = preflightNotes(files, checks, new Set(files.map(file => file.key)));
  // The text steps of the recordings (WP27); transcription is counted in minutes on its own page.
  const estimate = estimateRequest(files, checks, { subject, terms });
  const percent = upload?.size ? Math.min(100, Math.round((upload.sent / upload.size) * 100)) : 0;
  return (
    <div className="pdf-import audio-import">
      <strong>{ui("音频 / 录音 → 中英对照逐字稿")}</strong>
      {recoveryJobId && <p className="muted">{ui('正在接续旧版失败任务：请选择同一份原录音。原提交参数未保存，请核对下面的课程和术语设置。')}
        <Button variant="link" size="sm" onClick={() => onRecoveryChange?.('')}>{ui('取消接续')}</Button></p>}
      <Hint>{ui("先把录音转写成文字（用你在音频设置里配置的服务），再校对识别错误的词、翻译，保存为一份资料。出题仍在「创建题组」里另选。")}</Hint>
      <input ref={picker} type="file" hidden multiple accept={`audio/*,${AUDIO_ACCEPT.join(',')}`}
        onChange={event => { const chosen = Array.from(event.target.files || []); event.target.value = ''; if (chosen.length) void send(chosen); }} />
      <AudioJobs data={data} busy={busy} act={act} openAgent={openAgent} onOpenSources={onOpenSources} onOpenSettings={openSettings} onGenerate={onGenerate}
        onLegacyRetry={job => { onRecoveryChange?.(job.id); picker.current?.click(); }} />
      {gated && <>
        <AudioSetupGate language={language} call={call} onOpenSettings={openSettings} reason={readiness.reason}
          onSaved={() => { void refreshReadiness(); }} />
        {readiness.text !== false && <div className="audio-subtitle-only">
          <p>{ui("字幕文件不需要转写服务，现在就可以导入：")}</p>
          <FileDrop compact accept={SUBTITLE_EXTENSIONS} label={ui("把字幕文件拖到这里")} hint={subtitleFormatNames().join(' · ')} buttonLabel={ui("选择字幕文件")}
            disabled={busy} onFiles={(accepted) => { if (accepted.length) void send(accepted); }} />
        </div>}
      </>}
      {!gated && !files.length && !upload && <div className="audio-drop-zone" onDragOver={event => { if (!Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); }} onDrop={dropText}>
        <FileDrop multiple accept={AUDIO_ACCEPT} disabled={busy}
          label={ui("把音频文件拖到这里，或点击选择")} hint={`${audioFormatNames().join(' · ')} · ${audioLimitLabel()}`}
          onFiles={(accepted) => { if (accepted.length) void send(accepted); }} />
        <Hint as="small">{uiFormat("也可以放 B 站等网站下载的带时间戳字幕（{0}）：跳过转写，直接校对和翻译，时间戳会保留。", [subtitleFormatNames().join(' · ')])}</Hint>
      </div>}
      {problem && <InlineMessage tone="warning">{problem}</InlineMessage>}
      {!upload && !gated && <>
        {files.length > 0 && <div className="audio-add" onDragOver={event => event.preventDefault()} onDrop={drop}>
          <Button size="sm" disabled={busy} onClick={() => picker.current?.click()}>{ui('添加音频')}</Button>
          <Hint as="small">{ui('也可把更多音频拖到这里')}</Hint>
        </div>}
        <div className="audio-ways">
          <AudioWorkspace call={call} onPick={(picked) => pickPath(picked.path, picked.size)} />
          {canAsk && askInChat && <Button variant="link" size="sm" disabled={busy}
            onClick={() => askInChat(ui("请把这些音频按我指定的顺序合成一份逐字稿（用 audio.import files:[{path:...}]，路径用绝对路径）：@"))}>{ui("在对话里用 @ 选文件")}</Button>}
          <details className="audio-path"><summary>{ui("粘贴文件路径（高级）")}</summary>
            <div className="audio-path-row">
              <input value={pathText} onChange={(event) => setPathText(event.target.value)} placeholder={ui("例如：C:\\Users\\你\\Downloads\\lecture.mp3")}
                onKeyDown={(event) => { if (event.key === "Enter" && unquotePath(pathText)) { event.preventDefault(); pickPath(unquotePath(pathText)); } }} />
              <Button size="sm" disabled={!unquotePath(pathText)} onClick={() => pickPath(unquotePath(pathText))}>{ui("选用")}</Button>
            </div>
          </details>
        </div>
      </>}
      {upload && <div className="audio-upload">
        <div className="audio-upload-head"><strong>{upload.name}</strong>
          {upload.error ? <Button variant="link" size="sm" onClick={uploads.dismiss}>{ui("重新选择")}</Button>
            : <Button variant="link" size="sm" onClick={uploads.cancel}>{ui("取消上传")}</Button>}</div>
        {upload.error ? <InlineMessage tone="error">{uiFormat("上传失败：{0}", [upload.error])}</InlineMessage> : <>
          <ProgressBar value={percent} max={100} size="sm" label={uiFormat("上传 {0}", [upload.name])} />
          <small className="muted">{uiFormat("正在上传 {0} / {1}", [formatBytes(upload.sent), formatBytes(upload.size)])}</small></>}
      </div>}
      {files.length > 0 && <form onSubmit={start}>
        {files.length > 1 && <Hint as="small">{ui('按下面的顺序合成一份逐字稿，可拖动或用按钮调整。')}</Hint>}
        <ol className={`audio-selection${files.length === 1 ? ' single' : ''}`}>{files.map((file, index) => {
          const note = notes[file.key];
          return <li key={file.key} className="audio-chosen" draggable={!busy && files.length > 1}
            onDragStart={event => { moving.current = index; event.dataTransfer.setData('text/plain', file.name); }}
            onDragEnd={() => { moving.current = null; }} onDragOver={event => { if (moving.current !== null) event.preventDefault(); }}
            onDrop={event => { if (moving.current !== null) { event.preventDefault(); event.stopPropagation(); move(moving.current, index); moving.current = null; } }}>
            <span className="audio-drop-icon" aria-hidden="true">{files.length > 1 ? index + 1 : <Icon name="audio" size={18} />}</span>
            <div><strong title={file.path || file.name}>{file.name}</strong><small className="muted">{file.size ? `${formatBytes(file.size)} · ` : ''}{file.kind === 'subtitle' ? ui('字幕文件 · 不转写，直接校对') : file.kind === 'upload' ? ui('已上传') : ui('来自工作区或路径')}</small>
              {note && <span className={`audio-check audio-check--${note.kind}`} role={note.kind === 'blocked' ? 'alert' : undefined}>
                <span>{note.text}</span>
                {note.kind === 'blocked' && <>
                  {files.length > 1 && <Button size="sm" disabled={busy || starting} onClick={() => skipAndContinue(index)}>{ui('跳过此文件继续')}</Button>}
                  <Button size="sm" variant="quiet" disabled={busy || starting} onClick={() => replaceFile(index)}>{ui('换一个文件')}</Button>
                </>}
              </span>}
            </div>
            <div className="audio-order-actions">{files.length > 1 && <>
              <IconButton size="sm" icon={<Icon name="arrow-up" size={16} />} label={uiFormat('上移 {0}', [file.name])}
                disabled={busy} aria-disabled={busy || index === 0} onClick={() => move(index, index - 1)} />
              <IconButton size="sm" icon={<Icon name="arrow-down" size={16} />} label={uiFormat('下移 {0}', [file.name])}
                disabled={busy} aria-disabled={busy || index === files.length - 1} onClick={() => move(index, index + 1)} />
            </>}<Button size="sm" variant="quiet" disabled={busy} aria-label={uiFormat('移除 {0}', [file.name])} onClick={() => remove(index)}>{ui(files.length === 1 ? '换一个' : '移除')}</Button></div>
          </li>;
        })}</ol>
        <AudioMoreSettings values={{ ...more, paidOnly }} defaultPaid={audioSettings?.paidOnlyByDefault === true} course={inDialog ? undefined : course} courses={courses} disabled={busy}
          open={moreOpen} onToggle={setMoreOpen} onChange={patch => setMore(current => ({ ...current, ...patch }))} onSettings={openSettings} />
        <TokenEstimate enabled={estimate.enabled} request={estimate.request} />
        <div className="audio-submit">
          <Button type="submit" variant="primary" wrap busy={starting} disabled={busy || !!upload || audioFiles.some(file => checks[file.key]?.checking)}>{starting ? ui("正在检查…") : startLabel(files, checks)}</Button>
          {submitError && <InlineMessage action={openSettings && aboutSettings(submitError) ? { label: ui('打开音频设置'), onClick: openSettings } : undefined}
            onDismiss={() => setSubmitError('')}>{uiMessage(submitError)}</InlineMessage>}
        </div>
      </form>}
    </div>
  );
}
