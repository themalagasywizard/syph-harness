import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppFence } from "./ext";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppFence>
      <App />
    </AppFence>
  </StrictMode>,
);
