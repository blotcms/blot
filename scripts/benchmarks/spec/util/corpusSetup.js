"use strict";

/**
 * Lightweight setup for corpusMode "render": wires up the same blog/cdn
 * router and request helpers as sharedSetup (app/blog/tests/util/
 * sharedSetup.js) but, instead of creating fresh users/blogs via
 * global.test.blog()/blogs() (which also unconditionally removes them in
 * afterEach - fine for a throwaway test blog, wrong for a restored corpus we
 * want left alone), it loads existing blogs by ID from a corpus manifest
 * written by build-corpus.js.
 *
 * Only implements the subset of sharedSetup's request helpers the render +
 * burst phases actually use (getForBlog/blogOrigin/text) - build-render.spec
 * never calls this.write/this.remove/this.template in corpusMode "render"
 * since it skips workload generation entirely.
 */
const fs = require("fs");
const path = require("path");
const async = require("async");

module.exports = function setupCorpusRender(manifestPath) {
  const templates = require("templates");
  const blog = require("../../../../app/blog/index");
  const cdn = require("../../../../app/cdn");
  const express = require("express");
  const config = require("config");
  const Blog = require("models/blog");

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

  beforeAll(function (done) {
    const timer = setTimeout(() => {
      done.fail(new Error("templates({ watch: false }) did not finish in time"));
    }, 30 * 1000);

    templates({ watch: false }, (err) => {
      clearTimeout(timer);
      if (err) return done.fail(err);
      done();
    });
  }, 35 * 1000);

  beforeEach(function (done) {
    const resolvedManifestPath = path.resolve(manifestPath);

    if (!fs.existsSync(resolvedManifestPath)) {
      return done.fail(
        new Error(`Corpus manifest not found at ${resolvedManifestPath}`)
      );
    }

    const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
    const context = this;

    async.map(
      manifest.sites,
      function (site, next) {
        Blog.get({ id: site.blogID }, next);
      },
      function (err, blogs) {
        if (err) return done.fail(err);

        context.blogs = blogs;
        context.blog = blogs[0];
        context.corpusManifest = manifest;
        done();
      }
    );
  });

  beforeEach(function () {
    const resolveBlog = (blogOrIndex) => {
      if (typeof blogOrIndex === "number") return this.blogs[blogOrIndex];
      if (blogOrIndex) return blogOrIndex;
      return this.blog;
    };

    const resolveURL = (pathOrUrl, base) => new URL(pathOrUrl, base).toString();

    this.blogOrigin = (blogOrIndex) => {
      const selectedBlog = resolveBlog(blogOrIndex);
      if (!selectedBlog) throw new Error("No blog found for request");
      return `${config.protocol}${selectedBlog.handle}.${config.host}`;
    };

    this.getForBlog = (blogOrIndex, requestPath, options = {}) =>
      this.fetch(resolveURL(requestPath, this.blogOrigin(blogOrIndex)), options);

    this.get = (requestPath, options = {}) =>
      this.getForBlog(this.blog, requestPath, options);

    this.textForBlog = async (blogOrIndex, requestPath, options = {}) => {
      const res = await this.getForBlog(blogOrIndex, requestPath, options);
      if (res.status !== 200) {
        throw new Error(`Failed to fetch ${requestPath}: ${res.status}`);
      }
      return res.text();
    };

    this.text = async (requestPath, options = {}) =>
      this.textForBlog(this.blog, requestPath, options);
  });
};
