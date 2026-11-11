import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@camelthorn/ui/styles.css";
import "./app.css";
import "./reports.css";
import "./bank.css";
import "./matching.css";
import "./fx.css";
import "./print.css";
import { App } from "./App";
import { rootErrorHandlers } from "./lib/root-errors";

const root = document.getElementById("root");
if (root) {
  createRoot(root, rootErrorHandlers).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
