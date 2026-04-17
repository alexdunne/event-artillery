import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./global.css";
import { EventSenderApp } from "./EventSenderApp.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EventSenderApp />
  </StrictMode>,
);
