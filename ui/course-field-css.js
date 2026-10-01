/* Course picker (WP13 quick picks, WP14 clear button, hint and scroll window).
   A JS string rather than a .css file so every bundle that already includes
   CourseField keeps building without a CSS loader. */
export default `:is(.study-app, .study-seat) .course-field { display: grid; gap: var(--space-2); min-width: 0; margin: 0 0 var(--space-3); }
:is(.study-app, .study-seat) .source-organize > .course-field { max-width: 560px; }
:is(.study-app, .study-seat) .course-field__label { margin: 0; }
:is(.study-app, .study-seat) .course-field__control { position: relative; min-width: 0; }
:is(.study-app, .study-seat) .course-field__control > input { width: 100%; margin: 0; }
:is(.study-app, .study-seat) .course-field__control.has-value > input { padding-right: 44px; }
:is(.study-app, .study-seat) .course-field__clear { position: absolute; top: 50%; right: 6px; transform: translateY(-50%); color: var(--text-muted); }
:is(.study-app, .study-seat) .course-field__clear:hover:not(:disabled) { color: var(--text); }
:is(.study-app, .study-seat) .course-field__hint { display: block; margin: 0; color: var(--text-muted); font-size: var(--fs-sm); font-weight: 400; line-height: var(--lh-snug); }
:is(.study-app, .study-seat) .course-field__picks { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; padding: 0; list-style: none; min-width: 0; }
:is(.study-app, .study-seat) .course-field__window .course-field__picks { padding: var(--space-2); }
:is(.study-app, .study-seat) .course-field__pick-item { display: flex; min-width: 0; max-width: 100%; }
:is(.study-app, .study-seat) .course-field__pick { min-height: 28px; padding: 3px var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-pill);
  background: var(--bg-surface); color: var(--text-dim); font-size: var(--fs-sm); font-weight: 400; line-height: var(--lh-tight); cursor: pointer; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:is(.study-app, .study-seat) .course-field__pick:hover:not(:disabled) { border-color: var(--line-strong); color: var(--text); }
:is(.study-app, .study-seat) .course-field__pick[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); color: var(--accent-text);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface)); }
:is(.study-app, .study-seat) .course-field__pick:focus-visible { outline: none; box-shadow: var(--ring); }
:is(.study-app, .study-seat) .course-field__window .sh-scroll__frame { background: var(--bg-sunken); }
:is(.study-app, .study-seat) .course-field__window .sh-scroll__empty { padding: var(--space-3); text-align: left; }
`;
