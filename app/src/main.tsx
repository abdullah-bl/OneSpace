import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OnebaseClient, OnebaseProvider } from "onebase/react";
import { App } from "./App";
import "./index.css";

const client = new OnebaseClient(location.origin);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OnebaseProvider client={client}>
      <App />
    </OnebaseProvider>
  </StrictMode>,
);
