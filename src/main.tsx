import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/tailwind.css";
import "./styles/app.css";
import { applyThemeToDocument, loadTheme } from "./lib/theme";

// Apply persisted theme before first paint of React tree.
applyThemeToDocument(loadTheme(localStorage));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
