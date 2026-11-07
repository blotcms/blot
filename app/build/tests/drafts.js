describe("drafts work", function () {
  const Template = require("models/template");
  const Blog = require("models/blog");
  const sync = require("sync");
  const blogServer = require("../../blog");
  const storageFolder = require("storage/folder");
  const fetch = require("node-fetch");
  const Express = require("express");
  const config = require("config");
  const guid = require("helper/guid");

  global.test.blog();

  it("updates a draft dynamically", function (done) {
    const path = "/drafts/entry.txt";
    const firstContents = guid();
    const secondContents = guid();

    this.writeDraft(path, firstContents, (err) => {
      if (err) return done.fail(err);

      const { Readable } = require("stream");

      fetch(this.origin + "/draft/stream" + path)
        .then((res) => {
          if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
          }
          return new Promise((resolve, reject) => {
            this.writeDraft(path, secondContents, (err) => {
              if (err) {
                reject(err);
              } else {
                resolve(res.body); // assuming writeDraft processes successfully, we pass on the response body stream
              }
            });
          });
        })
        .then((body) => {
          // The response body is a stream. Create a readable stream to consume it.
          const readableStream = new Readable().wrap(body);
          readableStream.on("data", (chunk) => {
            const data = chunk.toString().trim();
            // SSE comment heartbeats keep preview proxies from timing out.
            if (!data || data.startsWith(":")) return;
            expect(data).toContain(secondContents);
            readableStream.destroy();
            if (typeof body.destroy === "function") body.destroy();
            console.log("calling done... HERE!");
            done();
          });
        })
        .catch((err) => {
          done.fail(err);
        });
    });
  });

  beforeEach(async function () {
    const templateName = "example";

    const view = {
      name: "entry.html",
      content: `<html><head></head><body>{{{entry.html}}}</body></html>`,
    };

    await Template.create(this.blog.id, templateName, {});
    const templates = await Template.getTemplateList(this.blog.id);
    let templateId = templates.filter(({ name }) => name === templateName)[0]
      .id;
    await Template.setView(templateId, view);
    await Blog.set(this.blog.id, { forceSSL: false, template: templateId });
  });

  // Create a webserver for testing remote files
  beforeEach(function (done) {
    let server;
    server = Express();
    server.use((req, res, next) => {
      const _get = req.get;
      req.get = (arg) => {
        if (arg === "host") {
          return `${this.blog.handle}.${config.host}`;
        } else return _get(arg);
      };
      next();
    });
    server.use(blogServer);
    this.origin = "http://127.0.0.1:" + 8919;
    this.server = server.listen(8919, done);

    this.writeDraft = (path, contents, callback) => {
      sync(this.blog.id, (err, folder, done) => {
        if (err) return callback(err);
        storageFolder.write(this.blog.id, path, contents).then(() => {
          folder.update(path, function (err) {
            if (err) return callback(err);
            done(null, callback);
          });
        }, callback);
      });
    };
  });

  afterEach(function (done) {
    if (typeof this.server.closeAllConnections === "function") {
      this.server.closeAllConnections();
    }
    this.server.close(done);
  });
});
