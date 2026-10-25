// Runs the contextual navigation block of the portfolio, album and links
// scripts against a stubbed page, so no blog or server is needed.
describe("contextual navigation scripts", function () {
  const fs = require("fs");
  const path = require("path");
  const origin = "http://blog.test";

  function run(template, { location, pages, saved, cacheID = "new" }) {
    let source = fs.readFileSync(path.join(__dirname, "../source", template, "script.js"), "utf8");
    source = source.slice(source.indexOf("var collectionKey"), source.lastIndexOf("\ninitializeCollectionNavigation();") + 34);
    source = source
      .replace(/\{\{#infinite_scroll\}\}true\{\{\/infinite_scroll\}\}\{\{\^infinite_scroll\}\}false\{\{\/infinite_scroll\}\}/, "true")
      .replace(/\{\{#all_entries\}\}.*\{\{\/all_entries\}\}/, "")
      .replace("{{cacheID}}", cacheID);

    const store = { collectionNavigation: JSON.stringify(saved), portfolioCollection: JSON.stringify(saved) };
    const arrows = { previous: [], next: [] };
    const arrow = () => ({ href: "chronological", removeAttribute() { this.href = undefined; }, setAttribute() {}, style: {} });
    arrows.previous.push(arrow());
    arrows.next.push(arrow());

    const doc = (entries, next, previous) => ({
      querySelectorAll: () => entries.map(href => ({ href: origin + href })),
      querySelector: selector => {
        const href = selector.startsWith("a.collection-next") ? next : selector.startsWith("a.collection-previous") ? previous : null;
        return href ? { getAttribute: () => href, href: origin + href } : null;
      }
    });

    const sandbox = {
      sessionStorage: { getItem: k => store[k] || null, setItem: (k, v) => (store[k] = v), removeItem: k => delete store[k] },
      window: { location: new URL(origin + location), history: { state: null, length: 9, replaceState() {} } },
      document: {
        referrer: origin + "/",
        addEventListener() {},
        querySelectorAll: selector => (selector.startsWith("a.entry-") && arrows[selector.slice(8)]) || [],
        querySelector: selector => (selector.startsWith("a.entry-") && (arrows[selector.slice(8)] || [])[0]) || null
      },
      DOMParser: class { parseFromString(url) { return doc(...pages[url.replace(origin, "")]); } },
      fetch: async url => {
        const page = pages[url.replace(origin, "")];
        return page ? { ok: true, url, text: async () => url } : { ok: false };
      },
      URL, Promise, JSON, Object, parseInt
    };
    const names = Object.keys(sandbox);
    new Function(...names, source).apply(null, names.map(n => sandbox[n]));
    return new Promise(resolve => setTimeout(() => resolve({ store, hrefs: { previous: arrows.previous[0].href, next: arrows.next[0].href } }), 20));
  }

  ["portfolio", "album", "links"].forEach(template => {
    describe(template, function () {
      it("finds an entry again after a publish moved it to the next page", async function () {
        const result = await run(template, {
          location: "/e6",
          saved: { cacheID: "old", listings: [{ url: origin + "/page/1", entries: ["/e8", "/e7", "/e6"], next: origin + "/page/2", previous: null }] },
          pages: {
            "/page/1": [["/e9", "/e8", "/e7"], "/page/2", null],
            "/page/2": [["/e6", "/e5"], null, "/page/1"]
          }
        });
        expect(result.hrefs).toEqual({ previous: origin + "/e5", next: origin + "/e7" });
      });

      it("keeps the chronological links when the entry can't be found", async function () {
        const result = await run(template, {
          location: "/e6",
          saved: { cacheID: "old", listings: [{ url: origin + "/page/1", entries: ["/e6"], next: null, previous: null }] },
          pages: { "/page/1": [["/e9", "/e8"], null, null] }
        });
        expect(result.hrefs).toEqual({ previous: "chronological", next: "chronological" });
      });

      it("treats search results as the whole collection", async function () {
        const url = origin + "/search?q=apple";
        const search = location => run(template, {
          location,
          saved: { cacheID: "old", listings: [{ url, entries: ["/e1", "/e2", "/e3"], next: null, previous: null }] },
          pages: { "/search?q=apple": [["/e1", "/e2", "/e3"], null, null] }
        });

        expect((await search("/e2")).hrefs).toEqual({ previous: origin + "/e3", next: origin + "/e1" });
        expect((await search("/e1")).hrefs.next).toBeUndefined();
        expect((await search("/e3")).hrefs.previous).toBeUndefined();
      });

      it("keeps the chronological link when the adjacent page has no entries", async function () {
        const result = await run(template, {
          location: "/e3",
          cacheID: "same",
          saved: { cacheID: "same", listings: [{ url: origin + "/page/1", entries: ["/e1", "/e2", "/e3"], next: origin + "/page/2", previous: null }] },
          pages: { "/page/2": [[], null, null] }
        });
        expect(result.hrefs.previous).toBe("chronological");
      });
    });
  });
});
