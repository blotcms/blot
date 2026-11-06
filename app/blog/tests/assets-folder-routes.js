const express = require("express");
const folder = require("storage/folder");
const { randomBytes } = require("crypto");

describe("blog asset folder routes", function () {
  let blogID, server, url;
  beforeEach(async function () {
    blogID = "blog_" + randomBytes(8).toString("hex");
    await folder.write(blogID, "folder/file.txt", "ordinary");
    const app = express();
    app.use("/cdn", require("../../cdn"));
    app.use((req, res, next) => {
      req.blog = { id: blogID };
      next();
    });
    app.use(require("../routes/assets"));
    app.use((req, res) => res.sendStatus(404));
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    url = "http://127.0.0.1:" + server.address().port;
  });
  afterEach(async function () {
    if (server) await new Promise((resolve) => server.close(resolve));
    await folder.removeAll(blogID);
  });
  it("serves ordinary files including case-insensitive lookup", async function () {
    expect(await (await fetch(url + "/folder/file.txt")).text()).toEqual(
      "ordinary"
    );
    expect(await (await fetch(url + "/FOLDER/FILE.txt")).text()).toEqual(
      "ordinary"
    );
  });
  it("serves raw CDN files", async function () {
    expect(
      await (
        await fetch(url + "/cdn/folder/v-1/" + blogID + "/folder/file.txt")
      ).text()
    ).toEqual("ordinary");
  });
  it("serves percent-encoded CDN paths, as baked by encodeFolderPath", async function () {
    const { encodeFolderPath } = require("../render/replaceFolderLinks/shared");
    const name = "/folder/my pic, 100% #1.txt";
    await folder.write(blogID, name, "encoded");
    const response = await fetch(
      url + "/cdn/folder/v-1/" + blogID + encodeFolderPath(name)
    );
    expect(await response.text()).toEqual("encoded");
  });
  describe("the CDN's folder route", function () {
    const cdnURL = (suffix) => url + "/cdn/folder/v-1/" + blogID + suffix;

    it("serves a file with a year of caching, validators, ranges and HEAD", async function () {
      await folder.write(blogID, "range.txt", "0123456789");

      const res = await fetch(cdnURL("/range.txt"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toEqual(
        "public, max-age=31536000"
      );
      expect(res.headers.get("content-type").toLowerCase()).toEqual(
        "text/plain; charset=utf-8"
      );
      expect(res.headers.get("access-control-allow-origin")).toEqual("*");
      expect(res.headers.get("accept-ranges")).toEqual("bytes");
      expect(res.headers.get("etag")).toBeTruthy();
      expect(res.headers.get("last-modified")).toBeTruthy();

      const unsatisfiable = await fetch(cdnURL("/range.txt"), {
        headers: { Range: "bytes=100-" },
      });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toEqual("bytes */10");

      const partial = await fetch(cdnURL("/range.txt"), {
        headers: { Range: "bytes=2-4" },
      });
      expect(partial.status).toBe(206);
      expect(await partial.text()).toEqual("234");

      const head = await fetch(cdnURL("/range.txt"), { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toEqual("10");
      expect(await head.text()).toEqual("");

      const post = await fetch(cdnURL("/range.txt"), { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toEqual("GET, HEAD");
    });

    it("redirects a directory to its trailing slash and serves its index.html there", async function () {
      await folder.write(blogID, "site/index.html", "<p>index</p>");

      const root = await fetch(cdnURL(""), { redirect: "manual" });
      expect(root.status).toBe(301);
      expect(new URL(root.headers.get("location"), url).pathname).toMatch(
        /\/$/
      );

      const redirect = await fetch(cdnURL("/site?a=b"), { redirect: "manual" });
      expect(redirect.status).toBe(301);
      expect(new URL(redirect.headers.get("location"), url).pathname).toEqual(
        "/cdn/folder/v-1/" + blogID + "/site/"
      );
      expect(redirect.headers.get("location")).toMatch(/\?a=b$/);

      expect(await (await fetch(cdnURL("/site/"))).text()).toEqual(
        "<p>index</p>"
      );
      expect((await fetch(cdnURL("/folder/"))).status).toBe(404);
    });

    it("serves a name with a space, and answers a bad request with a bare 404", async function () {
      await folder.write(blogID, "a b.txt", "spaced");

      expect(await (await fetch(cdnURL("/a%20b.txt"))).text()).toEqual(
        "spaced"
      );

      for (const suffix of [
        "/a%20b.txt/",
        "/missing.txt",
        "/%E0%A4%A",
        "/%00",
        "/..%2f..%2fetc/passwd",
        "/folder/%2e%2e/%2e%2e/file.txt",
        "/%EF%BC%8F..%EF%BC%8Fetc",
      ]) {
        const res = await fetch(cdnURL(suffix));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("Not Found");
      }

      // fetch resolves %2e%2e itself, so this leaves the folder route
      expect((await fetch(cdnURL("/%2e%2e/%2e%2e/etc/passwd"))).status).toBe(
        404
      );
      expect(
        (await fetch(url + "/cdn/folder/v-1/notablog/folder/file.txt")).status
      ).toBe(404);
      expect((await fetch(url + "/cdn/folder/v-1/")).status).toBe(404);
    });

    it("ignores dotfiles", async function () {
      await folder.write(blogID, ".hidden/a.txt", "dot");
      await folder.write(blogID, ".dot.txt", "dot");

      expect((await fetch(cdnURL("/.hidden/a.txt"))).status).toBe(404);
      expect((await fetch(cdnURL("/.dot.txt"))).status).toBe(404);
      expect((await fetch(cdnURL("/.hidden"))).status).toBe(404);
    });

    it("serves a pending image once it syncs, ignoring case, with short caching", async function () {
      const pendingURL = (suffix) =>
        url + "/cdn/folder/v-pending/" + blogID + suffix;

      const missing = await fetch(pendingURL("/Photos/Pic.JPG"));
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toEqual(
        "public, max-age=60"
      );

      await folder.write(blogID, "photos/pic.jpg", "pic");

      const found = await fetch(pendingURL("/Photos/Pic.JPG"));
      expect(found.status).toBe(200);
      expect(await found.text()).toEqual("pic");
      expect(found.headers.get("cache-control")).toEqual(
        "public, max-age=3600"
      );

      // a directory is never a pending image
      expect((await fetch(pendingURL("/photos"))).status).toBe(404);
      expect((await fetch(pendingURL("/photos/"))).status).toBe(404);

      // other versions keep the exact lookup
      expect((await fetch(cdnURL("/Photos/Pic.JPG"))).status).toBe(404);
    });
  });

  it("finds a file by its case on a page of a directory after the first", async function () {
    // storage/folder lists 1000 entries at a time; the last name sorts last, and matches only ignoring case
    const names = Array.from(
      { length: 1001 },
      (_, i) => "F" + String(i).padStart(4, "0") + ".txt"
    );
    for (let i = 0; i < names.length; i += 100) {
      await Promise.all(
        names
          .slice(i, i + 100)
          .map((name) => folder.write(blogID, "big/" + name, name))
      );
    }

    expect(await (await fetch(url + "/big/f1000.txt")).text()).toEqual(
      "F1000.txt"
    );
  });
});
