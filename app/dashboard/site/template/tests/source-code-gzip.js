describe("template source editor save", function () {
  global.test.blog();

  const express = require("express");
  const cookieParser = require("cookie-parser");
  const http = require("http");
  const zlib = require("zlib");
  const Template = require("models/template");
  const parse = require("dashboard/util/parse");
  const csrf = require("dashboard/util/csrf");
  const SourceCode = require("../source-code");

  const TOKEN = "test-csrf-token";
  const LIMIT = 5 * 1024 * 1024;

  beforeEach(async function () {
    this.template = await Template.create(this.blog.id, "gzip-test");
    await Template.setView(this.template.id, {
      name: "script.js",
      url: "/script.js",
      content: "",
    });

    // Local editing is off, so saving a view doesn't write to the blog folder
    const app = express();
    app.use(cookieParser());
    app.use(parse);
    app.use(csrf);
    app.use("/source-code", (req, res, next) => {
      req.blog = this.blog;
      req.template = this.template;
      res.locals.base = "/sites/test";
      next();
    });
    app.use("/source-code", SourceCode);
    app.use((err, req, res, next) => {
      res.status(err.status || 500).send(err.type || err.message);
    });

    this.server = await new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  });

  afterEach(function () {
    this.server.close();
  });

  function form(content, token = TOKEN) {
    return new URLSearchParams({
      _csrf: token,
      content,
      url: "/script.js",
    }).toString();
  }

  function save(server, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          method: "POST",
          port: server.address().port,
          path: "/source-code/script.js/edit",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Content-Length": Buffer.byteLength(body),
            Cookie: `__Host-csrf=${TOKEN}`,
            ...headers,
          },
        },
        (response) => {
          let data = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode, text: data })
          );
        }
      );
      request.on("error", reject);
      request.end(body);
    });
  }

  async function storedContent(template) {
    return (await Template.getView(template.id, "script.js")).content;
  }

  it("saves an uncompressed body", async function () {
    const res = await save(this.server, form("var a = 1;"));

    expect(res.status).toEqual(200);
    expect(res.text).toEqual("Saved changes!");
    expect(await storedContent(this.template)).toEqual("var a = 1;");
  });

  it("saves a gzipped body", async function () {
    const content = "var a = 1;\n".repeat(20000);
    const body = zlib.gzipSync(form(content));
    const res = await save(this.server, body, { "Content-Encoding": "gzip" });

    expect(res.status).toEqual(200);
    expect(res.text).toEqual("Saved changes!");
    expect(await storedContent(this.template)).toEqual(content);
  });

  it("rejects a gzipped body that inflates past the limit", async function () {
    const body = zlib.gzipSync(form("a".repeat(LIMIT + 1024)));
    expect(body.length).toBeLessThan(LIMIT / 100);

    const res = await save(this.server, body, { "Content-Encoding": "gzip" });

    expect(res.status).toEqual(413);
    expect(await storedContent(this.template)).toEqual("");
  });

  it("still checks the CSRF token inside a gzipped body", async function () {
    const body = zlib.gzipSync(form("var a = 1;", "wrong"));
    const res = await save(this.server, body, { "Content-Encoding": "gzip" });

    expect(res.status).toEqual(403);
    expect(await storedContent(this.template)).toEqual("");
  });
});
