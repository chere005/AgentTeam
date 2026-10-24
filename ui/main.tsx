import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, syncThemeToShell } from "./theme";
import "./style.css";
// Hand-tuned light-theme exceptions; last, so they win over the derived light twins.
import "./theme-light.css";
// Before the first render, so legacy preferences never flash a different theme.
applyTheme();
// The desktop shell learns the stored setting (it preloads it on the next launch).
syncThemeToShell();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
