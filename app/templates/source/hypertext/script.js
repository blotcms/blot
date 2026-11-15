// Plugin JavaScript for analytics embed code
{{{app_js}}}

{{> heading.js}}
{{> pre-copy.js}}

// The phone menu. The checkbox drives the CSS; the button is what readers
// and keyboards use.
const menu = {
  toggle: document.getElementById("toggle-left"),
  button: document.querySelector(".control-label"),

  isOpen() {
    return !!this.toggle?.checked;
  },

  set(open) {
    if (!this.toggle) return;
    this.toggle.checked = open;
    this.button?.setAttribute("aria-expanded", open ? "true" : "false");
    // navigation-js.js loads the full list of posts the first time
    if (open) document.dispatchEvent(new Event("hypertext:menu-open"));
  },

  init() {
    this.button?.addEventListener("click", () => this.set(!this.isOpen()));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen()) {
        this.set(false);
        this.button?.focus();
      }
    });
  },
};
menu.init();

class PageTransitioner {
  constructor(linkSelector, contentSelector) {
    this.linkSelector = linkSelector;
    this.contentSelector = contentSelector;
    this.pageCache = new Map();
    this.currentXHR = null;
    this.navigationID = 0;

    this.init();
  }

  parsePageUrl(url) {
    const parsed = new URL(url, window.location.href);
    const hash = parsed.hash;
    const displayUrl = parsed.href;
    const cacheUrl = new URL(parsed.href);
    cacheUrl.hash = "";
    const fetchUrl = new URL(parsed.href);
    fetchUrl.hash = "";
    fetchUrl.searchParams.set("partial", "true");
    return {
      hash,
      displayUrl,
      cacheKey: cacheUrl.href,
      fetchUrl: fetchUrl.href,
    };
  }

  init() {
    function isModified(e) {
      // Cmd (mac), Ctrl, Shift, Alt, or non-left mouse button
      return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
    }

    function isInternal(link) {
      if (!link || !link.href) return false;
      try {
        const linkURL = new URL(link.href, window.location.href);
        return linkURL.origin === window.location.origin;
      } catch {
        return false;
      }
    }

    function isSameDocumentHash(link) {
      if (!link || !link.href) return false;
      const linkURL = new URL(link.href, window.location.href);
      return (
        linkURL.origin === window.location.origin &&
        linkURL.pathname === window.location.pathname &&
        linkURL.hash.length > 1 // has a fragment
      );
    }

    function isDocumentNavigation(link) {
      if (!link || !link.href) return false;
      try {
        const url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) return false;
        const path = url.pathname.toLowerCase();
        // Feeds and static files should not be loaded into <main>.
        if (
          /\.(rss|xml|atom|json|css|js|png|jpe?g|gif|webp|avif|heic|tiff?|bmp|ico|svg|pdf|zip|gz|tgz|tar|rar|7z|dmg|exe|txt|md|csv|tsv|mp3|m4a|wav|flac|aac|ogg|oga|opus|mp4|m4v|mov|webm|avi|mkv|ogv|docx?|xlsx?|pptx?|odt|ods|odp|rtf|epub|pages|numbers|key|psd|ai|eps|woff2?|ttf|otf)$/i.test(
            path
          )
        ) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    }

    // Scroll positions are kept in history.state, and restored after a swap
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    if (!history.state?.url) {
      history.replaceState(
        { url: window.location.href },
        "",
        window.location.href
      );
    }

    // Hover prefetch: skip hashes
    document.addEventListener("mouseover", (e) => {
      const link = e.target.closest(this.linkSelector);
      if (
        isInternal(link) &&
        isDocumentNavigation(link) &&
        !isSameDocumentHash(link)
      )
        this.prefetch(link.href);
    });

    // Click nav: skip hashes
    document.addEventListener("click", (e) => {
      const link = e.target.closest(this.linkSelector);
      if (!link) return;

      // Let browser handle new-tab/window behavior and same-document hashes
      if (
        isModified(e) ||
        link.target === "_blank" ||
        link.hasAttribute("download")
      )
        return;

      // Let the browser handle same-page anchors (footnotes/backrefs)
      if (isSameDocumentHash(link)) return;

      if (isInternal(link) && isDocumentNavigation(link)) {
        e.preventDefault();
        link.blur();
        this.navigate(link.href);
      }
    });

    // Handle browser back/forward
    window.addEventListener("popstate", (e) => {
      if (e.state?.url) {
        this.navigate(e.state.url, false, e.state.scrollY);
      }
    });
  }

