import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { EnvValidationError } from "@whiteboard/shared/env";
import { App } from "./App";
import { readWebEnv } from "./env";
import { preloadPublicPage } from "./routes";
import { ConfigErrorPage } from "./pages/ConfigErrorPage";
import { readPublicData, seedQueryClient } from "./site/publicData";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element missing from index.html");

try {
  const env = readWebEnv();
  const queryClient = new QueryClient();
  seedQueryClient(queryClient, readPublicData());
  const app = (
    <StrictMode>
      <BrowserRouter>
        <App env={env} queryClient={queryClient} />
      </BrowserRouter>
    </StrictMode>
  );
  if (rootElement.firstElementChild) {
    // A prerendered public page (src/site/prerender): attach to its HTML instead of rendering
    // again, once the page's module is loaded (it is already downloading: modulepreload), so
    // hydration never suspends. Not a top-level await: the page's chunk imports this module.
    void preloadPublicPage(window.location.pathname).finally(() => {
      hydrateRoot(rootElement, app);
    });
  } else {
    // App pages come with an empty shell (app.html).
    createRoot(rootElement).render(app);
  }
} catch (error) {
  if (!(error instanceof EnvValidationError)) throw error;
  rootElement.replaceChildren();
  createRoot(rootElement).render(<ConfigErrorPage message={error.message} />);
}
