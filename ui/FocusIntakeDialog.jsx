import React, { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import {
  Button, Checkbox, Chip, Dialog, Field, FileDrop, Hint, IconButton, InlineMessage,
  TabPanel, Tabs, TextArea, formatBytes, partitionFiles, useToast,
} from './components/index.js';
import CourseField from './CourseField.jsx';
import TopicChips from './TopicChips.jsx';
import { splitTopics } from './course-topics.js';
import { HandOff } from './hand-off/HandOff.jsx';
import { useStudy } from './study-context.jsx';
import { useLiveEffect } from './use-async.js';
import {
  MAX_FOCUS_IMAGES, MAX_FOCUS_IMAGE_BYTES,
  cleanFocusTopics, mergeFocusTopics, parseFocusText,
} from '../lib/focus-points.js';
import { buildPdfFileFromImages } from './focus-pdf.js';
import css from './focus-intake.css';

export { buildPdfFileFromImages };

const IMAGE_ACCEPT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

function readFileAsDataUrl(file) {
  if (typeof file?.dataUrl === 'string') return Promise.resolve(file.dataUrl);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(ui('读取图片失败')));
    reader.readAsDataURL(file);
  });
}

export async function prepareFocusImageHandOff({
  rawFiles,
  course = '',
  notes = '',
  existingTopics = [],
  generateAfter = false,
  host = null,
  call,
}) {
  let staged;
  if (typeof host?.stageFocusImages === 'function') {
    staged = await host.stageFocusImages(rawFiles);
  } else {
    const encoded = await Promise.all(rawFiles.map(async (file) => ({
      name: file.name || 'focus.png',
      dataUrl: await readFileAsDataUrl(file),
    })));
    staged = await call('focus.images.stage', { files: encoded });
  }
  const stagedPaths = (staged?.files || []).map((item) => item.relativePath).filter(Boolean);
  let takes = undefined;
  if (typeof host?.chatTakesPictures === 'function') {
    try { takes = await host.chatTakesPictures(); } catch { takes = undefined; }
  }
  const attach = takes === true;
  return {
    course: String(course || '').trim(),
    files: stagedPaths,
    notes: String(notes || '').trim(),
    existingTopics: cleanFocusTopics(existingTopics),
    generateAfter: !!generateAfter,
    attached: attach,
    ...(attach ? { picture: { images: rawFiles, wanted: rawFiles.length } } : {}),
  };
}

export async function saveFocusIntake({
  course,
  topics,
  rawText = '',
  saveAsMaterial = true,
  courseRecord = null,
  call,
  act,
  onSaved,
}) {
  const trimmedCourse = String(course || '').trim();
  const cleanedTopics = cleanFocusTopics(topics);
  if (!trimmedCourse || !cleanedTopics.length) return null;
  let existing = courseRecord;
  if (courseRecord?.id) {
    existing = await call('course.get', { id: courseRecord.id }).catch(() => courseRecord);
  }
  let guidanceIds = [...(existing?.guidanceSourceIds || [])];
  if (saveAsMaterial && String(rawText || '').trim()) {
    const parsed = parseFocusText(rawText, { title: `${trimmedCourse} · ${ui('考试重点记录')}` });
    const added = await call('source.add', {
      title: `${trimmedCourse} · ${ui('考试重点记录')}`,
      text: parsed.markdown || String(rawText).trim(),
      courses: [trimmedCourse],
      format: 'md',
    });
    if (added?.id && !guidanceIds.includes(added.id)) guidanceIds = [...guidanceIds, added.id];
  }
  const finalTopics = mergeFocusTopics(cleanedTopics, []);
  let outcome = null;
  await act(
    'course.save',
    {
      ...(existing?.id ? { id: existing.id } : {}),
      name: trimmedCourse,
      ...(existing?.exam ? { exam: existing.exam } : {}),
      ...(existing?.plan ? { plan: existing.plan } : {}),
      guidanceSourceIds: guidanceIds,
      focusTopics: finalTopics,
    },
    (saved) => {
      outcome = {
        course: trimmedCourse,
        count: finalTopics.length,
        record: saved?.course || { name: trimmedCourse, focusTopics: finalTopics, guidanceSourceIds: guidanceIds },
      };
      onSaved?.(outcome);
    },
    { rethrow: true },
  );
  return outcome;
}

