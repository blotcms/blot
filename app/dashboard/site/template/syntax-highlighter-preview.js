const hljs = require("highlight.js");

const source = `/**
 * A small theme registry used to exercise common JavaScript tokens.
 * @param {string} id A theme identifier.
 */
import { createHash } from "node:crypto";

const defaults = {
  retries: 3,
  timeoutMs: 1_500,
  enabled: true,
  fallback: null,
};

const normalize = value => String(value ?? "").trim().toLowerCase();
const slug = value => normalize(value).replace(/[^\\w-]+/g, "-");

class ThemeRegistry {
  #themes = new Map();

  constructor(initialThemes = []) {
    initialThemes.forEach(theme => this.register(theme));
  }

  register({ id, name, styles }) {
    const key = slug(id);
    if (!key || !styles) throw new TypeError("A theme needs an id and CSS.");
    if (this.#themes.has(key)) throw new Error("Theme \"" + key + "\" already exists.");

    this.#themes.set(key, Object.freeze({ id: key, name, styles }));
    return this;
  }

  async load(id, { signal } = {}) {
    const key = slug(id);
    const cached = this.#themes.get(key);
    if (cached) return cached;

    const response = await fetch("/themes/" + encodeURIComponent(key) + ".json", {
      headers: { Accept: "application/json" },
      signal,
    });

    if (!response.ok) {
      throw new Error("Could not load " + key + ": HTTP " + response.status);
    }

    return response.json();
  }
}

function summarize(theme, index = 0) {
  const colors = theme.colors?.filter(Boolean) ?? [];
  const label = "Theme: " + (theme.name ?? "Untitled");
  const digest = createHash("sha256").update(theme.id).digest("hex").slice(0, 8);

  return {
    index: index + 1,
    label,
    digest,
    colors,
    contrast: theme.dark ? "dark" : "light",
  };
}

const registry = new ThemeRegistry([
  { id: "rose-pine", name: "Rose Pine", styles: ".hljs { color: #575279; }" },
  { id: "nord", name: "Nord", styles: ".hljs { color: #d8dee9; }" },
]);

const controller = new AbortController();
registry.load("missing-theme", { signal: controller.signal })
  .then(theme => console.table(summarize(theme)))
  .catch(error => console.error(error instanceof Error ? error.message : error));
`;

module.exports = hljs.highlight("javascript", source).value;
