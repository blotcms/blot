const COLLAPSE_NAVIGATION_BY_DEFAULT = {{#collapse_navigation_by_default}}true{{/collapse_navigation_by_default}}{{^collapse_navigation_by_default}}false{{/collapse_navigation_by_default}};

class SidebarNavigation {
  constructor() {
    this.root = document.querySelector(".sidebar");
    this.maxPages = 100;
    this.cacheKey = `documentation-sidebar:${
      document.querySelector('meta[name="blot-cache-id"]')?.content
    }:sort:${this.root?.dataset.sortBy || "id"}:${this.root?.dataset.sortOrder || "asc"}`;
  }

  normalizePathname(pathname) {
    if (!pathname || pathname === "/") return "/";
    return pathname.replace(/\/+$/, "") || "/";
  }

  async loadAllPages() {
    if (!this.root) return;
    const initialNext = this.root.querySelector(":scope > span[data-next]");
    this.root.querySelectorAll(":scope > span[data-next]").forEach((node) => node.remove());

    const knownPaths = new Set(
      Array.from(this.root.querySelectorAll(":scope > li[data-path]"), (item) =>
        item.getAttribute("data-path")
      )
    );
    const seen = new Set();
    // The initial list uses the configured page size, while this view uses 100.
    // Start at page one and de-duplicate so the two page sizes cannot skip entries.
    let token = initialNext ? "1" : null;
    let guard = 0;

    while (token && ++guard <= this.maxPages && !seen.has(token)) {
      seen.add(token);
      try {
        const response = await fetch(`/pagination/${encodeURIComponent(token)}`, {
          credentials: "same-origin",
        });
        if (!response.ok) break;

        const template = document.createElement("template");
        template.innerHTML = await response.text();
        token = template.content
          .querySelector("span[data-next]")
          ?.getAttribute("data-next");

        for (const node of Array.from(template.content.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) continue;
          if (node.nodeType === Node.ELEMENT_NODE && node.matches("span[data-next]")) continue;
          if (node.nodeType === Node.ELEMENT_NODE) {
            const path = node.getAttribute("data-path");
            if (path) {
              if (knownPaths.has(path)) continue;
              knownPaths.add(path);
            }
          }
          this.root.appendChild(node);
        }
      } catch (error) {
        console.warn("Documentation sidebar pagination failed:", error);
        break;
      }
    }
  }

  isIndexPath(path) {
    const filename = (path || "").split("/").filter(Boolean).at(-1) || "";
    const basename = filename.replace(/\.[^.]+$/, "");
    return /^(?:\d+[.\s_-]+)?(?:index|overview)$/i.test(basename);
  }

  titleFromPath(path) {
    return (path || "").split("/").filter(Boolean).at(-1)?.replace(/\.[^.]+$/, "")
      .replace(/[-_]/g, " ") || "";
  }

  folderPathFor(path) {
    return (path || "").split("/").filter(Boolean).slice(0, -1).join("/");
  }

  build() {
    if (!this.root || this.root.dataset.treeBuilt === "1") return;
    this.root.dataset.treeBuilt = "1";

    const entries = Array.from(this.root.querySelectorAll(":scope > li[data-path]"));
    const folderByPath = new Map();
    const ensureFolder = (path) => {
      if (folderByPath.has(path)) return folderByPath.get(path);
      const folder = document.createElement("li");
      folder.className = "folder has-submenu";
      folder.dataset.folder = path;
      folder.setAttribute("aria-expanded", "false");

      const label = document.createElement("button");
      label.type = "button";
      label.className = "folder-label";
      label.textContent = this.titleFromPath(path);
      label.setAttribute("aria-expanded", "false");
      folder.appendChild(label);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "folder-toggle";
      toggle.setAttribute("aria-label", `Expand ${label.textContent}`);
      toggle.setAttribute("aria-expanded", "false");
      folder.appendChild(toggle);

      const submenu = document.createElement("ul");
      submenu.className = "submenu";
      submenu.hidden = true;
      folder.appendChild(submenu);

      const record = { element: folder, label, toggle, submenu };
      folderByPath.set(path, record);
      return record;
    };

    const indexEntries = new Map();
    const ordinaryEntries = [];
    for (const entry of entries) {
      const path = entry.getAttribute("data-path") || "";
      const parentPath = this.folderPathFor(path);
      if (this.isIndexPath(path) && parentPath) {
        indexEntries.set(parentPath, entry);
      } else {
        ordinaryEntries.push(entry);
      }
    }

    const ensureAncestors = (path) => {
      const parts = path.split("/").filter(Boolean);
      let parent = this.root;
      let accumulated = "";
      for (const part of parts) {
        accumulated = accumulated ? `${accumulated}/${part}` : part;
        const folder = ensureFolder(accumulated);
        if (!folder.element.isConnected) parent.appendChild(folder.element);
        parent = folder.submenu;
      }
      return parent;
    };

    for (const folderPath of indexEntries.keys()) ensureAncestors(folderPath);

    for (const entry of ordinaryEntries) {
      const path = entry.getAttribute("data-path") || "";
      const parentPath = this.folderPathFor(path);
      const parent = parentPath ? ensureAncestors(parentPath) : this.root;
      parent.appendChild(entry);
    }

    for (const [path, entry] of indexEntries) {
      const folder = ensureFolder(path);
      const sourceLink = entry.querySelector(":scope > a");
      const href = sourceLink?.getAttribute("href");
      const title = sourceLink?.textContent?.trim();
      if (href) {
        const link = document.createElement("a");
        link.className = "folder-label";
        link.href = href;
        link.textContent = title || folder.label.textContent;
        folder.label.replaceWith(link);
        folder.label = link;
      }
      if (title) folder.label.textContent = title;
      folder.toggle.setAttribute("aria-label", `Expand ${folder.label.textContent}`);
      entry.remove();
    }

    this.sortTree(this.root);
  }

  pathForItem(item) {
    return item.classList.contains("folder")
      ? item.dataset.folder || ""
      : item.getAttribute("data-path") || "";
  }

  sortTree(list) {
    const items = Array.from(list.children).filter((item) => item.tagName === "LI");
    const folders = items.filter((item) => item.classList.contains("folder"));
    const files = items.filter((item) => !item.classList.contains("folder"));
    const descending =
      (this.root.dataset.sortBy || "id") === "id" &&
      this.root.dataset.sortOrder === "desc";
    const compare = (a, b) => {
      const left = this.pathForItem(a);
      const right = this.pathForItem(b);
      const result = left < right ? -1 : left > right ? 1 : 0;
      return descending ? -result : result;
    };

    folders.sort(compare);
    files.sort(compare);
    [...folders, ...files].forEach((item) => list.appendChild(item));
    folders.forEach((folder) => {
      const submenu = folder.querySelector(":scope > ul.submenu");
      if (submenu) this.sortTree(submenu);
    });
  }

  syncActiveFromLocation() {
    const currentPath = this.normalizePathname(window.location.pathname);
    this.root.querySelectorAll("a").forEach((link) => {
      try {
        const linkPath = this.normalizePathname(
          new URL(link.href, window.location.href).pathname
        );
        link.classList.toggle("active", linkPath === currentPath);
      } catch (error) {
        console.warn("Invalid documentation sidebar link:", error);
      }
    });
  }

  setFolder(folder, open) {
    folder.setAttribute("aria-expanded", open ? "true" : "false");
    const toggle = folder.querySelector(":scope > button.folder-toggle");
    const label = folder.querySelector(":scope > .folder-label");
    const submenu = folder.querySelector(":scope > ul.submenu");
    toggle?.setAttribute("aria-expanded", open ? "true" : "false");
    label?.setAttribute("aria-expanded", open ? "true" : "false");
    if (toggle) {
      const name = folder.querySelector(":scope > .folder-label")?.textContent || "folder";
      toggle.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${name}`);
    }
    if (submenu) submenu.hidden = !open;
  }

  expandedPaths() {
    try {
      return new Set(JSON.parse(localStorage.getItem(this.cacheKey)) || []);
    } catch {
      return new Set();
    }
  }

  saveExpandedPaths() {
    try {
      const paths = Array.from(this.root.querySelectorAll("li.folder[aria-expanded='true']"))
        .map((folder) => folder.dataset.folder);
      localStorage.setItem(this.cacheKey, JSON.stringify(paths));
    } catch (error) {
      console.warn("Documentation sidebar state save failed:", error);
    }
  }

  expandToActive() {
    const active = this.root.querySelector("a.active");
    if (!active) return;
    let list = active.closest("ul");
    while (list && list !== this.root) {
      const folder = list.parentElement?.closest("li.folder");
      if (!folder) break;
      this.setFolder(folder, true);
      list = folder.parentElement?.closest("ul");
    }
  }

  bindEvents() {
    this.root.addEventListener("click", (event) => {
      const control = event.target.closest(".folder-toggle, .folder-label");
      if (!control || !this.root.contains(control)) return;
      const folder = control.closest("li.folder");
      if (!folder) return;
      // An index-backed folder label remains a link. Expand it before its
      // normal navigation so the index page is shown with its children open.
      // Clicking it again while already on that page toggles instead.
      const isIndexLink = control.matches("a.folder-label");
      const isCurrent = isIndexLink && control.classList.contains("active");
      const expanded = folder.getAttribute("aria-expanded") === "true";
      const open = isIndexLink && !isCurrent ? true : !expanded;
      if (isCurrent) event.preventDefault();
      this.setFolder(folder, open);
      this.saveExpandedPaths();
    });
  }

  async init() {
    if (!this.root) return;
    await this.loadAllPages();
    this.build();
    this.syncActiveFromLocation();

    const savedPaths = this.expandedPaths();
    this.root.querySelectorAll("li.folder").forEach((folder) => {
      this.setFolder(folder, savedPaths.has(folder.dataset.folder));
    });
    if (!savedPaths.size && COLLAPSE_NAVIGATION_BY_DEFAULT) this.expandToActive();
    if (!COLLAPSE_NAVIGATION_BY_DEFAULT) {
      this.root.querySelectorAll("li.folder").forEach((folder) => this.setFolder(folder, true));
    }

    this.bindEvents();
    this.root.classList.add("initialized");
  }
}

function initializeSidebar() {
  const sidebar = document.querySelector(".sidebar");
  if (sidebar) new SidebarNavigation().init();
}

if (document.querySelector(".sidebar")) {
  initializeSidebar();
} else {
  const observer = new MutationObserver(() => {
    if (document.querySelector(".sidebar")) {
      initializeSidebar();
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
