import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { TipProvider } from "./components/Tip";
import { LanguageProvider } from "./lib/i18n";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>
      <TipProvider>
        <App />
      </TipProvider>
    </LanguageProvider>
  </StrictMode>
);
