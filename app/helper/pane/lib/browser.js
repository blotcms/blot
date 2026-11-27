// browser() -> the browser window's HTML. See DESIGN.md "Browser windows" for the DOM contract.

const { OS_KEYS } = require("./os");
const css = require("./css");

const escape = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );

// A static page is shown in a sandboxed iframe (srcdoc): the docs' own CSS (h1, p, a, pre) must not
// reach it, and the page's vw/vh units refer to the window, not the docs page. Scripts are off, and links
// open in a new tab rather than replacing the mock page.
const STATIC_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";
// A live site gets scripts, forms and popups, but not allow-same-origin: with it a page on the docs'
// own origin could lift its sandbox, and the site would see the docs' cookies.
const LIVE_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

const COLOUR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i;

// "https://www.example.com/a/b?x#y" -> the pieces a skin can show or hide. Anything that is not a
// plain http(s) address is shown as typed.
function parseUrl(raw) {
  const text = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text)
    ? text
    : `https://${text}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch (e) {
    return { text };
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return { text };
  const www = /^www\./i.test(u.hostname) ? "www." : "";
  const host = u.hostname.slice(www.length) + (u.port ? `:${u.port}` : "");
  const path = u.pathname + u.search + u.hash;
  return {
    secure: u.protocol === "https:",
    scheme: `${u.protocol}//`,
    www,
    host,
    path,
    root: path === "/",
    plain: `${www}${host}`,
  };
}

const safeSrc = (src) => {
  const s = String(src || "").trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return "";
  return s;
};

const document_ = (html) => {
  const page = String(html);
  const full = /^\s*(<!doctype|<html)/i.test(page);
  return full
    ? page.replace(/<head([^>]*)>/i, '<head$1><base target="_blank">')
    : `<!doctype html><meta charset="utf-8"><base target="_blank">${page}`;
};

function browser(options) {
  options = options || {};
  const pin =
    OS_KEYS.includes(options.os) &&
    css.SKINS.includes(options.os) &&
    css.viewsOf(options.os).includes("browser")
      ? options.os
      : null;
  if (options.os && !pin)
    console.warn(
      `pane: ignoring os pin "${String(options.os)}" (no browser view built for it); the window follows the visitor`
    );
  const theme = ["light", "dark"].includes(options.theme)
    ? options.theme
    : null;

  const src = safeSrc(options.src);
  if (options.src && !src)
    console.warn(`pane: ignoring browser src "${String(options.src)}"`);
  const hasHtml = options.html !== undefined && options.html !== null;
  if (hasHtml && src)
    console.warn("pane: browser has both html and src; showing the html");

  const url = parseUrl(options.url !== undefined ? options.url : src);
  const title =
    String(options.title || "").trim() ||
    (url && (url.plain || url.text)) ||
    "Browser";

  let address = "";
  if (url && url.text !== undefined)
    address = `<span class="pane-u-h">${escape(url.text)}</span>`;
  else if (url)
    address =
      `<span class="pane-u-s">${escape(url.scheme)}</span>` +
      (url.www ? `<span class="pane-u-w">www.</span>` : "") +
      `<span class="pane-u-h">${escape(url.host)}</span>` +
      `<span class="pane-u-p${url.root ? " pane-u-r" : ""}">${escape(url.path)}</span>`;

  let page = "";
  if (hasHtml)
    page = `<iframe class="pane-frame" title="${escape(title)}, page" sandbox="${STATIC_SANDBOX}" srcdoc="${escape(document_(options.html))}"></iframe>`;
  else if (src)
    page = `<iframe class="pane-frame" title="${escape(title)}, page" loading="lazy" referrerpolicy="no-referrer" sandbox="${escape(options.sandbox || LIVE_SANDBOX)}" src="${escape(src)}"></iframe>`;

  const tint =
    options.tint && COLOUR.test(String(options.tint).trim())
      ? String(options.tint).trim()
      : null;
  const style = [
    options.width && `--pane-w:${escape(options.width)}`,
    options.height && `--pane-h:${escape(options.height)}`,
    tint && `--br-tint:${escape(tint)}`,
  ]
    .filter(Boolean)
    .join(";");

  return (
    `<figure class="pane pane-br" data-view="browser" data-secure="${url && url.secure ? "true" : "false"}"${pin ? ` data-pin="${pin}"` : ""}${theme ? ` data-theme="${theme}"` : ""}${style ? ` style="${style}"` : ""} aria-label="${escape(title)}">` +
    `<div class="pane-bar" aria-hidden="true"><span class="pane-tab">${escape(title)}</span></div>` +
    `<div class="pane-head" aria-hidden="true"></div>` +
    `<span class="pane-url" aria-hidden="true">${address}</span>` +
    `<div class="pane-page">${page}</div>` +
    "</figure>"
  );
}

// For the docs build: <pre class="browser" data-url="https://example.com" title="Example Domain"
// [data-src="https://example.com/"] [data-tint="#eee"]> the page's HTML </pre>. The page is the pre's
// text (the code child's, if any); data-src shows a live site instead.
function transform($, render) {
  $("pre.browser").each((i, el) => {
    const code = $(el).find("code").first();
    const source = (code.length ? code : $(el))
      .text()
      .replace(/^\n+|\s+$/g, "");
    const src = $(el).attr("data-src") || undefined;
    const result = render({
      url: $(el).attr("data-url") || undefined,
      src,
      html: src || !source ? undefined : source,
      title: ($(el).attr("title") || "").trim() || undefined,
      tint: $(el).attr("data-tint") || undefined,
      os: $(el).attr("data-os") || undefined,
      theme: $(el).attr("data-theme") || undefined,
      width: $(el).attr("data-width") || undefined,
      height: $(el).attr("data-height") || undefined,
    });
    $(el).replaceWith(result.html);
  });
}

module.exports = { browser, parseUrl, transform, STATIC_SANDBOX, LIVE_SANDBOX };
