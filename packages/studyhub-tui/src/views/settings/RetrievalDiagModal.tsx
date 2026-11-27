import React, { memo, useCallback, useState } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import { t } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, normalizeAsciiChrome, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { truncateDisplay } from '../../render/cjk.js';
import type {
  RetrievalIndexPlanShape,
  RetrievalPreviewResultShape,
  RetrievalTestResultShape,
} from './workspace-model.js';

type RetrievalDiagSubMode = 'summary' | 'preview-input' | 'endpoint-input';

export interface RetrievalDiagModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  ell: string;
  width: number;
  isActive: boolean;
  loading: boolean;
  providerFallback: string;
  hfEndpoint: string;
  plan: RetrievalIndexPlanShape | null;
  testResult: RetrievalTestResultShape | null;
  error: string | null;
  onRefresh: () => void;
  onPreview: (query: string) => Promise<{ ok: boolean; value?: RetrievalPreviewResultShape; error?: string }>;
  onSaveEndpoint: (endpoint: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

export const RetrievalDiagModal = memo(function RetrievalDiagModal({
  lang,
  asciiMode,
  ell,
  width,
  isActive,
  loading,
  providerFallback,
  hfEndpoint,
  plan,
  testResult,
  error,
  onRefresh,
  onPreview,
  onSaveEndpoint,
  onClose,
}: RetrievalDiagModalProps) {
  const theme = useTheme();
  const contentW = modalContentWidth(width);
  const sep = asciiMode ? ' | ' : ' · ';
  const activeProvider = testResult?.provider || providerFallback || 'builtin';
  const [subMode, setSubMode] = useState<RetrievalDiagSubMode>('summary');
  const [previewQuery, setPreviewQuery] = useState('');
  const [previewResult, setPreviewResult] = useState<RetrievalPreviewResultShape | null>(null);
  const [endpointDraft, setEndpointDraft] = useState('');
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  const handleSubmitPreview = useCallback(
    async (raw: string) => {
      if (subBusy) return;
      const trimmed = raw.trim();
      setSubBusy(true);
      setSubError(null);
      try {
        const res = await onPreview(trimmed);
        if (!res.ok || !res.value) {
          if (res.error) setSubError(res.error);
          return;
        }
        setPreviewResult(res.value);
        setSubMode('summary');
      } finally {
        setSubBusy(false);
      }
    },
    [onPreview, subBusy],
  );

  const handleSubmitEndpoint = useCallback(
    async (raw: string) => {
      if (subBusy) return;
      setSubBusy(true);
      setSubError(null);
      try {
        const res = await onSaveEndpoint(raw.trim());
        if (!res.ok) {
          if (res.error) setSubError(res.error);
          return;
        }
        setSubMode('summary');
      } finally {
        setSubBusy(false);
      }
    },
    [onSaveEndpoint, subBusy],
  );

  useKeyScope({
    id: 'settings:workspace:retrieval-diag',
    active: isActive && subMode === 'summary',
    onKey: (input, key) => {
      if (key.escape || (isPlainKey(input, key) && input === 'q')) {
        onClose();
        return true;
      }
      if (subBusy || !isPlainKey(input, key)) return false;
      if (input === 's') {
        setSubError(null);
        setSubMode('preview-input');
        return true;
      }
      if (input === 'm') {
        setSubError(null);
        setEndpointDraft(hfEndpoint);
        setSubMode('endpoint-input');
        return true;
      }
      if (input === 'r') {
        onRefresh();
        return true;
      }
      return false;
    },
  });

  let verdictBadge: { label: string; tone: 'info' | 'success' | 'warning' | 'muted' } | null = null;
  let verdictDetail = '';
  if (testResult) {
    if (testResult.reason === 'builtin') {
      verdictBadge = {
        label: t(lang, '内置词法检索 (builtin)', 'Built-in lexical search (builtin)'),
        tone: 'info',
      };
      verdictDetail = t(
        lang,
        '使用本地词法检索，无需外部检索服务。',
        'No external search server required; using local lexical search.',
      );
    } else if (testResult.ok) {
      verdictBadge = {
        label: t(lang, `已连通 (${activeProvider})`, `Connected (${activeProvider})`),
        tone: 'success',
      };
      verdictDetail = `hits=${testResult.hits ?? 0}${sep}matched=${testResult.matched ?? 0}${sep}unresolved=${testResult.unresolved ?? 0}`;
    } else {
      verdictBadge = {
        label: t(lang, `连接失败 (${activeProvider})`, `Failed (${activeProvider})`),
        tone: 'warning',
      };
      verdictDetail = testResult.message ? truncateDisplay(testResult.message, contentW, ell) : '';
    }
  }

  const previewPages = Array.isArray(previewResult?.pages) ? previewResult.pages.slice(0, 4) : [];
  const modalHints =
    subMode === 'preview-input'
      ? [
          { key: 'Enter', label: t(lang, '搜索', 'Search') },
          { key: 'Esc', label: t(lang, '返回', 'Back') },
        ]
      : subMode === 'endpoint-input'
        ? [
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '返回', 'Back') },
          ]
        : [
            { key: 's', label: t(lang, '试搜', 'Search') },
            { key: 'm', label: t(lang, '镜像源', 'Mirror') },
            { key: 'r', label: t(lang, '刷新', 'Refresh') },
            { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
          ];

  const handleModalClose = useCallback(() => {
    if (subMode === 'summary') {
      onClose();
      return;
    }
    setSubError(null);
    setSubMode('summary');
  }, [onClose, subMode]);

  return (
    <Modal
      title={t(lang, '语义检索诊断与索引计划', 'Retrieval Diagnostics & Index Plan')}
      subtitle={activeProvider}
      width={width}
      onClose={handleModalClose}
      isActive={isActive}
      hints={modalHints}
    >
      {subMode === 'preview-input' ? (
        <Box flexDirection="column" gap={0}>
          <Text color={theme.muted}>
            {t(
              lang,
              '输入本地混合检索试搜主题（0 模型开销，支持词法+目录树）：',
              'Enter topic for local hybrid search preview (0 LLM tokens):',
            )}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={previewQuery}
              onChange={setPreviewQuery}
              onSubmit={(v) => void handleSubmitPreview(v)}
              onCancel={() => {
                setSubError(null);
                setSubMode('summary');
              }}
              width={Math.max(12, contentW - 4)}
              isActive={isActive && !subBusy}
              prompt={asciiMode ? '>' : '›'}
              placeholder={t(lang, `输入关键词${ell}`, `Enter search topic${ell}`)}
            />
          </Box>
          {subError ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">
                {subError}
              </Text>
            </Box>
          ) : null}
          {subBusy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在执行本地试搜${ell}`, `Running local search preview${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      ) : subMode === 'endpoint-input' ? (
        <Box flexDirection="column" gap={0}>
          <Text color={theme.muted}>
            {t(
              lang,
              '设置模型下载镜像地址 (HF_ENDPOINT，留空恢复默认 HuggingFace)：',
              'Set HuggingFace mirror endpoint (leave empty for default):',
            )}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={endpointDraft}
              onChange={setEndpointDraft}
              onSubmit={(v) => void handleSubmitEndpoint(v)}
              onCancel={() => {
                setSubError(null);
                setSubMode('summary');
              }}
              width={Math.max(12, contentW - 4)}
              isActive={isActive && !subBusy}
              prompt={asciiMode ? '>' : '›'}
              placeholder={t(lang, 'https://hf-mirror.com (留空恢复默认)', 'https://hf-mirror.com (empty resets to default)')}
            />
          </Box>
          {subError ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">
                {subError}
              </Text>
            </Box>
          ) : null}
          {subBusy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在保存镜像源${ell}`, `Saving HF mirror endpoint${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      ) : loading && !testResult && !plan ? (
        <Spinner label={t(lang, `正在诊断语义检索${ell}`, `Running retrieval diagnostics${ell}`)} active={isActive} />
      ) : (
        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.muted}>{t(lang, '连通状态:', 'Status:')}</Text>
            {verdictBadge ? (
              <Badge label={verdictBadge.label} tone={verdictBadge.tone} variant="soft" />
            ) : (
              <Badge label={t(lang, '未返回', 'No result')} tone="muted" variant="soft" />
            )}
          </Box>
          {verdictDetail ? (
            <Text color={testResult?.ok === false && testResult?.reason !== 'builtin' ? theme.warning : theme.dim}>
              {truncateDisplay(verdictDetail, contentW, ell)}
            </Text>
          ) : null}
          <Text color={theme.muted}>
            {truncateDisplay(
              t(lang, `模型镜像: ${hfEndpoint || '默认 (HuggingFace)'}`, `HF Endpoint: ${hfEndpoint || 'Default'}`),
              contentW,
              ell,
            )}
          </Text>

          {plan ? (
            <Box flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={theme.muted}>
                  {t(lang, '索引计划:', 'Index Plan:')}
                  {plan.course ? ` (${plan.course})` : ''}
                </Text>
                <Badge
                  label={plan.canIndex ? t(lang, '可构建索引', 'Can Index') : t(lang, '不可构建', 'Cannot Index')}
                  tone={plan.canIndex ? 'success' : 'muted'}
                  variant="soft"
                />
              </Box>
              <Text color={theme.text}>
                {truncateDisplay(
                  t(
                    lang,
                    `总页数 ${plan.pages}${sep}待索引 ${plan.toIndex}${sep}未变更 ${plan.unchanged}`,
                    `Pages ${plan.pages}${sep}To Index ${plan.toIndex}${sep}Unchanged ${plan.unchanged}`,
                  ),
                  contentW,
                  ell,
                )}
              </Text>
              <Text color={theme.muted}>
                {truncateDisplay(
                  t(
                    lang,
                    `跳过 ${plan.skipped}${sep}待移除 ${plan.toRemove}${sep}字符 ${plan.chars.toLocaleString('en-US')}`,
                    `Skipped ${plan.skipped}${sep}Remove ${plan.toRemove}${sep}Chars ${plan.chars.toLocaleString('en-US')}`,
                  ),
                  contentW,
                  ell,
                )}
              </Text>
              <Text color={plan.firstRun ? theme.accent : theme.dim}>
                {truncateDisplay(
                  plan.firstRun
                    ? t(lang, `首次构建模型下载约 ${plan.modelMb} MB`, `First-run model download ~${plan.modelMb} MB`)
                    : t(lang, `模型缓存已就绪 (~${plan.modelMb} MB)`, `Model cache ready (~${plan.modelMb} MB)`),
                  contentW,
                  ell,
                )}
              </Text>
            </Box>
          ) : null}

          {previewResult ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent}>
                {truncateDisplay(
                  t(
                    lang,
                    `试搜命中 ${previewResult.hits ?? previewPages.length}: ${previewResult.query || ''}`,
                    `Search Preview (${previewResult.hits ?? previewPages.length} hits): ${previewResult.query || ''}`,
                  ),
                  contentW,
                  ell,
                )}
              </Text>
              {previewPages.length === 0 ? (
                <Text color={theme.muted}>
                  {truncateDisplay(
                    t(lang, '未找到匹配页面，请换个关键词重试。', 'No matching pages found; try different keywords.'),
                    contentW,
                    ell,
                  )}
                </Text>
              ) : (
                previewPages.map((pg, idx) => {
                  const rawTitle = pg.title || pg.sourceId || t(lang, '未命名资料', 'Untitled');
                  const titleText = asciiMode ? normalizeAsciiChrome(rawTitle, true) : rawTitle;
                  const pageLabel = typeof pg.page === 'number' ? `p.${pg.page}` : '';
                  const headRaw = pageLabel ? `${titleText} (${pageLabel})` : titleText;
                  const rawSnippet = pg.snippet ? String(pg.snippet).replace(/\s+/g, ' ').trim() : '';
                  const snippetText = asciiMode ? normalizeAsciiChrome(rawSnippet, true) : rawSnippet;
                  const head = snippetText
                    ? truncateDisplay(headRaw, Math.max(14, Math.floor(contentW * 0.45)), ell)
                    : truncateDisplay(headRaw, contentW, ell);
                  const rowText = snippetText ? `${head}${sep}${snippetText}` : head;
                  return (
                    <Text key={`${pg.sourceId || idx}-${idx}`} color={theme.text}>
                      {truncateDisplay(rowText, contentW, ell)}
                    </Text>
                  );
                })
              )}
            </Box>
          ) : null}

          {error || subError ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">
                {error || subError || ''}
              </Text>
            </Box>
          ) : null}

          {loading ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在刷新诊断${ell}`, `Refreshing diagnostics${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
