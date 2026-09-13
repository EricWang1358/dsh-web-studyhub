import React from "react";
import { createRoot } from "react-dom/client";
// style.css first, then the views: the real host injects them in this order
// (plugin styles on apply, view styles on first mount), and equal-specificity
// ties must resolve the same way in the preview as they do in the host.
import "./style.css";
import App from "./App.jsx";
const call = async (action, args = {}) => {
  const response = await fetch("/api/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Study-Token": window.STUDY_TOKEN,
    },
    body: JSON.stringify({ action, args }),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
createRoot(document.getElementById("root")).render(<App call={call} />);
