import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@camelthorn/ui/styles.css";
import "./app.css";
import "./reports.css";
import "./bank.css";
import "./print.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
