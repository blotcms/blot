const COLLAPSE_NAVIGATION_BY_DEFAULT = {{#collapse_navigation_by_default}}true{{/collapse_navigation_by_default}}{{^collapse_navigation_by_default}}false{{/collapse_navigation_by_default}};

function sidebarCacheKey(root) {
  return (
    "sidebarState:v5:" +
    document.querySelector('meta[name="blot-cache-id"]')?.content +
    ":sort:" +
    (root?.dataset.sortBy || "id") +
    ":" +
    (root?.dataset.sortOrder || "asc")
  );
}

class SidebarNavigation {
  constructor() {
    this.root = document.querySelector(".sidebar");
    if (!this.root) return;
    this.cacheKey = sidebarCacheKey(this.root);
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
    SidebarNavigation.saveCache(this.root);
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
      const isActive = linkPath === currentPath;
      link.classList.toggle("active", isActive);
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  // Called by the page transitioner after a client-side navigation
  update() {
    if (!this.root) return;
    this.syncActiveFromLocation();
    this.revealActive();
    this._saveCache();
  }

  // ------- pagination -------
  async loadAllPages() {
    if (!this.root) return;
    const parseHTML = (html) => {
      const t = document.createElement("template");
      t.innerHTML = html;
      return t.content;
    };

    // The sidebar is server-rendered with the blog's own page_size, but
    // /pagination/:page is a separate view with its own (larger) page size,
    // so the inline data-next token doesn't line up with it: following it
    // skips every entry between the two page sizes. Ignore the inline token
    // and walk /pagination from page 1, de-duplicating against what's
    // already in the list.
    const hasMore = this.root.querySelector(":scope span[data-next]");
    this.root
      .querySelectorAll(":scope span[data-next]")
      .forEach((el) => el.remove());

    const knownPaths = new Set(
      Array.from(this.root.querySelectorAll(":scope > li[data-path]")).map(
        (li) => li.getAttribute("data-path")
      )
    );

    const seen = new Set();
    let token = hasMore ? "1" : null;
    while (token) {
      if (seen.has(token)) break;
      seen.add(token);

      try {
        const res = await fetch(`/pagination/${encodeURIComponent(token)}`, {
          credentials: "same-origin",
        });
        if (!res.ok) {
          console.warn("Pagination fetch failed:", res.status, token);
          break;
        }
        const frag = parseHTML(await res.text());

        token = frag.querySelector("span[data-next]")?.getAttribute("data-next");

        for (const node of Array.from(frag.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim())
            continue;
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches("span[data-next]")) continue;
            const path = node.getAttribute("data-path");
            if (path) {
              if (knownPaths.has(path)) continue;
              knownPaths.add(path);
            }
          }
          this.root.appendChild(node);
        }
      } catch (err) {
        console.warn("Pagination fetch failed:", err);
        break;
      }
    }
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
    const normalizeHref = (href) =>
      href ? this._normalizePathname(href) : "";

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

    // Map folder [Eg] to 'Eg'
    const segTitle = (s) =>
      s.replace(/[-_]/g, " ").replace(/\[([^\]]+)\]/g, "$1");

    const ensureFolder = (folderPath) => {
      if (byPath.has(folderPath)) return byPath.get(folderPath);
      const seg = folderPath.split("/").filter(Boolean).at(-1) || "";
      const li = document.createElement("li");
      li.className = "folder has-submenu";
      li.dataset.folder = folderPath;

      const label = document.createElement("button");
      label.type = "button";
      label.className = "folder-label";
      label.setAttribute("aria-expanded", "false");
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

    this.linkFoldersToIndex();
    this.sortTree(this.root);

    // append menu items flat, in original order
    if (menuItems.length) {
      menuItems[0].classList.add("menu-separator");
      menuItems.forEach((li) => this.root.appendChild(li));
    }
  }

  // A folder containing an index/overview entry links to it. The folder keeps
  // its own name; the index file only supplies the link.
  linkFoldersToIndex() {
    if (!this.root) return;
    const indexName = /^(?:(\d+)[.\s_-]+)?(index|overview)$/i;
    const basename = (filePath) => {
      const last = (filePath || "").split("/").filter(Boolean).at(-1) || "";
      return last.replace(/\.[^.]+$/, "");
    };

    // Several candidates: prefer "index" over "overview", then the lowest
    // number, then unnumbered, then path, so the choice doesn't depend on the
    // order pages arrived in.
    const rank = (li) => {
      const path = li.getAttribute("data-path") || "";
      const m = indexName.exec(basename(path));
      if (!m) return null;
      return [
        m[2].toLowerCase() === "index" ? 0 : 1,
        m[1] === undefined ? Infinity : parseInt(m[1], 10),
        path,
      ];
    };
    const compare = (a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    };

    this.root.querySelectorAll("li.folder").forEach((folder) => {
      const submenu = folder.querySelector(":scope > ul.submenu");
      const label = folder.querySelector(":scope > .folder-label");
      if (!submenu || !label) return;

      let indexLi = null;
      let best = null;
      for (const li of submenu.children) {
        if (li.classList.contains("folder")) continue;
        const r = rank(li);
        if (r && (!best || compare(r, best) < 0)) [indexLi, best] = [li, r];
      }
      const indexLink = indexLi?.querySelector(":scope > a");
      if (!indexLink) return;

      // Promote the index entry: reuse its link as the folder label and drop
      // its row from the submenu. Its data-path moves to the link so cache
      // staleness checks still see it.
      indexLink.className = "folder-label";
      indexLink.textContent = label.textContent;
      const path = indexLi.getAttribute("data-path");
      if (path) indexLink.setAttribute("data-path", path);
      label.replaceWith(indexLink);
      indexLi.remove();
      folder.classList.add("has-index");

      // An index with nothing else beside it leaves nothing to expand: keep
      // the folder as a plain link with no toggle or submenu.
      if (!submenu.children.length) {
        submenu.remove();
        return;
      }

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "folder-toggle";
      toggle.setAttribute("aria-label", "Toggle " + indexLink.textContent);
      toggle.setAttribute("aria-expanded", "false");
      indexLink.after(toggle);
    });
  }

  // ------- sorting -------
  // Return the key the post listing sorts on: the entry's normalised path,
  // case preserved. models/entries orders these with Redis' byte-wise
  // lexicographic sorted set (entries:lex), so compare them the same way
  // rather than with a locale collation or a case fold.
  pathForLi(li) {
    const raw = li.classList.contains("folder")
      ? li.getAttribute("data-folder")
      : li.getAttribute("data-path");
    return raw || "";
  }

  shouldReverseSort() {
    const sortBy = this.root?.dataset.sortBy || "id";
    const sortOrder = this.root?.dataset.sortOrder || "asc";
    return sortBy === "id" && sortOrder === "desc";
  }

  sortTree(ul) {
    const children = Array.from(ul.children).filter((n) => n.tagName === "LI");
    const folders = children.filter((li) => li.classList.contains("folder"));
    const files = children.filter((li) => !li.classList.contains("folder"));
    const reverse = this.shouldReverseSort();

    const cmp = (a, b) => {
      const pa = this.pathForLi(a);
      const pb = this.pathForLi(b);
      const result = pa < pb ? -1 : pa > pb ? 1 : 0;
      return reverse ? -result : result;
    };

    folders.sort(cmp);
    files.sort(cmp);

    const ordered = [...folders, ...files];
    ordered.forEach((li) => ul.appendChild(li));

    folders.forEach((li) => {
      const sub = li.querySelector(":scope > ul.submenu");
      if (sub) this.sortTree(sub);
    });
  }

  // ------- toggle -------
  // Expanded state lives on the folder's button and its submenu's hidden flag
  setFolder(li, open) {
    li.querySelector(":scope > button")?.setAttribute(
      "aria-expanded",
      open ? "true" : "false"
    );
    const submenu = li.querySelector(":scope > ul.submenu");
    if (submenu) submenu.hidden = !open;
  }
  toggleFolder(li) {
    const submenu = li.querySelector(":scope > ul.submenu");
    if (!submenu) return;
    this.setFolder(li, submenu.hidden);
    this._saveCache();
  }

  // ------- expand -------
  // Applied to a freshly built tree only; a cached tree keeps whatever the
  // visitor last opened or closed.
  applyDefaultExpansion() {
    this.root
      .querySelectorAll("li.folder")
      .forEach((li) => this.setFolder(li, !COLLAPSE_NAVIGATION_BY_DEFAULT));
  }

  // Open every folder above the active page (an active index page sits on its
  // own folder's label, so that folder opens too).
  revealActive() {
    const active = this.root.querySelector("a.active");
    let folder = active?.closest("li.folder");
    while (folder) {
      this.setFolder(folder, true);
      folder = folder.parentElement?.closest("li.folder");
    }
  }

  // ------- events -------
  _bindEvents() {
    this.root.addEventListener("click", (e) => {
      const link = e.target.closest("a.folder-label");
      if (link && this.root.contains(link)) {
        const folder = link.closest("li.folder");
        if (!folder || !folder.querySelector(":scope > ul.submenu")) return;
        // Leave new-tab/window clicks to the browser
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
        if (link.classList.contains("active")) {
          // Already on the index page: act as a toggle, don't re-navigate.
          // stopPropagation is needed as well as preventDefault: the page
          // transitioner listens on document and ignores defaultPrevented.
          e.preventDefault();
          e.stopPropagation();
          this.toggleFolder(folder);
        } else {
          this.setFolder(folder, true);
          this._saveCache();
        }
        return;
      }

      const btn = e.target.closest("button.folder-label, button.folder-toggle");
      if (!btn || !this.root.contains(btn)) return;
      const folder = btn.closest("li.folder");
      if (folder) this.toggleFolder(folder);
    });
  }

  // ------- init -------
  async init() {
    if (!this.root) return;

    const serverHTML = this.root.innerHTML;
    const cached = this._loadCache();

    if (cached && !this._cacheIsStale(serverHTML, cached)) {
      this.root.innerHTML = cached;
    } else {
      await this.loadAllPages();
      this.build();
      this.applyDefaultExpansion();
    }

    this.syncActiveFromLocation();
    this.revealActive();
    this._bindEvents();
    this.root.classList.add("initialized");
    this._saveCache();
    SidebarNavigation.instance = this;
  }

  static saveCache(root = document.querySelector(".sidebar")) {
    if (!root) return;
    try {
      localStorage.setItem(sidebarCacheKey(root), root.innerHTML);
    } catch (err) {
      console.warn("Sidebar cache write failed:", err);
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
