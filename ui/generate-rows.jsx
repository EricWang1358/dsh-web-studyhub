import React from 'react';

/* The two parts the 创建题组 form is built from, shared by the page and by 额外要求 (ui/GenerationTransparency.jsx): one decision about how a row of the form is laid out
   (generate-form.css: the label column on wide panes, stacked on narrow ones). */

/** A purpose in 更多选项: a small title over its rows. */
export function FormGroup({ title, children }) {
  return (
    <div className="generate-group" role="group" aria-label={title}>
      <p className="generate-group__title">{title}</p>
      {children}
    </div>
  );
}

/** One label-left row of the form: the label column on wide panes, stacked on narrow ones. */
export function FormRow({ label, htmlFor, children, ...rest }) {
  return (
    <div className="generate-row" {...rest}>
      {htmlFor ? <label className="generate-row__label" htmlFor={htmlFor}>{label}</label> : <div className="generate-row__label">{label}</div>}
      <div className="generate-row__control">{children}</div>
    </div>
  );
}
