/* 3D Collectible Ex-Libris Postcard Studio & Local Seal Album Dialog.
   Generates 3 fine-print SVG editions from real session facts, previews them on a
   3D tilt stage (disabled under reduced/off motion), saves to localStorage (`study-seal-album`),
   and exports crisp offline SVG or 2x HiDPI PNG files. */
import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Dialog, Field, SegmentedControl, TabPanel, Tabs, TextInput } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import PostcardTilt from './PostcardTilt.jsx';
import SealAlbumView from './SealAlbumView.jsx';
import { buildPostcardSvg, exportPostcardPng, exportPostcardSvg, formatPostcardDate, POSTCARD_EDITIONS, svgToDataUri } from './postcard-svg.js';
import { loadSealAlbum, removeSealAlbumEntry, saveSealAlbumEntry } from './seal-storage.js';
import { useSealPalette } from './use-seal-palette.js';
import studioCss from './postcard-studio.css';

export default function PostcardStudioDialog({
  run,
  title,
  course = '',
  seal,
  initialSealStyle,
  initialTab = 'studio',
  onAlbumChange,
  onClose,
}) {
  useInjectCss(studioCss, 'study-seal-press-studio');
  const rootRef = React.useRef(null);
  const tabBaseId = React.useId();
  const { palette, reducedMotion } = useSealPalette(rootRef);

  const [tab, setTab] = React.useState(initialTab === 'album' ? 'album' : 'studio');
  const [edition, setEdition] = React.useState('letterpress');
  const [sealStyle, setSealStyle] = React.useState(initialSealStyle || seal?.defaultStyle || 'yang');
  const [note, setNote] = React.useState('');
  const [album, setAlbum] = React.useState(() => loadSealAlbum());
  const [savedNotice, setSavedNotice] = React.useState('');
  const [exportingPng, setExportingPng] = React.useState(false);

  const dateLabel = React.useMemo(() => formatPostcardDate(new Date()), []);
  const sealTitle = ui(seal.titleKey);
  const sealReason = seal.reasonArgs?.length ? uiFormat(seal.reasonKey, seal.reasonArgs) : ui(seal.reasonKey);

  const draftEntry = React.useMemo(() => ({
    id: `${run?.id || 'round'}:${edition}:${sealStyle}`,
    runId: run?.id || '',
    savedAt: new Date().toISOString(),
    dateLabel,
    title: title || run?.title || ui('本轮学习'),
    course: course || '',
    answered: seal.stats.answered,
    total: seal.stats.total,
    correct: seal.stats.correct,
    accuracy: seal.stats.accuracy,
    sealId: seal.id,
    sealChars: seal.chars,
    sealStyle,
    seed: seal.seed,
    edition,
    note: note.trim(),
    masteryDelta: seal.stats.masteryDelta,
  }), [course, dateLabel, edition, note, run?.id, run?.title, seal, sealStyle, title]);

  const editionName = ui((POSTCARD_EDITIONS.find((e) => e.id === edition) || POSTCARD_EDITIONS[0]).labelKey);
  const svgLabels = React.useMemo(() => ({
    ariaLabel: uiFormat('{0} · {1}', [draftEntry.title, editionName]),
    sealTitle,
    sealReason,
    sealEmblem: seal.englishEmblem,
    scoreCaption: ui('本轮成绩'),
    accuracyCaption: ui('正确率'),
  }), [draftEntry.title, editionName, seal.englishEmblem, sealReason, sealTitle]);

  const previewUri = React.useMemo(() => {
    const { svg } = buildPostcardSvg(draftEntry, { palette, labels: svgLabels });
    return svgToDataUri(svg);
  }, [draftEntry, palette, svgLabels]);

  const handleSaveToAlbum = () => {
    const entry = {
      ...draftEntry,
      id: `${draftEntry.runId || 'round'}:${draftEntry.edition}:${Date.now()}`,
      savedAt: new Date().toISOString(),
    };
    const next = saveSealAlbumEntry(entry);
    setAlbum(next);
    onAlbumChange?.(next.length);
    setSavedNotice(ui('已收进本地印谱'));
  };

  const handleRemoveFromAlbum = (id) => {
    const next = removeSealAlbumEntry(id);
    setAlbum(next);
    onAlbumChange?.(next.length);
  };

  const handleExportSvg = () => {
    exportPostcardSvg(draftEntry, { palette, labels: svgLabels });
    setSavedNotice(ui('已开始下载 SVG 文件'));
  };

  const handleExportPng = async () => {
    setExportingPng(true);
    setSavedNotice('');
    try {
      const ok = await exportPostcardPng(draftEntry, { palette, labels: svgLabels, scale: 2 });
      setSavedNotice(ok ? ui('已开始下载 2x 高清 PNG') : ui('当前环境未能生成 PNG，可改用导出 SVG。'));
    } catch {
      setSavedNotice(ui('当前环境未能生成 PNG，可改用导出 SVG。'));
    } finally {
      setExportingPng(false);
    }
  };

  const editionOptions = POSTCARD_EDITIONS.map((item) => ({
    value: item.id,
    label: ui(item.labelKey),
  }));

  const sealStyleOptions = [
    { value: 'yang', label: ui('朱文（阳刻）') },
    { value: 'yin', label: ui('白文（阴刻）') },
  ];

  const tabItems = [
    { value: 'studio', label: ui('制卡印制') },
    { value: 'album', label: ui('本地印谱'), note: album.length > 0 ? String(album.length) : undefined },
  ];

  return (
    <Dialog
      size="lg"
      title={ui('藏书明信片与印谱')}
      description={ui('把这一轮的真实学习记录压印成藏书票、孔版卡或宣纸书签，可保存在本地或导出带走。')}
      onClose={onClose}
    >
      <div ref={rootRef} className="sh-seal-studio" data-testid="postcard-studio-dialog">
        <Tabs
          id={tabBaseId}
          value={tab}
          onChange={setTab}
          items={tabItems}
          label={ui('明信片工作台视图')}
          className="sh-seal-studio__tabs"
        />

        <TabPanel id={tabBaseId} value="studio" selected={tab} tabIndex={undefined}>
          <div className="sh-seal-studio">
            <PostcardTilt reducedMotion={reducedMotion} edition={edition}>
              <img
                className="sh-postcard-stage__img"
                src={previewUri}
                alt={svgLabels.ariaLabel}
                draggable={false}
              />
            </PostcardTilt>

            <div className="sh-seal-studio__controls">
              <div className="sh-seal-studio__control-row">
                <Field label={ui('版式')} group width="full">
                  <SegmentedControl
                    size="sm"
                    label={ui('选择明信片版式')}
                    value={edition}
                    onChange={(next) => { setEdition(next); setSavedNotice(''); }}
                    options={editionOptions}
                  />
                </Field>
                <Field label={ui('印章风格')} group width="sm">
                  <SegmentedControl
                    size="sm"
                    label={ui('选择印章风格')}
                    value={sealStyle}
                    onChange={(next) => { setSealStyle(next); setSavedNotice(''); }}
                    options={sealStyleOptions}
                  />
                </Field>
              </div>

              <Field
                label={ui('一句话札记（选填）')}
                hint={ui('印在卡片正文下方，最多 80 字，仅保存在本地。')}
                width="full"
              >
                <TextInput
                  type="text"
                  maxLength={80}
                  value={note}
                  placeholder={ui('写一句这一轮的心得或提醒，例如：把隔离级别理顺了')}
                  onChange={(event) => { setNote(event.target.value); setSavedNotice(''); }}
                />
              </Field>

              <div className="sh-seal-studio__actions">
                <Button variant="primary" size="sm" icon="book" onClick={handleSaveToAlbum}>
                  {ui('存进本地印谱')}
                </Button>
                <Button variant="secondary" size="sm" icon="download" onClick={handleExportSvg}>
                  {ui('导出 SVG')}
                </Button>
                <Button variant="secondary" size="sm" icon="download" busy={exportingPng} onClick={handleExportPng}>
                  {ui('导出高清 PNG')}
                </Button>
                {savedNotice && <span className="sh-seal-studio__status" role="status">{savedNotice}</span>}
              </div>
            </div>
          </div>
        </TabPanel>

        <TabPanel id={tabBaseId} value="album" selected={tab} tabIndex={undefined}>
          <SealAlbumView
            entries={album}
            palette={palette}
            reducedMotion={reducedMotion}
            onRemove={handleRemoveFromAlbum}
            onGoStudio={() => setTab('studio')}
          />
        </TabPanel>
      </div>
    </Dialog>
  );
}
