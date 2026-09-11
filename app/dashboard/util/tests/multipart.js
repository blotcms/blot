const express = require("express");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const fetch = require("node-fetch");
const multipart = require("../multipart");

describe("multipart upload ownership", function () {
  let directory, server, base, handle, options;
  beforeEach(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "blot-upload-test-"));
    options = { uploadDir: directory };
    const app = express();
    app.use((req, res, next) => multipart(options)(req, res, next));
    app.use((req, res) => handle(req, res));
    app.use((err, req, res, next) => res.status(err.status || 400).end());
    server = await new Promise(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async function () {
    await new Promise(resolve => server.close(resolve));
    await fs.remove(directory);
  });
  function send(fields = ["upload"]) {
    const boundary = "blot-test-boundary";
    const body = fields.map(name =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nretained test contents\r\n`
    ).join("") + `--${boundary}--\r\n`;
    return fetch(base, { method: "POST", redirect: "manual",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body });
  }
  async function expectEmpty() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await fs.readdir(directory)).length) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(await fs.readdir(directory)).toEqual([]);
  }
  it("cleans files after a downstream rejection", async function () {
    handle = (req, res) => res.status(403).end();
    expect((await send()).status).toBe(403);
    await expectEmpty();
  });
  it("cleans files after an authentication redirect", async function () {
    handle = (req, res) => res.redirect("/log-in");
    expect((await send()).status).toBe(302);
    await expectEmpty();
  });
  it("preserves other fields when normalizing an avatar and cleans all files", async function () {
    let fields;
    handle = (req, res) => {
      fields = { avatar: !!req.files.avatar.path, other: req.files.other.length };
      res.end();
    };
    await send(["avatar", "other"]);
    expect(fields).toEqual({ avatar: true, other: 1 });
    await expectEmpty();
  });
  it("keeps a background job upload until its explicit release", async function () {
    let upload, release;
    handle = (req, res) => {
      upload = req.files.upload[0];
      release = req.retainUpload(upload);
      res.end();
    };
    await send();
    expect(await fs.readFile(upload.path, "utf8")).toBe("retained test contents");
    await release();
    await release(); // finalizers may safely run more than once
    await expectEmpty();
  });
  it("cleans up on parser size errors", async function () {
    options.maxFilesSize = 5;
    handle = () => fail("A rejected upload must not reach the route");
    expect((await send()).status).toBe(413);
    await expectEmpty();
  });
});
