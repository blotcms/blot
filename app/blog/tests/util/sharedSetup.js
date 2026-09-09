module.exports = function setup(options = {}) {
  const templates = require("templates");
  const blog = require("../../index");
  const cdn = require("../../../cdn");
  const express = require("express");
  const sync = require("sync");
  const config = require("config");

  const blogCount = Math.max(1, Number(options.blogs) || 1);
  const templateBuildTimeoutMs = Number(options.templateBuildTimeoutMs) || 30 * 1000;
  const templateBuildJasmineTimeoutMs =
    Number(options.templateBuildJasmineTimeoutMs) || 35 * 1000;

  if (blogCount === 1) {
    global.test.blog();
  } else {
    global.test.blogs(blogCount);
  }

  const router = express.Router();

  const cdnHost = new URL(config.cdn.origin).host;

  router.use((req, res, next) => {
    const host = req.get("host") || "";

    if (host === cdnHost) {
      return cdn(req, res, next);
    }

    return blog(req, res, next);
  });

  global.test.server(router);

  beforeAll(
    function (done) {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        done.fail(
          new Error(
            `templates({ watch: false }) did not finish within ${templateBuildTimeoutMs}ms`
          )
        );
      }, templateBuildTimeoutMs);

      templates({ watch: false }, (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (err) return done.fail(err);
        done();
      });
    },
    templateBuildJasmineTimeoutMs
  );

  beforeEach(function () {
    if (!this.blog && Array.isArray(this.blogs) && this.blogs.length) {
      this.blog = this.blogs[0];
    }

    const listBlogs = () => {
      if (Array.isArray(this.blogs) && this.blogs.length) {
        return this.blogs;
      }

      if (this.blog) {
        return [this.blog];
      }

      return [];
    };

    const resolveBlog = (blogOrIndex) => {
      if (typeof blogOrIndex === "number") {
        return listBlogs()[blogOrIndex];
      }

      if (blogOrIndex) {
        return blogOrIndex;
      }

      return this.blog;
    };

    const resolveURL = (pathOrUrl, base) => new URL(pathOrUrl, base).toString();

    this.blogOrigin = (blogOrIndex) => {
      const selectedBlog = resolveBlog(blogOrIndex);

      if (!selectedBlog) {
        throw new Error("No blog found for request");
      }

      return `${config.protocol}${selectedBlog.handle}.${config.host}`;
    };

    this.getForBlog = (blogOrIndex, path, options = {}) =>
      this.fetch(resolveURL(path, this.blogOrigin(blogOrIndex)), options);

    this.get = (path, options = {}) => this.getForBlog(this.blog, path, options);

    this.textForBlog = async (blogOrIndex, path, options = {}) => {
      const res = await this.getForBlog(blogOrIndex, path, options);

      if (res.status !== 200) {
        throw new Error(`Failed to fetch ${path}: ${res.status}`);
      }

      return res.text();
    };

    this.text = async (path, options = {}) => this.textForBlog(this.blog, path, options);

    this.cdnText = (path, options = {}) =>
      this.text(resolveURL(path, config.cdn.origin), options);

    this.getWithRawPath = (path) => {
      const url = new URL(this.origin);
      const http = require("http");
      const parsedOrigin = new URL(this.blogOrigin(this.blog));

      return new Promise((resolve, reject) => {
        const opts = {
          hostname: url.hostname,
          port: url.port || 80,
          path,
          method: "GET",
          headers: {
            "x-forwarded-host": parsedOrigin.host,
            "x-forwarded-proto": parsedOrigin.protocol.replace(":", ""),
            "X-Forwarded-Proto": parsedOrigin.protocol.replace(":", ""),
          },
        };

        const req = http.request(opts, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: () => Promise.resolve(body),
            })
          );
        });

        req.on("error", reject);
        req.end();
      });
    };

    this.remove = (path) => {
      return new Promise((resolve, reject) => {
        sync(this.blog.id, async (err, folder, callback) => {
          if (err) return callback(err, reject);

          await this.blog.remove(path);

          folder.update(path, function (folderErr) {
            if (folderErr) return callback(folderErr, reject);
            callback(null, resolve);
          });
        });
      });
    };

    this.write = ({ path, content }) => {
      return new Promise((resolve, reject) => {
        sync(this.blog.id, async (err, folder, callback) => {
          if (err) return callback(err, reject);

          await this.blog.write({ path, content });

          folder.update(path, function (folderErr) {
            if (folderErr) return callback(folderErr, reject);
            callback(null, resolve);
          });
        });
      });
    };

    this.template = (views = {}, packageJSON = {}) => {
      return new Promise((resolve, reject) => {
        sync(this.blog.id, async (err, folder, callback) => {
          if (err) return callback(err, reject);

          await this.blog.remove("/Templates/local");

          await this.blog.write({
            path: "/Templates/local/package.json",
            content: JSON.stringify({
              name: "local",
              locals: {},
              views: {},
              enabled: true,
              ...packageJSON,
            }),
          });

          for (const viewPath in views) {
            await this.blog.write({
              path: `/Templates/local/${viewPath}`,
              content: views[viewPath],
            });
          }

          folder.update("/Templates/local", function (folderErr) {
            if (folderErr) return callback(folderErr, reject);
            callback(null, resolve);
          });
        });
      });
    };

    this.stream = async function ({
      path,
      onStreamReady,
      expectedText,
      timeout = 4000,
    }) {
      const controller = new AbortController();
      const signal = controller.signal;

      const timer = setTimeout(() => {
        controller.abort();
        throw new Error(`Stream timed out after ${timeout}ms`);
      }, timeout);

      try {
        const res = await this.get(path, { signal });
        const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();

        if (!reader) {
          throw new Error("Failed to get reader from response body");
        }

        if (typeof onStreamReady === "function") {
          await onStreamReady();
        }

        while (true) {
          const { value, done } = await reader.read();

          if (done) break;

          if (value && value.includes(expectedText)) {
            await reader.cancel();
            controller.abort();
            clearTimeout(timer);
            return value;
          }
        }

        throw new Error(`Expected text "${expectedText}" not found in stream`);
      } finally {
        clearTimeout(timer);
      }
    };
  });
};
