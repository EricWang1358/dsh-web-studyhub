/* Course picker quick picks (WP13). A JS string rather than a .css file so every
   bundle that already includes CourseField keeps building without a CSS loader. */
export default `:is(.study-app, .study-seat) .course-field { min-width: 0; }
:is(.study-app, .study-seat) .source-organize > .course-field { max-width: 560px; }
:is(.study-app, .study-seat) .course-field > label { margin-bottom: var(--space-2); }
:is(.study-app, .study-seat) .course-field__picks { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0 0 var(--space-3); }
:is(.study-app, .study-seat) .course-field__pick { min-height: 28px; padding: 3px var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-pill);
  background: var(--bg-surface); color: var(--text-dim); font-size: var(--fs-sm); line-height: var(--lh-tight); cursor: pointer; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:is(.study-app, .study-seat) .course-field__pick:hover:not(:disabled) { border-color: var(--line-strong); color: var(--text); }
:is(.study-app, .study-seat) .course-field__pick[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); color: var(--accent-text);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface)); }
:is(.study-app, .study-seat) .course-field__pick:focus-visible { outline: none; box-shadow: var(--ring); }
`;
