const fs = require("fs").promises;
const path = require("path");
const express = require("express");
const config = require("config");
const { randomBytes } = require("crypto");

describe("blog asset symlink policy", function () {
  let blogID, blog, server, url;
  beforeEach(async function () {
    blogID = "blog_" + randomBytes(8).toString("hex");
    blog = path.join(config.blog_folder_dir, blogID);
    await fs.mkdir(path.join(blog, "folder"), {recursive:true});
    await fs.writeFile(path.join(blog, "folder/file.txt"), "ordinary");
    await fs.symlink("folder/file.txt", path.join(blog, "link.txt"));
    await fs.symlink("folder", path.join(blog, "ancestor"));
    await fs.mkdir(path.join(blog, "index-link"));
    await fs.symlink("../folder/file.txt", path.join(blog, "index-link/index.html"));
    const app = express();
    app.use("/cdn", require("../../cdn"));
    app.use((req, res, next) => {req.blog = {id:blogID}; next();});
    app.use(require("../routes/assets"));
    app.use((req,res) => res.sendStatus(404));
    server = await new Promise(resolve => { const s = app.listen(0,"127.0.0.1",() => resolve(s)); });
    url = "http://127.0.0.1:" + server.address().port;
  });
  afterEach(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(blog, {recursive:true,force:true});
  });
  it("serves ordinary files including case-insensitive lookup", async function () {
    expect(await (await fetch(url + "/folder/file.txt")).text()).toEqual("ordinary");
    expect(await (await fetch(url + "/FOLDER/FILE.txt")).text()).toEqual("ordinary");
  });
  it("enforces the same policy on raw CDN files and implicit index files", async function () {
    expect(await (await fetch(url + "/cdn/folder/v-1/" + blogID + "/folder/file.txt")).text()).toEqual("ordinary");
    for (const suffix of ["link.txt", "ancestor/file.txt", "index-link/", "index-link/index.html"]) {
      const response = await fetch(url + "/cdn/folder/v-1/" + blogID + "/" + suffix);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    }
  });
  it("serves percent-encoded CDN paths, as baked by encodeFolderPath", async function () {
    const { encodeFolderPath } = require("../render/replaceFolderLinks/shared");
    const name = "/folder/my pic, 100% #1.txt";
    await fs.writeFile(path.join(blog, name), "encoded");
    const response = await fetch(url + "/cdn/folder/v-1/" + blogID + encodeFolderPath(name));
    expect(await response.text()).toEqual("encoded");
  });
  it("refuses direct and ancestor symlinks through every path fallback", async function () {
    for (const suffix of ["/link.txt", "/ancestor/file.txt", "/ANCESTOR/FILE.txt"]) {
      expect((await fetch(url + suffix)).status).toBe(404);
    }
  });
  describe("the CDN's folder route", function () {
    const cdnURL = (suffix) => url + "/cdn/folder/v-1/" + blogID + suffix;

    it("serves a file with a year of caching, validators, ranges and HEAD", async function () {
      await fs.writeFile(path.join(blog, "range.txt"), "0123456789");

      const res = await fetch(cdnURL("/range.txt"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toEqual("public, max-age=31536000");
      expect(res.headers.get("content-type")).toEqual("text/plain; charset=UTF-8");
      expect(res.headers.get("access-control-allow-origin")).toEqual("*");
      expect(res.headers.get("accept-ranges")).toEqual("bytes");
      expect(res.headers.get("etag")).toBeTruthy();
      expect(res.headers.get("last-modified")).toBeTruthy();

      const partial = await fetch(cdnURL("/range.txt"), { headers: { Range: "bytes=2-4" } });
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
      await fs.mkdir(path.join(blog, "site"));
      await fs.writeFile(path.join(blog, "site/index.html"), "<p>index</p>");

      const redirect = await fetch(cdnURL("/site?a=b"), { redirect: "manual" });
      expect(redirect.status).toBe(301);
      expect(new URL(redirect.headers.get("location"), url).pathname).toEqual(
        "/cdn/folder/v-1/" + blogID + "/site/"
      );
      expect(redirect.headers.get("location")).toMatch(/\?a=b$/);

      expect(await (await fetch(cdnURL("/site/"))).text()).toEqual("<p>index</p>");
      expect((await fetch(cdnURL("/folder/"))).status).toBe(404);
    });

    it("serves a name with a space, and answers a bad request with a bare 404", async function () {
      await fs.writeFile(path.join(blog, "a b.txt"), "spaced");

      expect(await (await fetch(cdnURL("/a%20b.txt"))).text()).toEqual("spaced");

      for (const suffix of [
        "/a%20b.txt/",
        "/missing.txt",
        "/%E0%A4%A",
        "/%00",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/..%2f..%2fetc/passwd",
        "/folder/%2e%2e/%2e%2e/file.txt",
        "/%EF%BC%8F..%EF%BC%8Fetc",
      ]) {
        const res = await fetch(cdnURL(suffix));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("Not Found");
      }

      expect((await fetch(url + "/cdn/folder/v-1/notablog/folder/file.txt")).status).toBe(404);
      expect((await fetch(url + "/cdn/folder/v-1/")).status).toBe(404);
    });

    it("ignores dotfiles", async function () {
      await fs.mkdir(path.join(blog, ".hidden"));
      await fs.writeFile(path.join(blog, ".hidden/a.txt"), "dot");
      await fs.writeFile(path.join(blog, ".dot.txt"), "dot");

      expect((await fetch(cdnURL("/.hidden/a.txt"))).status).toBe(404);
      expect((await fetch(cdnURL("/.dot.txt"))).status).toBe(404);
      expect((await fetch(cdnURL("/.hidden"))).status).toBe(404);
    });

    it("refuses a symlinked directory, however it is asked for", async function () {
      for (const suffix of ["/ancestor", "/ancestor/", "/ancestor/file.txt"]) {
        expect((await fetch(cdnURL(suffix), { redirect: "manual" })).status).toBe(404);
      }
    });
  });

  it("finds a file by its case on a page of a directory after the first", async function () {
    // storage/folder lists 1000 entries at a time; the last name sorts last, and matches only ignoring case
    const names = Array.from({ length: 1001 }, (_, i) => "F" + String(i).padStart(4, "0") + ".txt");
    await fs.mkdir(path.join(blog, "big"));
    for (let i = 0; i < names.length; i += 100) {
      await Promise.all(
        names.slice(i, i + 100).map((name) => fs.writeFile(path.join(blog, "big", name), name))
      );
    }

    expect(await (await fetch(url + "/big/f1000.txt")).text()).toEqual("F1000.txt");
  });
});
