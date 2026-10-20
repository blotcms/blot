import React from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";

// The proxy supplies this attribute only on explicitly allowed local hosts.
const script = document.currentScript;
if (script?.dataset.blotAgentation === "local" && !document.getElementById("blot-agentation")) {
  const container = document.createElement("div");
  container.id = "blot-agentation";
  document.body.appendChild(container);
  createRoot(container).render(
    <Agentation endpoint={`${location.origin}/__agentation/api`} />
  );
}
