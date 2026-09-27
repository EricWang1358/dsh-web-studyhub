import React from "react";

/* DSH hands plugins React itself, not its JSX runtime. Libraries compiled for
   the automatic runtime (the note editor) resolve here instead, so the client
   bundle keeps requiring nothing but "react" from the host. createElement
   reads children from props when no extra arguments are given. */
const withKey = (props, key) => (key === undefined ? props : { ...props, key });

export const Fragment = React.Fragment;
export const jsx = (type, props, key) => React.createElement(type, withKey(props, key));
// Static children arrive as an array; spreading them keeps React from asking for keys.
export const jsxs = (type, props, key) => {
  const { children, ...rest } = props;
  return React.createElement(type, withKey(rest, key), ...(Array.isArray(children) ? children : [children]));
};
export const jsxDEV = (type, props, key, isStatic) => (isStatic ? jsxs : jsx)(type, props, key);
