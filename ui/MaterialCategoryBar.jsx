import React, { useContext, useId, useMemo } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import {
  Badge,
  Button,
  CheckboxInput,
  Icon,
  InlineMessage,
  ProgressBar,
  Select,
  TextInput,
  Tooltip,
} from './components/index.js';
import { useStudy } from './study-context.jsx';
import { AppContext } from './app/app-context.js';
import { modelReadiness } from './generation-status.js';
import {
  ALL_FACET,
  buildMaterialCategoryOptions,
  buildMaterialTypeOptions,
  resolveMaterialFolders,
} from './material-facets.js';
import {
  AUTO_MAX_FOLDERS,
  CLASSIFY_BATCH_SIZE,
  LARGE_MAX_FOLDERS,
  useMaterialClassify,
} from './use-material-classify.js';
import { TokenEstimate } from './TokenUsage.jsx';
import css from './source-picker.css';

/** The line that says which filters hide rows while their controls are put away, with the way back (the picker of 创建题组 #1182, 资料 #1694). */
export function FacetsOnLine({ names, onClear, className = '' }) {
  useInjectCss(css, 'study-source-picker');
  return <p className={`material-facets-on${className ? ` ${className}` : ''}`} data-material-filters-on>
    <span className="material-facets-on__said">{uiFormat('只显示：{0}', [names.join(' · ')])}</span>
    <Button variant="link" size="sm" className="sh-btn--ink" onClick={onClear}>{ui('清除筛选')}</Button>
  </p>;
}

/* Shared compact selector bar + batched AI topic classification panel for both
   SourcePicker (`01 / 选择资料` & `CaseCreate`) and Sources (`资料` library page).
   Reads `call` / `act` / `busy` from `useStudy()` directly (no service prop handoff).
   `open` (default true): SourcePicker keeps the selects behind a button on the list's filter line (#1182) and 资料 inside 「筛选与分组」 (#1694); shut, the bar
   draws nothing, except a classify that is running or waiting for review, which stays in view (and keeps its state: the bar stays mounted). */

