import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Editor } from "./Editor.tsx";
import { Stage } from "./Stage.tsx";
import "./styles.css";

const mode = window.canvasBridge.mode;
document.documentElement.dataset.mode = mode;

createRoot(document.getElementById("root")!).render(
  <StrictMode>{mode === "stage" ? <Stage /> : <Editor />}</StrictMode>,
);
