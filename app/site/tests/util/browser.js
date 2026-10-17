const cheerio = require("cheerio");

const MAX_REDIRECTS = 10;

// A minimal stand-in for a browser, for specs that click through pages the
// way a person would without needing a real one. It sits on top of the
// fetch (and cookie jar) provided by global.test.site: pass it the spec's
// `this`. Pages are plain server-rendered HTML, so there is nothing to run:
// links are followed, forms are submitted with the fields a browser would
// send (hidden inputs such as the CSRF token, whatever has been typed, and
// the clicked button's own name and value), and redirects are followed.
//
//   const page = browser(this);
//   await page.goto("/sites");
//   await page.click('a[href^="/sites/"]');
//   page.type("input[name=title]", "New title");
//   await page.click("[type=submit]");
//   expect(page.pathname).toEqual("/sites/example");
module.exports = function browser(context) {
  const state = { url: null, status: null, $: null, typed: new Map() };

  async function load(url, options = {}) {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await context.fetch(url, { ...options, redirect: "manual" });
      const location = res.headers.get("location");

      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).href;
        options = {};
        continue;
      }

      state.url = new URL(url, context.origin);
      state.status = res.status;
      state.$ = cheerio.load(await res.text());
      state.typed = new Map();
      return;
    }

    throw new Error("Too many redirects loading " + url);
  }

  // The fields a browser sends when the form is submitted using `button`
  function serialize($form, button) {
    const params = new URLSearchParams();

    $form.find("input, textarea, select, button").each(function () {
      const $el = state.$(this);
      const name = $el.attr("name");
      const type = ($el.attr("type") || "text").toLowerCase();

      if (!name || $el.attr("disabled") !== undefined) return;

      // Only the button that was clicked is submitted
      if (this.tagName === "button" || ["submit", "image"].includes(type)) {
        if (this === button) params.append(name, $el.attr("value") || "");
        return;
      }

      if (["button", "reset", "file"].includes(type)) return;

      if (["checkbox", "radio"].includes(type)) {
        if ($el.attr("checked") !== undefined)
          params.append(name, $el.attr("value") || "on");
        return;
      }

      if (this.tagName === "select") {
        const selected = $el.find("option[selected]").first();
        const option = selected.length ? selected : $el.find("option").first();
        params.append(name, option.attr("value") ?? option.text());
        return;
      }

      const value = state.typed.has(this)
        ? state.typed.get(this)
        : this.tagName === "textarea"
        ? $el.text()
        : $el.attr("value") || "";

      params.append(name, value);
    });

    return params;
  }

  return {
    get url() {
      return state.url.href;
    },
    get pathname() {
      return state.url.pathname;
    },
    get status() {
      return state.status;
    },
    get $() {
      return state.$;
    },
    get title() {
      return state.$("title").text();
    },

    goto: (path) => load(new URL(path, context.origin).href),

    // Replaces the value of a text field, like selecting all of its text and
    // typing over it
    type(selector, text) {
      const element = state.$(selector).get(0);
      if (!element) throw new Error("No element matches " + selector);
      state.typed.set(element, text);
    },

    // Follows the link, or submits the form the button belongs to
    async click(selector) {
      const element = state.$(selector).get(0);
      if (!element) {
        throw new Error(`No element matches ${selector} on ${state.url.href}`);
      }

      if (element.tagName === "a") {
        return load(new URL(state.$(element).attr("href"), state.url).href);
      }

      const $form = state.$(element).closest("form");
      if (!$form.length) throw new Error(selector + " is not in a form");

      const action = new URL($form.attr("action") || state.url.href, state.url);
      const params = serialize($form, element);

      if (($form.attr("method") || "get").toLowerCase() !== "post") {
        action.search = params.toString();
        return load(action.href);
      }

      return load(action.href, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    },
  };
};
