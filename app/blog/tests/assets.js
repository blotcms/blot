const cdn = require("../../cdn");

describe("asset middleware", function () {
  const config = require("config");
  const fs = require("fs-extra");

  require("./util/setup")();

  it("sends files with spaces", async function () {
    await this.write({ path: "/First page.txt", content: "Foo" });
    expect(await this.text("/First page.txt")).toEqual("Foo");
  });

  it("sends files with accents", async function () {
    await this.write({ path: "/Fête.txt", content: "Foo" });
    expect(await this.text("/Fête.txt")).toEqual("Foo");
  });

  it("returns files with lower-case paths against upper-case URLs", async function () {
    await this.write({ path: "/pages/first.txt", content: "Foo" });
    const body = await this.text(`/Pages/First.txt`);
    expect(body).toEqual("Foo");
  });

  it("returns files with upper-case paths against lower-case URLs", async function () {
    await this.write({ path: "/Pages/First.txt", content: "Foo" });
    const body = await this.text(`/pages/first.txt`);
    expect(body).toEqual("Foo");
  });

  it("returns files against URLs with incorrect case", async function () {
    await this.write({ path: "/Pages/First.xml", content: "123" });
    const body = await this.text(`/pAgEs/FiRsT.xMl`);
    expect(body).toEqual("123");
  });

  it("returns the correct file if there are multiple with similar case", async function () {
    await this.write({ path: "/Pages/First.xml", content: "123" });
    await this.write({ path: "/pages/first.xml", content: "345" });
    expect(await this.text(`/pages/first.xml`)).toEqual("345");
    expect(await this.text(`/Pages/First.xml`)).toEqual("123");
  });

  it("sends a file with .html extension in the blog folder", async function () {
    const path = "/Foo/File.html";
    const content = global.test.fake.file();
    await this.write({ path, content });
    expect(await this.text("/Foo/File")).toEqual(content);
  });

  it("sends a file with an underscore prefix and .html extension", async function () {
    const path = "/Foo/_File.html";
    const pathWithoutUnderscore = "/Foo/File/";
    const content = global.test.fake.file();
    await this.write({ path, content });
    expect(await this.text(pathWithoutUnderscore)).toEqual(content);
  });

  it("will set max-age when the url has the query cache and extension", async function () {
    const path = global.test.fake.path(".txt");
    const content = global.test.fake.file();

    await this.write({ path, content });
    const res = await this.get(`${path}?cache=true&extension=.txt`);
    expect(res.headers.get("cache-control")).toEqual("public, max-age=86400");
    const body = await res.text();
    expect(body).toEqual(content);
  });

  it("sends a file in the blog folder", async function () {
    const path = global.test.fake.path(".txt");
    const content = global.test.fake.file();

    await this.write({ path, content });
    const res = await this.get(path);
    expect(res.status).toEqual(200);
    const body = await res.text();
    expect(body).toEqual(content);
  });

  it("sends files in the static folder for this blog", async function () {
    const paths = [
      "/_assets/img/asset.png",
      "/_avatars/avatar.png",
      "/_bookmark_screenshots/screenshot.png",
      "/_image_cache/image.jpg",
      "/_thumbnails/thumbnail.jpg",
    ];

    const contents = {};

    for (const path of paths) {
      const content = global.test.fake.file();
      contents[path] = content;
      await fs.outputFile(
        config.blog_static_files_dir + "/" + this.blog.id + path,
        content
      );
    }

    for (const path of paths) {
      const res = await this.get(path);
      expect(res.status).toEqual(200);
      const body = await res.text();
      expect(body).toEqual(contents[path]);
    }
  });

  it("sends a file in the global static folder", async function () {
    const response = await this.text("/layout.css");
    const expected = await fs.readFile(
      __dirname + "/../static/layout.css",
      "utf-8"
    );
    expect(response).toEqual(expected);

    const response1 = await this.text("/html2canvas.min.js");
    const expected1 = await fs.readFile(
      __dirname + "/../static/html2canvas.min.js",
      "utf-8"
    );

    expect(response1).toEqual(expected1);
  });

  // This test ensures that the middleware will pass
  // the request on if it can't find a matching file.
  it("returns a 404 correctly", async function () {
    const res = await this.get("/" + global.test.fake.random.uuid());
    expect(res.status).toEqual(404);
  });

  it("won't send a file in the .git directory of the blog folder", async function () {
    const path = "/.git";
    const content = global.test.fake.file();

    await this.write({ path, content });
    const res = await this.get(path);
    expect(res.status).toEqual(404);
    const body = await res.text();
    expect(body).not.toEqual(content);
  });

  it("serves folder assets via the CDN", async function () {
    const filePath = "/folder/cdn-test.txt";
    const fileContents = "CDN integration test content";

    await this.write({ path: filePath, content: fileContents });
    await this.template({
      "entries.html": '<a href="/folder/cdn-test.txt">Link</a>',
    });

    const cdnURL = (await this.text("/")).split('"')[1];
    expect(await this.text(cdnURL)).toBe(fileContents);
  });

  it("handles double slashes in URLs correctly", async function () {
    await this.write({ path: "/folder/file.txt", content: "Content" });
    expect(
      await this.text(
        `https://${this.blog.handle}.${config.host}//folder//file.txt`
      )
    ).toEqual("Content");
  });

  it("sets correct Content-Type header for various file types", async function () {
    const files = [
      { path: "/test.jpg", content: "fake-image", type: "image/jpeg" },
      {
        path: "/test.json",
        content: '{"key":"value"}',
        type: "application/json",
      },
      { path: "/test.css", content: "body {}", type: "text/css" },
    ];

    for (const file of files) {
      await this.write({ path: file.path, content: file.content });
      const res = await this.get(file.path);
      expect(res.headers.get("content-type")).toContain(file.type);
    }
  });

  it("handles URLs with percent encodings beyond spaces", async function () {
    await this.write({ path: "/folder#1/file+1.txt", content: "Special" });
    expect(await this.text("/folder%231/file%2B1.txt")).toEqual("Special");
  });

  // it("prevents directory traversal attempts", async function () {
  //   await this.write({ path: "/secure.txt", content: "Secret" });
  //   const res = await this.get("/../secure.txt");
  //   expect(res.status).toEqual(404);
  // });

  it("handles very long file paths correctly", async function () {
    const longPath = "/a".repeat(100) + "/file.txt";
    await this.write({ path: longPath, content: "Long path" });
    expect(await this.text(longPath)).toEqual("Long path");
  });

  it("properly handles files without extensions", async function () {
    await this.write({ path: "/TODO", content: "# Documentation" });
    const res = await this.get("/TODO");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toEqual("# Documentation");
  });

  it("rejects traversal patterns and disallowed extensions", async function () {
    const attempts = [
      { request: "/../secret.txt", writePath: "/secret.txt" },
      { request: "/file.php", writePath: "/file.php" },
      { request: "/file.txt%00.jpg", writePath: "/file.txt" },
    ];

    for (const attempt of attempts) {
      await this.write({ path: attempt.writePath, content: "Sensitive" });
      // Use the raw path otherwise the path will be normalized to /secret.txt by the URL API before the request is sent.
      const res = await this.getWithRawPath(attempt.request);
      expect(res.status).toEqual(404);
      expect(await res.text()).not.toEqual("Sensitive");
    }
  });

  it("rejects URL-encoded traversal attempts", async function () {
    await this.write({ path: "/secret.txt", content: "Top secret" });
    const res = await this.getWithRawPath("/%2e%2e/secret.txt");
    expect(res.status).toEqual(404);
    expect(await res.text()).not.toEqual("Top secret");
  });

  it("continues to serve valid assets", async function () {
    await this.write({ path: "/public/ok.txt", content: "Allowed" });
    const res = await this.get("/public/ok.txt");
    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("Allowed");
  });

  it("handles special characters in filenames beyond accents", async function () {
    const specialChars = "∑ß♪♥☺";
    await this.write({ path: `/${specialChars}.txt`, content: "Special" });
    expect(await this.text(`/${encodeURIComponent(specialChars)}.txt`)).toEqual(
      "Special"
    );
  });

  it("respects case sensitivity in file extensions", async function () {
    await this.write({ path: "/test.JPG", content: "image" });
    const res = await this.get("/test.jpg");
    expect(res.headers.get("content-type")).toContain("image/jpeg");
  });

  it("handles multiple banned routes", async function () {
    const bannedPaths = ["/.git/config", "/.git/HEAD", "/.git/index"];
    for (const path of bannedPaths) {
      await this.write({ path, content: "Sensitive" });
      const res = await this.get(path);
      expect(res.status).toEqual(404);
    }
  });

  it("handles concurrent requests to the same file", async function () {
    await this.write({ path: "/concurrent.txt", content: "Test" });
    const requests = Array(10)
      .fill()
      .map(() => this.get("/concurrent.txt"));
    const responses = await Promise.all(requests);
    responses.forEach((res) => {
      expect(res.status).toEqual(200);
    });
  });

  it("respects query string parameters while ignoring them for file matching", async function () {
    await this.write({ path: "/query.txt", content: "Query test" });
    const body = await this.text("/query.txt?param1=value1&param2=value2");
    expect(body).toEqual("Query test");
  });

  it("handles files with multiple dots correctly", async function () {
    await this.write({ path: "/test.min.js.map", content: "Sourcemap" });
    const res = await this.get("/test.min.js.map");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("handles symbolic links correctly", async function () {
    // This would require setup in the test environment
    await this.write({ path: "/original.txt", content: "Original" });
    await fs.symlink(
      config.blog_folder_dir + "/" + this.blog.id + "/original.txt",
      config.blog_folder_dir + "/" + this.blog.id + "/link.txt"
    );
    expect(await this.text("/link.txt")).toEqual("Original");
  });

  it("processes hidden files correctly", async function () {
    await this.write({ path: "/.hidden.txt", content: "Hidden" });
    const res = await this.get("/.hidden.txt");
    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("Hidden");
  });

  it("handles zero-byte files", async function () {
    await this.write({ path: "/empty.txt", content: "" });
    const res = await this.get("/empty.txt");
    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("");
  });

  it("properly handles files with mixed case extensions", async function () {
    const files = [
      { path: "/test.JSON", expected: "application/json" },
      { path: "/test.Jpg", expected: "image/jpeg" },
      { path: "/test.HTML", expected: "text/html" },
    ];

    for (const file of files) {
      await this.write({ path: file.path, content: "content" });
      const res = await this.get(file.path);
      expect(res.headers.get("content-type")).toContain(file.expected);
    }
  });

  it("handles paths with repeating slashes", async function () {
    await this.write({ path: "/folder/file.txt", content: "Content" });
    const body = await this.text("/folder////file.txt");
    expect(body).toEqual("Content");
  });

  // Alternative test that checks if the content is readable regardless of BOM
  it("serves files with BOM and maintains readability", async function () {
    const contentWithBOM = "\uFEFFHello World";
    await this.write({ path: "/bom.txt", content: contentWithBOM });

    const response = await this.text("/bom.txt");
    // Strip any potential BOM from the response before comparing
    const normalizedResponse = response.replace(/^\uFEFF/, "");
    expect(normalizedResponse).toEqual("Hello World");
  });

  it("handles files with unusual permissions", async function () {
    await this.write({ path: "/readonly.txt", content: "Protected" });
    await fs.chmod(
      config.blog_folder_dir + "/" + this.blog.id + "/readonly.txt",
      0o444
    );
    expect(await this.text("/readonly.txt")).toEqual("Protected");
  });

  it("properly handles index.html variants", async function () {
    const variants = [
      "/folder/index.html",
      "/folder/INDEX.HTML",
      "/folder/InDeX.HtMl",
    ];

    for (const variant of variants) {
      await this.write({ path: variant, content: "Index content" });
      const folderPath = variant.substring(0, variant.lastIndexOf("/") + 1);
      const body = await this.text(folderPath);
      expect(body).toEqual("Index content");
    }
  });

  it("handles files with special MIME types correctly", async function () {
    const specialFiles = [
      { path: "/file.webp", type: "image/webp" },
      { path: "/file.woff2", type: "font/woff2" },
      { path: "/file.ttf", type: "font/ttf" },
      { path: "/file.otf", type: "font/otf" },
      { path: "/file.mp4", type: "video/mp4" },
      { path: "/file.webm", type: "video/webm" },
      { path: "/file.avi", type: "video/x-msvideo" },
    ];

    for (const file of specialFiles) {
      await this.write({ path: file.path, content: "content" });
      const res = await this.get(file.path);
      expect(res.headers.get("content-type")).toContain(file.type);
    }
  });

  it("resolves a relative link to a local file even when the post's URL differs from its folder location", async function () {
    await this.template({ "entry.html": "{{{entry.html}}}" });
    await fs.outputFile(this.blogDirectory + "/Photos/beach.jpg", "fake image data");

    await this.write({
      path: "/Photos/vacation.txt",
      content: [
        "Title: Vacation",
        "Link: /totally/different/url",
        "",
        "[Download](beach.jpg)",
      ].join("\n"),
    });

    // The post's published URL has nothing to do with the folder
    // it lives in, so a naive "resolve relative to the current
    // page" (the old, broken behavior) would 404. The link should
    // resolve against the file's real location instead - the render
    // pipeline then rewrites that into a versioned CDN URL, same as
    // it would for an <img src>.
    const body = await this.text("/totally/different/url");
    expect(body).toContain("/Photos/beach.jpg");

    const hrefMatch = body.match(/href="([^"]+\/Photos\/beach\.jpg)"/);
    expect(hrefMatch).not.toBeNull();

    const res = await this.fetch(hrefMatch[1]);
    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("fake image data");
  });

  it("does not crash on malformed percent-encoding in asset requests", async function () {
    await this.write({ path: "/malformed.txt", content: "Bad" });

    let error;
    let res;

    try {
      res = await this.get("/%E0%A4%A.txt", { redirect: "manual" });
    } catch (err) {
      error = err;
    }

    if (error) throw error;

    expect(res.status).toEqual(400);
  });
});
