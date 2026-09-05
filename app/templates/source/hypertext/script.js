// Plugin JavaScript for analytics embed code
{{{app_js}}}

{{> heading.js}}
{{> pre-copy.js}}

class PageTransitioner {
  constructor(linkSelector, contentSelector) {
    this.linkSelector = linkSelector;
    this.contentSelector = contentSelector;
    this.pageCache = new Map();
    this.currentXHR = null;

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
          /\.(rss|xml|atom|json|css|js|png|jpe?g|gif|webp|svg|pdf|zip|txt)$/i.test(
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
        this.navigate(e.state.url, false);
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

  async navigate(url, pushState = true) {
    if (this.currentXHR) {
      this.currentXHR.abort();
    }

    const content = document.querySelector(this.contentSelector);

    if (!content) return;

    const previousHTML = content.innerHTML;
    const { hash, displayUrl, cacheKey, fetchUrl } = this.parsePageUrl(url);

    content.classList.add("loading");
    document.documentElement.classList.add("is-loading");
    
    // close the mobile nav when a link is clicked
    const toggle = document.querySelector("#toggle-left");
    if (toggle) toggle.checked = false;

    const fallback = () => {
      content.innerHTML = previousHTML;
      window.location.assign(displayUrl);
    };

    try {
      let html;

      if (this.pageCache.has(cacheKey)) {
        html = this.pageCache.get(cacheKey);
      } else {
        const controller = new AbortController();
        this.currentXHR = controller;

        const response = await fetch(fetchUrl, {
          signal: controller.signal,
        });
        if (!response.ok) {
          fallback();
          return;
        }
        html = await response.text();
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

      const targetUrl = new URL(displayUrl, window.location.href);
      const normalize = (pathname) =>
        !pathname || pathname === "/" ? "/" : pathname.replace(/\/+$/, "") || "/";

      document.querySelectorAll(".sidebar a").forEach((link) => {
        let isActive = false;
        try {
          const linkUrl = new URL(link.href, window.location.href);
          isActive =
            normalize(linkUrl.pathname) === normalize(targetUrl.pathname);
        } catch (err) {
          console.warn("Invalid sidebar href:", err);
        }
        link.classList.toggle("active", isActive);
      });

      try {
        window.SidebarNavigation?.saveCache?.();
      } catch (err) {
        console.warn("Sidebar cache save failed:", err);
      }

      this.scrollToHash(hash);
      renderHeadingAnchors();
      preCopy();
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error("Navigation failed:", err);
      fallback();
    } finally {
      content.classList.remove("loading");
      document.documentElement.classList.remove("is-loading");
      this.currentXHR = null;
    }
  }
}

// Initialize with your selectors
new PageTransitioner("a", "main");
