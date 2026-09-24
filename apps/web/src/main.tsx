import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EnvValidationError } from "@whiteboard/shared/env";
import { App } from "./App";
import { readWebEnv } from "./env";
import { ConfigErrorPage } from "./pages/ConfigErrorPage";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element missing from index.html");
const root = createRoot(rootElement);

try {
  const env = readWebEnv();
  root.render(
    <StrictMode>
      <App env={env} />
    </StrictMode>,
  );
} catch (error) {
  if (!(error instanceof EnvValidationError)) throw error;
  root.render(<ConfigErrorPage message={error.message} />);
}