  async prefetch(url) {
    const { cacheKey, fetchUrl } = this.parsePageUrl(url);
    if (this.pageCache.has(cacheKey)) return;

    try {
      const response = await fetch(fetchUrl);
      if (!response.ok) return;
      const text = await response.text();
      this.pageCache.set(cacheKey, text);
    } catch (err) {
      console.warn("Prefetch failed:", err);
    }
  }

  scrollToHash(hash) {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    let target = null;
    try {
      const id = decodeURIComponent(hash.replace(/^#/, ""));
      if (id) {
        target =
          document.getElementById(id) ||
          document.querySelector(`[name="${CSS.escape(id)}"]`);
      }
    } catch (err) {
      console.warn("Invalid hash:", err);
    }
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  // Tells screen readers the new page's title after a swap
  announce(title) {
    if (!this.announcer) {
      this.announcer = document.createElement("div");
      this.announcer.className = "visually-hidden";
      this.announcer.setAttribute("aria-live", "polite");
      document.body.appendChild(this.announcer);
    }
    this.announcer.textContent = title;
  }

  async navigate(url, pushState = true, scrollY) {
    if (this.currentXHR) {
      this.currentXHR.abort();
      this.currentXHR = null;
    }

    const content = document.querySelector(this.contentSelector);

    if (!content) return;

    // A newer navigation started after this one if the ID has moved on
    const id = ++this.navigationID;
    const current = () => id === this.navigationID;

    const { hash, displayUrl, cacheKey, fetchUrl } = this.parsePageUrl(url);

    // Remember where the reader was on this page, for the back button
    if (pushState && history.state?.url) {
      history.replaceState({ ...history.state, scrollY: window.scrollY }, "");
    }

    // The current page stays until the new one has arrived
    content.classList.add("loading");
    document.documentElement.classList.add("is-loading");

    // close the mobile nav when a link is clicked
    menu.set(false);

    // A normal page load, for anything the swap can't handle
    const fallback = () => window.location.assign(displayUrl);

    let controller = null;

    try {
      let html;

      if (this.pageCache.has(cacheKey)) {
        html = this.pageCache.get(cacheKey);
      } else {
        controller = new AbortController();
        this.currentXHR = controller;

        const response = await fetch(fetchUrl, {
          signal: controller.signal,
        });
        if (!current()) return;
        if (!response.ok) {
          fallback();
          return;
        }
        html = await response.text();
        if (!current()) return;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const newContent = doc.querySelector(this.contentSelector);
      if (!newContent) {
        fallback();
        return;
      }

      this.pageCache.set(cacheKey, html);
      content.innerHTML = newContent.innerHTML;
      document.title = doc.title;

      if (pushState) {
        history.pushState({ url: displayUrl }, "", displayUrl);
      }

      // Re-run scripts
      content.querySelectorAll("script").forEach((oldScript) => {
        const newScript = document.createElement("script");
        Array.from(oldScript.attributes).forEach((attr) => {
          newScript.setAttribute(attr.name, attr.value);
        });
        newScript.textContent = oldScript.textContent;
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });

      try {
        window.SidebarNavigation?.instance?.update();
      } catch (err) {
        console.warn("Sidebar update failed:", err);
      }

      if (typeof scrollY === "number") window.scrollTo(0, scrollY);
      else this.scrollToHash(hash);

      // Keyboard and screen reader readers carry on from the new page
      if (!hash) content.focus({ preventScroll: true });
      this.announce(document.title);

      renderHeadingAnchors();
      preCopy();
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error("Navigation failed:", err);
      if (current()) fallback();
    } finally {
      if (current()) {
        content.classList.remove("loading");
        document.documentElement.classList.remove("is-loading");
      }
      if (this.currentXHR === controller) this.currentXHR = null;
    }
  }
}

// Initialize with your selectors
new PageTransitioner("a", "main");
