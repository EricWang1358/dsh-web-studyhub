import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, Dialog, SegmentedControl, useToast } from '../components/index.js';
import InkScratchpadCanvas from './InkScratchpadCanvas.jsx';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  INK_PIGMENTS,
  INK_TOOLS,
  PAPER_STYLES,
  STROKE_WEIGHTS,
  buildExportSvg,
  downloadBlob,
  exportSvgToPngBlob,
  resolveInkPalette,
  scratchpadFilename,
} from './ink-engine.js';
import {
  readScratchpadSession,
  sanitizeScratchpadState,
  writeScratchpadSession,
} from './desk-play-storage.js';
import css from './desk-play-scratchpad.css';

const TOOL_KEYS = { 1: 'brush', 2: 'box', 3: 'circle', 4: 'arrow' };

/**
 * Calligraphic Ink Scratchpad modal — accessible from both the Home Desk
 * (`StudyMap.jsx`) and mid-question inside `ReviewToolbar.jsx`.
 * Keeps strokes in `sessionStorage` so closing and reopening mid-review preserves work.
 */
export default function InkScratchpadDialog({ onClose, contextLabel, onStrokesChange }) {
  useInjectCss(css, 'study-desk-play-scratchpad');
  const toast = useToast();
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const [engineReady, setEngineReady] = useState(false);
  const [exportingPng, setExportingPng] = useState(false);
  const [state, setState] = useState(() => readScratchpadSession());

  const { strokes, tool, ink, weight, paper } = state;
  const mountedRef = useRef(false);
  const onStrokesChangeRef = useRef(onStrokesChange);

  useEffect(() => {
    onStrokesChangeRef.current = onStrokesChange;
  }, [onStrokesChange]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    writeScratchpadSession(state);
    onStrokesChangeRef.current?.(state.strokes.length);
  }, [state]);

  const updateState = useCallback((updater) => {
    setState((prev) => sanitizeScratchpadState(
      typeof updater === 'function' ? updater(prev) : { ...prev, ...updater },
    ));
  }, []);

  const handleCommitStroke = useCallback((stroke) => {
    updateState((prev) => ({ ...prev, strokes: [...prev.strokes, stroke] }));
  }, [updateState]);

  const handleUndo = useCallback(() => {
    updateState((prev) => (prev.strokes.length ? { ...prev, strokes: prev.strokes.slice(0, -1) } : prev));
  }, [updateState]);

  const handleClear = useCallback(() => {
    updateState((prev) => (prev.strokes.length ? { ...prev, strokes: [] } : prev));
  }, [updateState]);

  const handleEngineReady = useCallback((loaded) => {
    engineRef.current = loaded;
    setEngineReady(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        handleUndo();
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && TOOL_KEYS[event.key]) {
        event.preventDefault();
        updateState({ tool: TOOL_KEYS[event.key] });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, updateState]);

  const buildCurrentSvg = () => {
    const loaded = engineRef.current;
    if (!loaded) return '';
    const palette = resolveInkPalette(canvasRef.current);
    return buildExportSvg({
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      paper,
      strokes,
      palette,
      getStrokeFn: loaded.getStroke,
      roughGenerator: loaded.roughGenerator,
    });
  };

  const handleExportSvg = () => {
    const svg = buildCurrentSvg();
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlob(blob, scratchpadFilename('svg'));
    toast.success(ui('已导出草稿 SVG。'));
  };

  const handleExportPng = async () => {
    const svg = buildCurrentSvg();
    if (!svg) return;
    setExportingPng(true);
    try {
      const blob = await exportSvgToPngBlob(svg, { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, scale: 2 });
      downloadBlob(blob, scratchpadFilename('png'));
      toast.success(ui('已导出高清草稿 PNG。'));
    } catch {
      toast.error(ui('导出 PNG 失败，请先试试导出 SVG。'));
    } finally {
      setExportingPng(false);
    }
  };

  const description = contextLabel
    ? uiFormat('当前主题：{0} · 本次会话自动暂存，关掉再开笔迹仍在', [contextLabel])
    : ui('毛笔笔锋与手绘图形 · 本次会话自动暂存，随时导出 SVG 或高清 PNG');

  const footer = (
    <div className="desk-play-pad-footer">
      <span className="desk-play-pad-meta">
        {strokes.length ? uiFormat('共 {0} 笔 · 按 Ctrl+Z 撤销', [strokes.length]) : ui('按 1–4 切工具 · Shift 约束方圆与角度')}
      </span>
      <div className="desk-play-pad-actions">
        <Button variant="quiet" size="sm" disabled={!strokes.length} onClick={handleUndo}>
          {ui('撤销')}
        </Button>
        <Button variant="quiet" size="sm" disabled={!strokes.length} onClick={handleClear}>
          {ui('清空')}
        </Button>
        <Button variant="secondary" size="sm" icon="download" disabled={!strokes.length || !engineReady} onClick={handleExportSvg}>
          {ui('导出 SVG')}
        </Button>
        <Button variant="secondary" size="sm" icon="download" busy={exportingPng} disabled={!strokes.length || !engineReady} onClick={handleExportPng}>
          {ui('导出 PNG')}
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog
      title={ui('毛笔草稿纸')}
      description={description}
      size="lg"
      onClose={onClose}
      className="desk-play-pad-dialog"
      footer={footer}
    >
      <div className="desk-play-pad-toolbar">
        <SegmentedControl
          size="sm"
          label={ui('绘制工具')}
          value={tool}
          onChange={(nextTool) => updateState({ tool: nextTool })}
          options={INK_TOOLS.map((item) => ({ value: item.id, label: ui(item.label) }))}
        />

        <div className="desk-play-ink-group" role="group" aria-label={ui('墨色')}>
          {INK_PIGMENTS.map((pigment) => (
            <Button
              key={pigment.id}
              variant="quiet"
              size="sm"
              shape="pill"
              className="desk-play-ink-btn"
              aria-pressed={ink === pigment.id}
              aria-label={ui(pigment.label)}
              title={ui(pigment.label)}
              onClick={() => updateState({ ink: pigment.id })}
            >
              <svg className={`desk-play-ink-dot desk-play-ink-dot--${pigment.id}`} viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                <circle cx="7" cy="7" r="5.5" />
              </svg>
              <span>{ui(pigment.label)}</span>
            </Button>
          ))}
        </div>

        <SegmentedControl
          size="sm"
          label={ui('笔锋粗细')}
          value={weight}
          onChange={(nextWeight) => updateState({ weight: nextWeight })}
          options={STROKE_WEIGHTS.map((item) => ({ value: item.id, label: ui(item.label) }))}
        />

        <SegmentedControl
          size="sm"
          label={ui('纸面底纹')}
          value={paper}
          onChange={(nextPaper) => updateState({ paper: nextPaper })}
          options={PAPER_STYLES.map((item) => ({ value: item.id, label: ui(item.label) }))}
        />
      </div>

      <InkScratchpadCanvas
        strokes={strokes}
        tool={tool}
        ink={ink}
        weight={weight}
        paper={paper}
        canvasRef={canvasRef}
        onCommitStroke={handleCommitStroke}
        onEngineReady={handleEngineReady}
      />
    </Dialog>
  );
}