export default function MaterialCategoryBar({
  items = [],
  targetItems,
  course = '',
  materialFolders: materialFoldersProp,
  sourceFlags = null,
  typeOptions: typeOptionsProp,
  categoryOptions: categoryOptionsProp,
  typeScope = ALL_FACET,
  onTypeScopeChange,
  categoryScope = ALL_FACET,
  onCategoryScopeChange,
  disabled = false,
  modelReady: modelReadyProp,
  className = '',
  open = true,
  id,
}) {
  useInjectCss(css, 'study-source-picker');
  const typeId = useId();
  const categoryId = useId();
  const { busy } = useStudy();
  const app = useContext(AppContext);
  const appData = app?.data;

  const resolvedFolders = useMemo(
    () => resolveMaterialFolders(materialFoldersProp, appData),
    [materialFoldersProp, appData],
  );
  const typeOptions = useMemo(
    () => typeOptionsProp || buildMaterialTypeOptions(items, sourceFlags),
    [typeOptionsProp, items, sourceFlags],
  );
  const categoryOptions = useMemo(
    () => categoryOptionsProp || buildMaterialCategoryOptions(items, resolvedFolders),
    [categoryOptionsProp, items, resolvedFolders],
  );

  const modelReady = typeof modelReadyProp === 'boolean'
    ? modelReadyProp
    : appData
      ? modelReadiness(appData).ready
      : true;

  const classifyItems = useMemo(
    () => (Array.isArray(targetItems) && targetItems.length > 0 ? targetItems : items),
    [targetItems, items],
  );
  const classify = useMaterialClassify({ items: classifyItems, course });

  const classifyKeys = useMemo(
    () => [...new Set(classifyItems.map(item => item?.key).filter(Boolean))],
    [classifyItems],
  );
  const scopeCourse = typeof course === 'string' && course.trim() && course.trim() !== '*' ? course.trim() : '';
  const estimateRequest = useMemo(() => ({
    feature: 'classify',
    keys: classifyKeys,
    ...(scopeCourse ? { course: scopeCourse } : {}),
    maxFolders: classifyKeys.length > CLASSIFY_BATCH_SIZE ? LARGE_MAX_FOLDERS : AUTO_MAX_FOLDERS,
  }), [classifyKeys, scopeCourse]);
  const showEstimate = open && modelReady && !disabled && classify.phase === 'idle' && classifyKeys.length > 0;

  const aiButton = (
    <Button
      size="sm"
      variant="secondary"
      icon="sparkle"
      className="material-category-bar__ai-btn"
      busy={classify.phase === 'running'}
      lock={busy}
      disabled={disabled || !modelReady || !classifyItems.length}
      data-ai-classify
      onClick={() => classify.loadSuggestions(classifyItems)}
    >
      {ui('AI 智能分类')}
    </Button>
  );

  return (
    <div id={id} className={`material-category-bar${className ? ` ${className}` : ''}`} data-material-category-bar hidden={!open && classify.phase === 'idle'}>
      <div className="material-category-bar__controls" hidden={!open}>
        <div className="material-category-bar__field">
          <label className="material-category-bar__label" htmlFor={typeId}>{ui('类型')}</label>
          <Select
            id={typeId}
            className="material-category-bar__select"
            value={typeScope}
            onChange={onTypeScopeChange}
            options={typeOptions}
            disabled={disabled}
          />
        </div>
        <div className="material-category-bar__field">
          <label className="material-category-bar__label" htmlFor={categoryId}>{ui('内容分类')}</label>
          <Select
            id={categoryId}
            className="material-category-bar__select"
            value={categoryScope}
            onChange={onCategoryScopeChange}
            options={categoryOptions}
            disabled={disabled}
          />
        </div>
        <div className="material-category-bar__ai">
          {modelReady ? (
            aiButton
          ) : (
            <Tooltip layer content={ui('AI 智能分类需要先配置模型；按类型和已有分类筛选不需要。')}>
              <span className="material-category-bar__ai-gate" tabIndex={0}>{aiButton}</span>
            </Tooltip>
          )}
          {showEstimate && (
            <span className="material-category-bar__estimate" data-classify-estimate>
              <TokenEstimate pieces enabled={showEstimate} request={estimateRequest} />
            </span>
          )}
        </div>
      </div>

      {classify.phase === 'running' && (
        <div className="material-classify-progress" role="status" aria-live="polite" data-classify-phase="running">
          <div className="material-classify-progress__head">
            <span className="material-classify-progress__text">
              {classify.jobStage === 'taxonomy'
                ? uiFormat('正在归纳主题目录（共 {0} 份资料）…', [classify.total])
                : uiFormat('正在按内容整理分类（{0} / {1}）…', [classify.done, classify.total])}
            </span>
            <div className="material-classify-progress__actions">
              {classify.jobId && app?.nav?.show?.task && (
                <Button
                  size="sm"
                  variant="quiet"
                  iconEnd="arrow-right"
                  data-open-classify-task
                  onClick={() => app.nav.show.task(classify.jobId)}
                >
                  {ui('查看任务')}
                </Button>
              )}
              <Button size="sm" variant="quiet" lock={busy} data-stop-classify onClick={classify.cancel}>
                {ui('停止')}
              </Button>
            </div>
          </div>
          <ProgressBar
            size="sm"
            value={classify.done}
            max={Math.max(classify.total, 1)}
            indeterminate={classify.done === 0}
            label={ui('AI 分类进度')}
          />
        </div>
      )}

      {classify.phase === 'error' && classify.error && (
        <InlineMessage
          tone="error"
          className="material-classify-error"
          action={{ label: ui('重试'), onClick: () => classify.loadSuggestions(classifyItems) }}
        >
          <span>{classify.error}</span>{' '}
          <Button size="sm" variant="link" onClick={classify.discard}>{ui('关闭')}</Button>
        </InlineMessage>
      )}

      {classify.phase === 'review' && (
        <div className="material-classify-review" role="region" aria-label={ui('AI 分类建议')} data-classify-phase="review">
          <p className="material-classify-review__intro">
            {ui('建议尚未保存，可先调整分类名称或勾选分组，再确认应用。')}
          </p>
          <div className="material-classify-review__list">
            {classify.groups.map(group => (
              <div
                key={group.id}
                className={`material-classify-group${group.include ? '' : ' is-excluded'}`}
                data-classify-group={group.originalName}
              >
                <div className="material-classify-group__row">
                  <CheckboxInput
                    className="material-classify-group__check"
                    checked={group.include}
                    disabled={busy}
                    aria-label={uiFormat('采纳分类：{0}', [group.name || group.originalName])}
                    onChange={event => classify.toggleGroup(group.id, event.target.checked)}
                  />
                  <TextInput
                    className="material-classify-group__input"
                    value={group.name}
                    maxLength={80}
                    disabled={busy || !group.include}
                    aria-label={uiFormat('分类名称：{0}', [group.originalName])}
                    placeholder={ui('输入分类名称…')}
                    onChange={event => classify.renameGroup(group.id, event.target.value)}
                  />
                  <details className="material-classify-group__details">
                    <summary className="material-classify-group__summary">
                      <Icon name="caret" className="material-classify-group__caret sh-icon--inline" />
                      <Badge size="sm">{uiFormat('{0} 份资料', [group.items.length])}</Badge>
                    </summary>
                    <ul className="material-classify-group__items">
                      {group.items.map(entry => (
                        <li key={entry.key} className="material-classify-group__item">
                          <span>{entry.title}</span>
                          {entry.currentFolder && entry.currentFolder !== group.name && (
                            <small className="material-classify-group__from">
                              {uiFormat('原：{0}', [entry.currentFolder])}
                            </small>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              </div>
            ))}
          </div>
          {classify.applyError && <InlineMessage tone="error">{classify.applyError}</InlineMessage>}
          <div className="material-classify-review__actions">
            <Button
              size="sm"
              variant="secondary"
              lock={busy}
              disabled={!classify.canApply}
              data-apply-classify
              onClick={classify.apply}
            >
              {ui('确认应用分类')}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              lock={busy}
              data-discard-classify
              onClick={classify.discard}
            >
              {ui('放弃建议')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
