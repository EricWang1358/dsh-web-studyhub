import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./style.css";
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
