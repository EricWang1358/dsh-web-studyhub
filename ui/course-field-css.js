/* Course picker (WP13 quick picks; WP14 clear button, hint, ranked chips,
   chapter groups and the 全部课程 list). A JS string rather than a .css file so
   every bundle that already includes CourseField keeps building without a CSS loader. */
export default `:is(.study-app, .study-seat) .course-field { container: course-field / inline-size; display: grid; gap: var(--space-2); min-width: 0; margin: 0 0 var(--space-3); }
:is(.study-app, .study-seat) .source-organize > .course-field { max-width: 560px; }
:is(.study-app, .study-seat) .course-field__label { margin: 0; }
:is(.study-app, .study-seat) .course-field__control { position: relative; min-width: 0; }
:is(.study-app, .study-seat) .course-field__control > input { width: 100%; margin: 0; }
:is(.study-app, .study-seat) .course-field__control.has-value > input { padding-right: 44px; }
:is(.study-app, .study-seat) .course-field__clear { position: absolute; top: 50%; right: 6px; transform: translateY(-50%); color: var(--text-muted); }
:is(.study-app, .study-seat) .course-field__clear:hover:not(:disabled) { color: var(--text); }
:is(.study-app, .study-seat) .course-field__hint { display: block; margin: 0; color: var(--text-muted); font-size: var(--fs-sm); font-weight: 400; line-height: var(--lh-snug); }
:is(.study-app, .study-seat) .course-field__picks,
:is(.study-app, .study-seat) .course-field__chapters { display: flex; flex-wrap: wrap; gap: var(--space-1) 6px; margin: 0; padding: 0; min-width: 0; }
:is(.study-app, .study-seat) .course-field__chapters { padding: var(--space-2); border: 1px solid var(--line-soft); border-radius: var(--radius-sm); background: var(--bg-sunken); }
:is(.study-app, .study-seat) .course-field__pick { display: inline-flex; align-items: center; min-width: 0; max-width: min(100%, 22em); min-height: 30px; margin: 0;
  padding: 3px var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-pill); background: var(--bg-surface); color: var(--text-dim);
  font-size: var(--fs-sm); font-weight: 400; line-height: var(--lh-tight); white-space: nowrap; cursor: pointer; }
:is(.study-app, .study-seat) .course-field__pick-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
:is(.study-app, .study-seat) .course-field__pick-meta { flex: none; padding-left: 6px; color: var(--text-muted); }
:is(.study-app, .study-seat) .course-field__pick:hover:not(:disabled) { border-color: var(--line-strong); color: var(--text); }
:is(.study-app, .study-seat) .course-field__pick[aria-pressed="true"], :is(.study-app, .study-seat) .course-field__pick.has-chosen {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); color: var(--accent-text); background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface)); }
:is(.study-app, .study-seat) .course-field__pick--group[aria-expanded="true"] { border-style: solid; box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--accent) 45%, transparent); }
:is(.study-app, .study-seat) .course-field__pick--group::after,
:is(.study-app, .study-seat) .course-field__caret { content: ""; flex: none; width: 6px; height: 6px; margin-left: 8px; border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor; transform: translateY(-2px) rotate(45deg); opacity: 0.7; transition: transform 0.18s var(--ease); }
:is(.study-app, .study-seat) .course-field__pick--group[aria-expanded="true"]::after,
:is(.study-app, .study-seat) .course-field__more[aria-expanded="true"] .course-field__caret { transform: translateY(1px) rotate(225deg); }
:is(.study-app, .study-seat) .course-field__more { border-style: dashed; color: var(--text); font-weight: 550; }
:is(.study-app, .study-seat) .course-field__more[aria-expanded="true"] { border-style: solid; background: var(--bg-raised); }
:is(.study-app, .study-seat) .course-field__pick:focus-visible { outline: none; box-shadow: var(--ring); }
:is(.study-app, .study-seat) .course-field__panel { display: grid; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-3);
  border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--bg-raised); box-shadow: var(--shadow-md); }
:is(.study-app, .study-seat) .course-field__panel-head { display: flex; align-items: center; gap: var(--space-2); min-height: 32px; }
:is(.study-app, .study-seat) .course-field__panel-head strong { color: var(--text); font-size: var(--fs-sm); font-weight: 650; }
:is(.study-app, .study-seat) .course-field__panel-head small { margin-right: auto; color: var(--text-muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
:is(.study-app, .study-seat) .course-field__panel .sh-scroll__frame { background: var(--bg-surface); }
:is(.study-app, .study-seat) .course-field__options { display: grid; padding: var(--space-1); }
:is(.study-app, .study-seat) .course-field__option { display: flex; align-items: center; gap: var(--space-2); min-height: 36px; padding: 6px var(--space-3);
  border-radius: var(--radius-sm); color: var(--text-dim); font-size: var(--fs-sm); line-height: var(--lh-snug); cursor: pointer; }
:is(.study-app, .study-seat) .course-field__option:hover, :is(.study-app, .study-seat) .course-field__option.is-active { background: var(--bg-hover); color: var(--text); }
:is(.study-app, .study-seat) .course-field__option.is-active { box-shadow: inset 0 0 0 1px var(--line-strong); }
:is(.study-app, .study-seat) .course-field__option[aria-selected="true"] { color: var(--accent-text); }
:is(.study-app, .study-seat) .course-field__option--group { color: var(--text); font-weight: 600; }
:is(.study-app, .study-seat) .course-field__option--chapter { padding-left: calc(var(--space-3) + 20px * var(--depth, 1)); }
:is(.study-app, .study-seat) .course-field__option-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:is(.study-app, .study-seat) .course-field__option small { flex: none; color: var(--text-muted); font-size: var(--fs-xs); font-weight: 400; }
:is(.study-app, .study-seat) .course-field__option .course-field__option-check { color: var(--accent-text); font-weight: 600; }
:is(.study-app, .study-seat) .course-field__option-chevron { flex: none; width: 6px; height: 6px; margin: 0 4px 0 2px; border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); opacity: 0.7; transition: transform 0.18s var(--ease); }
:is(.study-app, .study-seat) .course-field__option[aria-expanded="true"] .course-field__option-chevron { transform: rotate(45deg); }
@container course-field (max-width: 720px) {
  :is(.study-app, .study-seat) .course-field__picks > .course-field__pick:not(.course-field__more):nth-child(n+5) { display: none; }
}
/* 有效课程: a parked (inactive) course stays selectable, only dimmed. */
:is(.study-app, .study-seat) .course-field__pick.is-parked { color: var(--text-muted); border-style: dashed; }
:is(.study-app, .study-seat) .course-field__option.is-parked { color: var(--text-muted); }
@container course-field (max-width: 480px) {
  :is(.study-app, .study-seat) .course-field__picks > .course-field__pick:not(.course-field__more):nth-child(n+4) { display: none; }
  :is(.study-app, .study-seat) .course-field__pick { max-width: 100%; }
}
`;
