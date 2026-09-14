import React from "react";

export default function Icon({ children, className }) {
  return (
    <span className={"icon" + (className ? " " + className : "")} aria-hidden="true">
      {children}
    </span>
  );
}