export default function FocusIntakeDialog({
  data,
  initialCourse = '',
  initialTab = 'image',
  initialGenerateAfter = false,
  onClose,
  onSaved,
  onStartFocusPractice,
  onGenerateCourse,
  onOpenPdfImport,
}) {
  useInjectCss(css, 'study-focus-intake');
  const { call, act, busy, host, openModal } = useStudy();
  const toast = useToast();

  const [course, setCourse] = useState(() => String(initialCourse || data?.focus?.course || '').trim());
  const [tab, setTab] = useState(initialTab === 'text' ? 'text' : 'image');

  const courseRecord = useMemo(
    () => (data?.courses || []).find((item) => item?.name === course.trim()) || null,
    [data?.courses, course],
  );
  const existingTopics = useMemo(() => cleanFocusTopics(courseRecord?.focusTopics || []), [courseRecord]);

  // Image intake state
  const [images, setImages] = useState([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => {
    for (const item of imagesRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }, []);

  const [imageNotes, setImageNotes] = useState('');
  const [generateAfter, setGenerateAfter] = useState(!!initialGenerateAfter);
  const [takesPictures, setTakesPictures] = useState(undefined);
  const [bundlingPdf, setBundlingPdf] = useState(false);

  const modelRoute = host?.sessionModel;
  useLiveEffect((isLive) => {
    if (typeof host?.chatTakesPictures !== 'function') { setTakesPictures(undefined); return; }
    Promise.resolve().then(() => host.chatTakesPictures()).then(
      (takes) => { if (isLive()) setTakesPictures(takes); },
      () => { if (isLive()) setTakesPictures(undefined); },
    );
  }, [host, modelRoute?.provider, modelRoute?.model]);

  // Text & material intake state
  const [rawText, setRawText] = useState('');
  const [topicsText, setTopicsText] = useState(() => existingTopics.join('; '));
  const [topicsDirty, setTopicsDirty] = useState(false);
  const [pickedSourceIds, setPickedSourceIds] = useState([]);
  const [saveAsMaterial, setSaveAsMaterial] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedResult, setSavedResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!topicsDirty) setTopicsText(existingTopics.join('; '));
  }, [existingTopics, topicsDirty]);

  const courseSources = useMemo(() => {
    const all = (data?.sources || []).filter((source) => source && !source.archived && typeof source.text === 'string' && source.text.trim());
    const trimmed = course.trim();
    if (!trimmed) return all.slice(0, 12);
    const matching = all.filter((source) => (source.courses || []).includes(trimmed));
    return (matching.length ? matching : all).slice(0, 12);
  }, [data?.sources, course]);

  const disabled = busy || saving || extracting || bundlingPdf;

  const appendImages = (incomingFiles) => {
    setError('');
    setImages((prev) => {
      const remaining = MAX_FOCUS_IMAGES - prev.length;
      if (remaining <= 0) {
        setError(uiFormat('一次最多放入 {0} 张重点图片', [MAX_FOCUS_IMAGES]));
        return prev;
      }
      const next = [...prev];
      for (const file of incomingFiles.slice(0, remaining)) {
        const previewUrl = typeof URL?.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
        next.push({
          id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 7)}`,
          file,
          name: file.name || 'focus.png',
          size: file.size || 0,
          previewUrl,
        });
      }
      if (incomingFiles.length > remaining) {
        setError(uiFormat('一次最多放入 {0} 张重点图片，超出的图片未加入', [MAX_FOCUS_IMAGES]));
      }
      return next;
    });
  };

  const removeImage = (id) => {
    setImages((prev) => {
      const removed = prev.find((item) => item.id === id);
      if (removed?.previewUrl && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const handlePaste = (event) => {
    if (disabled) return;
    const clipboardFiles = Array.from(event.clipboardData?.files || []).filter((file) => String(file.type || '').startsWith('image/'));
    if (!clipboardFiles.length) return;
    const { accepted, rejected } = partitionFiles(clipboardFiles, { accept: IMAGE_ACCEPT, maxBytes: MAX_FOCUS_IMAGE_BYTES, multiple: true });
    if (accepted.length) {
      event.preventDefault();
      if (tab !== 'image') setTab('image');
      appendImages(accepted);
    } else if (rejected.length) {
      setError(rejected[0].message);
    }
  };

  const prepareImageHandOff = async () => {
    setError('');
    return prepareFocusImageHandOff({
      rawFiles: images.map((item) => item.file),
      course,
      notes: imageNotes,
      existingTopics,
      generateAfter,
      host,
      call,
    });
  };

  const bundleImagesToPdf = async () => {
    if (!images.length || disabled) return;
    setBundlingPdf(true);
    setError('');
    try {
      const pdfFile = await buildPdfFileFromImages(images.map((item) => item.file), course.trim());
      if (onOpenPdfImport) onOpenPdfImport(pdfFile, course.trim());
      else openModal({ type: 'add', ...(course.trim() ? { course: course.trim() } : {}), resumeConversion: pdfFile });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBundlingPdf(false);
    }
  };

  const extractLocally = () => {
    setError('');
    const parsed = parseFocusText(rawText, { title: course.trim() });
    if (!parsed.topics.length) {
      setExtractNote(ui('没有从上面的文字里识别出独立的重点条目，可直接手动输入或点「AI 提炼重点」。'));
      return;
    }
    const merged = mergeFocusTopics(splitTopics(topicsText), parsed.topics);
    setTopicsDirty(true);
    setTopicsText(merged.join('; '));
    setExtractNote(uiFormat('已识别 {0} 个重点条目，可在下方增删修改。', [parsed.topics.length]));
  };

  const extractWithAi = async () => {
    if ((!rawText.trim() && !pickedSourceIds.length) || disabled) return;
    setExtracting(true);
    setError('');
    setExtractNote('');
    try {
      const result = await call('focus.extract', {
        course: course.trim(),
        text: rawText.trim(),
        sourceIds: pickedSourceIds,
      });
      const incoming = cleanFocusTopics(result?.topics || []);
      if (!incoming.length) {
        setExtractNote(ui('没有提炼出新的重点条目，可以补充更具体的范围说明再试。'));
        return;
      }
      const merged = mergeFocusTopics(splitTopics(topicsText), incoming);
      setTopicsDirty(true);
      setTopicsText(merged.join('; '));
      setExtractNote(
        result?.source === 'local'
          ? uiFormat('当前未连接轻量模型，已用本地规则识别出 {0} 个重点条目。', [incoming.length])
          : result?.summary
            ? uiFormat('已提炼 {0} 个重点条目：{1}', [incoming.length, result.summary])
            : uiFormat('已提炼 {0} 个重点条目，核对无误后点下方「保存重点」。', [incoming.length]),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setExtracting(false);
    }
  };

  const toggleSourcePick = (sourceId) => {
    setPickedSourceIds((prev) => (prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId]));
  };

  const saveFocusTopics = async () => {
    const trimmedCourse = course.trim();
    const cleanedTopics = cleanFocusTopics(splitTopics(topicsText));
    if (!trimmedCourse || !cleanedTopics.length || disabled) return;
    setSaving(true);
    setError('');
    try {
      await saveFocusIntake({
        course: trimmedCourse,
        topics: cleanedTopics,
        rawText,
        saveAsMaterial,
        courseRecord,
        call,
        act,
        onSaved: (outcome) => {
          toast.success(uiFormat('已为「{0}」保存 {1} 个重点知识点', [outcome.course, outcome.count]));
          setSavedResult({ course: outcome.course, count: outcome.count });
          setTopicsDirty(false);
          onSaved?.(outcome.record);
        },
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const currentTopicCount = splitTopics(topicsText).length;
  const tabItems = [
    { value: 'image', label: ui('图片录入重点'), note: ui('手上只有截图、板书或划重点照片') },
    { value: 'text', label: ui('文字 / 资料提炼重点'), note: ui('粘贴划重点消息，或从已有课件提炼') },
  ];

  const imageModelHint = takesPictures === true
    ? ui('当前主会话模型支持直接看图；图片也会同步存到工作区 studyhub-work/focus-intake/ 留档。')
    : takesPictures === false
      ? ui('当前主会话是纯文本模型（如 DeepSeek）：点「发给主会话」会把图片存到工作区 studyhub-work/focus-intake/，不会往输入框塞图片阻塞发送，由主会话调用 MinerU 或本机文字识别读取并入库。')
      : ui('点「发给主会话」会把重点图片存到工作区 studyhub-work/focus-intake/，主会话可直接看图或调用本机文字识别整理入库。');

  return (
    <Dialog
      size="lg"
      className="focus-intake"
      title={ui('录入课程重点')}
      description={ui('支持微信 / QQ 划重点截图、课堂板书照片、文字提纲与已有资料；录入后自动提高复习频率并加深出题难度。')}
      guardDrops
      busy={saving || extracting || bundlingPdf}
      onClose={() => onClose?.('dismiss')}
      footer={(
        <div className="focus-intake__footer">
          <Button variant="quiet" lock={disabled} onClick={() => onClose?.('cancel')}>{ui('关闭')}</Button>
          {tab === 'text' && (
            <Button
              variant="primary"
              icon="check"
              busy={saving}
              busyLabel={ui('正在保存…')}
              lock={busy || extracting || bundlingPdf}
              disabled={!course.trim() || !currentTopicCount}
              onClick={saveFocusTopics}
            >
              {ui('保存重点')}
            </Button>
          )}
        </div>
      )}
    >
      <div className="focus-intake__body" onPaste={handlePaste}>
        <div className="focus-intake__course-bar">
          <CourseField
            courses={data?.focus?.courses || []}
            value={course}
            onChange={(value) => { setCourse(value); setTopicsDirty(false); setSavedResult(null); }}
            disabled={disabled}
            label={ui('目标课程')}
          />
          {existingTopics.length > 0 && (
            <Hint>{uiFormat('这门课已有 {0} 个重点知识点；新录入的条目会和原有重点合并保留。', [existingTopics.length])}</Hint>
          )}
        </div>

        <Tabs id="focus-intake" label={ui('重点来源')} value={tab} onChange={setTab} items={tabItems} />

        {error && <InlineMessage tone="error">{error}</InlineMessage>}

        <TabPanel id="focus-intake" value="image" selected={tab} className="focus-intake__panel" tabIndex={undefined}>
          {tab === 'image' && (
            <>
              <div className="focus-intake__paste-zone">
                <FileDrop
                  accept={IMAGE_ACCEPT}
                  multiple
                  maxBytes={MAX_FOCUS_IMAGE_BYTES}
                  disabled={disabled}
                  label={ui('拖入划重点截图或照片，或直接按 Ctrl+V 粘贴截图')}
                  hint={uiFormat('PNG · JPG · WebP · GIF，最多 {0} 张', [MAX_FOCUS_IMAGES])}
                  buttonLabel={ui('选择重点图片')}
                  onFiles={(accepted) => appendImages(accepted)}
                />
                {images.length > 0 && (
                  <ul className="focus-intake__thumbs" aria-label={ui('已添加的重点图片')}>
                    {images.map((item) => (
                      <li key={item.id} className="focus-intake__thumb">
                        {item.previewUrl && <img className="focus-intake__thumb-img" src={item.previewUrl} alt={item.name} />}
                        <span className="focus-intake__thumb-meta">
                          <span className="focus-intake__thumb-name">{item.name}</span>
                          <span className="focus-intake__thumb-size">{formatBytes(item.size)}</span>
                        </span>
                        <IconButton
                          icon="close"
                          size="sm"
                          label={uiFormat('移除「{0}」', [item.name])}
                          lock={disabled}
                          onClick={() => removeImage(item.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Field label={ui('补充说明（可选）')} width="full" hint={ui('告诉主会话哪些要重点记、哪些不考，或者指定课程名。')}>
                <TextArea
                  rows={2}
                  maxLength={1200}
                  value={imageNotes}
                  disabled={disabled}
                  onChange={(event) => setImageNotes(event.target.value)}
                  placeholder={ui('例如：图里红框标星的是必考，第 5 章老师说今年不考')}
                />
              </Field>

              <Checkbox
                label={ui('存好重点后，顺便按重点出一组草稿题给我检查')}
                checked={generateAfter}
                disabled={disabled}
                onChange={setGenerateAfter}
              />

              <Hint>{imageModelHint}</Hint>

              <div className="focus-intake__actions">
                <HandOff
                  id="course.focus"
                  shape="secondary"
                  disabled={disabled || !images.length}
                  said={takesPictures === false ? '重点图片已存到工作区。' : ''}
                  what={ui('把重点图片存到工作区并把录入请求填进主会话输入框')}
                  input={prepareImageHandOff}
                  onSent={(outcome) => { if (outcome === 'filled') onClose?.('handoff'); }}
                />
                <Button
                  variant="quiet"
                  size="sm"
                  busy={bundlingPdf}
                  busyLabel={ui('正在合成 PDF…')}
                  lock={busy || saving || extracting}
                  disabled={!images.length}
                  onClick={bundleImagesToPdf}
                >
                  {ui('合成 PDF 用本机解析')}
                </Button>
              </div>
            </>
          )}
        </TabPanel>

        <TabPanel id="focus-intake" value="text" selected={tab} className="focus-intake__panel" tabIndex={undefined}>
          {tab === 'text' && (
            <>
              <Field label={ui('粘贴划重点文字或群聊记录')} width="full">
                <TextArea
                  rows={4}
                  maxLength={20000}
                  value={rawText}
                  disabled={disabled}
                  onChange={(event) => setRawText(event.target.value)}
                  placeholder={ui('把老师发的复习范围、群聊划重点消息或图片转写文字粘贴到这里…')}
                />
              </Field>

              {courseSources.length > 0 && (
                <div className="focus-intake__sources">
                  <small className="muted">{ui('也可以勾选已有资料，让 AI 从课件或提纲里提炼重点（可选）：')}</small>
                  <ul className="focus-intake__source-chips" aria-label={ui('用于提炼重点的资料')}>
                    {courseSources.map((source) => (
                      <li key={source.id}>
                        <Chip
                          size="sm"
                          selected={pickedSourceIds.includes(source.id)}
                          disabled={disabled}
                          onClick={() => toggleSourcePick(source.id)}
                        >
                          {source.title}
                        </Chip>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="focus-intake__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  lock={disabled}
                  disabled={!rawText.trim()}
                  onClick={extractLocally}
                >
                  {ui('识别为重点条目')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="sparkle"
                  busy={extracting}
                  busyLabel={ui('正在提炼…')}
                  lock={busy || saving || bundlingPdf}
                  disabled={!rawText.trim() && !pickedSourceIds.length}
                  onClick={extractWithAi}
                >
                  {ui('AI 提炼重点')}
                </Button>
              </div>

              {extractNote && <InlineMessage tone="info">{extractNote}</InlineMessage>}

              <Field
                label={ui('重点条目（将存入课程）')}
                width="full"
                hint={ui('请填写课程名并确认下方条目；保存后重点题复习更频繁，出题时自动提高配额并加深到应用 / 进阶难度。')}
              >
                <TopicChips
                  value={topicsText}
                  disabled={disabled}
                  onChange={(next) => { setTopicsDirty(true); setTopicsText(next); }}
                />
              </Field>

              <Checkbox
                label={ui('同时把上面的划重点原文存为课程资料（方便出题与批改引用）')}
                checked={saveAsMaterial}
                disabled={disabled || !rawText.trim()}
                onChange={setSaveAsMaterial}
              />

              {savedResult && (
                <div className="focus-intake__saved" role="status">
                  <p className="focus-intake__saved-title">
                    {uiFormat('已保存「{0}」的 {1} 个重点知识点，高频排期与加深出题已生效。', [savedResult.course, savedResult.count])}
                  </p>
                  <div className="focus-intake__actions">
                    {onStartFocusPractice && (
                      <Button size="sm" variant="secondary" lock={disabled} onClick={() => onStartFocusPractice(savedResult.course)}>
                        {ui('只练重点')}
                      </Button>
                    )}
                    {onGenerateCourse && (
                      <Button size="sm" variant="secondary" icon="sparkle" lock={disabled} onClick={() => onGenerateCourse(savedResult.course)}>
                        {ui('按重点出题')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </TabPanel>
      </div>
    </Dialog>
  );
}
