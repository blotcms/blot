// Map folder [Eg] to 'Eg'
const STRIP_TAG_TOKENS = true;
const COLLAPSE_NAVIGATION_BY_DEFAULT = {{#collapse_navigation_by_default}}true{{/collapse_navigation_by_default}}{{^collapse_navigation_by_default}}false{{/collapse_navigation_by_default}};

class SidebarNavigation {
  constructor() {
    this.root = document.querySelector(".sidebar");
    if (!this.root) return;
    this.cacheKey =
      "sidebarState:" +
      document.querySelector('meta[name="blot-cache-id"]')?.content;
    this.maxPages = 100;
  }

  // ------- cache -------
  _loadCache() {
    try {
      return localStorage.getItem(this.cacheKey);
    } catch (err) {
      console.warn("Sidebar cache read failed:", err);
      return null;
    }
  }
  _saveCache() {
    try {
      localStorage.setItem(this.cacheKey, this.root.innerHTML);
    } catch (err) {
      console.warn("Sidebar cache write failed:", err);
    }
  }
  _clearCache() {
    try {
      localStorage.removeItem(this.cacheKey);
    } catch (err) {
      console.warn("Sidebar cache clear failed:", err);
    }
  }

  _normalizePathname(pathname) {
    if (!pathname || pathname === "/") return "/";
    return pathname.replace(/\/+$/, "") || "/";
  }

  _pathsFromHTML(html) {
    const t = document.createElement("template");
    t.innerHTML = html;
    return new Set(
      Array.from(t.content.querySelectorAll("[data-path]"))
        .map((el) => el.getAttribute("data-path"))
        .filter(Boolean)
    );
  }

  _cacheIsStale(serverHTML, cachedHTML) {
    const serverPaths = this._pathsFromHTML(serverHTML);
    const cachedPaths = this._pathsFromHTML(cachedHTML);
    for (const path of serverPaths) {
      if (!cachedPaths.has(path)) return true;
    }
    return false;
  }

  syncActiveFromLocation() {
    if (!this.root) return;
    const currentPath = this._normalizePathname(window.location.pathname);
    this.root.querySelectorAll("a").forEach((link) => {
      let linkPath = "";
      try {
        const href = link.getAttribute("href") || link.href;
        linkPath = this._normalizePathname(
          new URL(href, window.location.href).pathname
        );
      } catch (err) {
        console.warn("Invalid sidebar href:", err);
        return;
      }
      link.classList.toggle("active", linkPath === currentPath);
    });
  }

  // ------- pagination -------
  async loadAllPages() {
    if (!this.root) return;
    const parseHTML = (html) => {
      const t = document.createElement("template");
      t.innerHTML = html;
      return t.content;
    };

    const seen = new Set();
    let guard = 0;
    while (true) {
      if (++guard > this.maxPages) break;
      const nextEl = this.root.querySelector(":scope span[data-next]");
      if (!nextEl) break;

      const token = nextEl.getAttribute("data-next");
      nextEl.remove();

      if (!token) continue;

      this.root.querySelectorAll(":scope span[data-next]").forEach((el) => {
        if (el.getAttribute("data-next") === token) el.remove();
      });

      if (seen.has(token)) continue;
      seen.add(token);

      try {
        const res = await fetch(`/pagination/${encodeURIComponent(token)}`, {
          credentials: "same-origin",
        });
        if (!res.ok) {
          console.warn("Pagination fetch failed:", res.status, token);
          continue;
        }
        const html = await res.text();
        const frag = parseHTML(html);

        for (const node of Array.from(frag.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim())
            continue;
          this.root.appendChild(node);
        }
      } catch (err) {
        console.warn("Pagination fetch failed:", err);
        break;
      }
    }

    this.items = Array.from(this.root.querySelectorAll(":scope > li"));
  }

  // ------- build -------
  build() {
    if (!this.root || this.root.dataset.treeBuilt === "1") return;
    this.root.dataset.treeBuilt = "1";

    // separate menu items from normal posts
    const allLis = Array.from(this.root.querySelectorAll(":scope > li"));
    const menuItems = allLis.filter((li) => li.hasAttribute("data-menu"));
    const postItems = allLis.filter((li) => !li.hasAttribute("data-menu"));

    // collect hrefs from menu items (normalize to handle trailing slash variations)
    const normalizeHref = (href) => {
      if (!href) return "";
      // remove trailing slash for comparison (except for root "/")
      return href === "/" ? "/" : href.replace(/\/$/, "");
    };

    const getHref = (li) => {
      const a = li.querySelector(":scope > a");
      return a ? (a.getAttribute("href") || a.href) : null;
    };

    const menuHrefs = new Set();
    menuItems.forEach((li) => {
      const href = getHref(li);
      if (href) menuHrefs.add(normalizeHref(href));
    });

    // filter out post items that match menu hrefs, removing them from DOM
    const filteredPostItems = postItems.filter((li) => {
      const href = getHref(li);
      if (!href) return true;
      const shouldKeep = !menuHrefs.has(normalizeHref(href));
      if (!shouldKeep) li.remove();
      return shouldKeep;
    });
    
    const byPath = new Map();
    byPath.set("", { el: this.root, submenu: this.root });

    const segTitle = (s) => {
      let out = s.replace(/[-_]/g, " ");
      if (typeof STRIP_TAG_TOKENS !== "undefined" && STRIP_TAG_TOKENS) {
        out = out.replace(/\[([^\]]+)\]/g, "$1"); // remove surrounding [ ]
      }
      return out;
    };

    const ensureFolder = (folderPath) => {
      if (byPath.has(folderPath)) return byPath.get(folderPath);
      const seg = folderPath.split("/").filter(Boolean).at(-1) || "";
      const li = document.createElement("li");
      li.className = "folder has-submenu";
      li.dataset.folder = folderPath;
      li.setAttribute("aria-expanded", "false");

      const label = document.createElement("button");
      label.type = "button";
      label.className = "folder-label";
      label.textContent = segTitle(seg);
      li.appendChild(label);

      const submenu = document.createElement("ul");
      submenu.className = "submenu";
      submenu.hidden = true;
      li.appendChild(submenu);

      const node = { el: li, submenu };
      byPath.set(folderPath, node);
      return node;
    };

    // build nested tree for post items only
    filteredPostItems.forEach((li) => {
      const path = li.getAttribute("data-path") || "";
      const parts = path.split("/").filter(Boolean);
      const folderParts = parts.slice(0, -1);

      let parentPath = "";
      let parentNode = byPath.get("");

      for (const seg of folderParts) {
        const nextPath = parentPath + "/" + seg;
        const node = ensureFolder(nextPath);
        if (!node.el.isConnected) parentNode.submenu.appendChild(node.el);
        parentNode = node;
        parentPath = nextPath;
      }

      parentNode.submenu.appendChild(li);
    });

    this.applyFolderTitles();
    this.sortTree(this.root);

    // append menu items flat, in original order
    if (menuItems.length) {
      menuItems[0].classList.add("menu-separator");
      menuItems.forEach((li) => this.root.appendChild(li));
    }
  }

  applyFolderTitles() {
    if (!this.root) return;
    const indexName = /^(?:\d+[.\s_-]+)?(index|overview)$/i;
    const basename = (filePath) => {
      const last = (filePath || "").split("/").filter(Boolean).at(-1) || "";
      return last.replace(/\.[^.]+$/, "");
    };

    this.root.querySelectorAll("li.folder").forEach((folder) => {
      const submenu = folder.querySelector(":scope > ul.submenu");
      if (!submenu) return;
      const indexLi = Array.from(submenu.children).find((li) => {
        if (li.classList.contains("folder")) return false;
        return indexName.test(basename(li.getAttribute("data-path") || ""));
      });
      if (!indexLi) return;
      const title = indexLi.querySelector(":scope > a")?.textContent?.trim();
      const label = folder.querySelector(":scope > .folder-label");
      if (title && label) label.textContent = title;
    });
  }

  // ------- sorting -------
  labelForLi(li) {
    if (li.classList.contains("folder")) {
      return (
        li.querySelector(":scope > .folder-label")?.textContent?.trim() || ""
      );
    }
    const a = li.querySelector(":scope > a");
    return a?.textContent?.trim() || li.getAttribute("data-filename") || "";
  }

  sortLocale() {
    const lang = (
      document.documentElement.lang ||
      document.querySelector('meta[name="language"]')?.content ||
      ""
    ).trim();
    return lang || undefined;
  }

  sortTree(ul) {
    const children = Array.from(ul.children).filter((n) => n.tagName === "LI");
    const folders = children.filter((li) => li.classList.contains("folder"));
    const files = children.filter((li) => !li.classList.contains("folder"));
    const locale = this.sortLocale();

    const cmp = (a, b) =>
      this.labelForLi(a).localeCompare(this.labelForLi(b), locale, {
        sensitivity: "base",
      });

    folders.sort(cmp);
    files.sort(cmp);

    // Root pages must come before folders. Folders-first leaves those pages
    // under the last directory, where they look like an expanded submenu.
    const ordered = ul === this.root ? [...files, ...folders] : [...folders, ...files];
    ordered.forEach((li) => ul.appendChild(li));

    folders.forEach((li) => {
      const sub = li.querySelector(":scope > ul.submenu");
      if (sub) this.sortTree(sub);
    });
  }

  // ------- toggle -------
  setFolder(li, open) {
    li.setAttribute("aria-expanded", open ? "true" : "false");
    const submenu = li.querySelector(":scope > ul.submenu");
    if (submenu) submenu.hidden = !open;
  }
  toggleFolder(li) {
    const open = li.getAttribute("aria-expanded") === "true";
    this.setFolder(li, !open);
    this._saveCache();
  }

  // ------- default expand -------
  expandToActiveIfAny() {
    if (!this.root) return;
    if (!COLLAPSE_NAVIGATION_BY_DEFAULT) {
      this.root.querySelectorAll("li.folder").forEach((li) => this.setFolder(li, true));
      return;
    }
    this.root.querySelectorAll("li.folder").forEach((li) => this.setFolder(li, false));
    const active = this.root.querySelector("a.active");
    if (!active) return;
    let ul = active.closest("ul");
    while (ul && ul !== this.root) {
      const folder = ul.parentElement?.closest("li.folder");
      if (!folder) break;
      this.setFolder(folder, true);
      ul = folder.parentElement?.closest("ul");
    }
  }

  // ------- events -------
  _bindEvents() {
    this.root.addEventListener("click", (e) => {
      const btn = e.target.closest("button.folder-label");
      if (!btn || !this.root.contains(btn)) return;
      const folder = btn.closest("li.folder");
      if (folder) this.toggleFolder(folder);
    });

    this.root.addEventListener("keydown", (e) => {
      const btn = e.target.closest("button.folder-label");
      if (!btn) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const folder = btn.closest("li.folder");
        if (folder) this.toggleFolder(folder);
      }
    });
  }

  // ------- init -------
  async init() {
    if (!this.root) return;

    const serverHTML = this.root.innerHTML;
    const cached = this._loadCache();

    if (cached && !this._cacheIsStale(serverHTML, cached)) {
      this.root.innerHTML = cached;
      this.syncActiveFromLocation();
      this.expandToActiveIfAny();
      this._bindEvents();
      this.root.classList.add("initialized");
      this._saveCache();
      return;
    }

    if (cached) this._clearCache();

    await this.loadAllPages();
    this.build();
    this.syncActiveFromLocation();
    this.expandToActiveIfAny();
    this._bindEvents();
    this.root.classList.add("initialized");
    this._saveCache();
  }

  static saveCache() {
    try {
      const sidebar = document.querySelector(".sidebar");
      if (!sidebar) return;
      localStorage.setItem(
        "sidebarState:" +
          document.querySelector('meta[name="blot-cache-id"]')?.content,
        sidebar.innerHTML
      );
    } catch (err) {
      console.warn("Sidebar cache save failed:", err);
    }
  }
}

// boot
(async function boot() {
  const start = async () => {
    await new SidebarNavigation().init();
  };
  if (document.querySelector(".sidebar")) start();
  else {
    const mo = new MutationObserver(() => {
      if (document.querySelector(".sidebar")) {
        start();
        mo.disconnect();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();

// make the class available globally
if (typeof window !== "undefined") window.SidebarNavigation = SidebarNavigation;
