describe("date integration tests", function () {
  const sync = require("sync");
  const blogServer = require("blog");
  const storage = require("storage/folder");
  const Blog = require("models/blog");
  const Template = require("models/template");
  const fetch = require("node-fetch");
  const Express = require("express");
  const config = require("config");

  const resultFormat = "ddd, DD MMM YYYY HH:mm:ss ZZ";

  global.test.blog();
  beforeEach(createTemplate);

  const tests = [
    {
      timeZone: "UTC",
      dateMetadata: "1/2/2012",
      result: "Mon, 02 Jan 2012 00:00:00 +0000",
    },
    {
      timeZone: "Asia/Calcutta",
      dateMetadata: "2020-03-29T19:29:00+0530",
      result: "Sun, 29 Mar 2020 19:29:00 +0530",
    },
    {
      timeZone: "Asia/Calcutta",
      dateMetadata: "2020/03/29 19:29",
      result: "Sun, 29 Mar 2020 19:29:00 +0530",
    },
  ];

  tests.forEach(({ timeZone, dateMetadata, result }) => {
    it(`renders ${dateMetadata} in ${timeZone} timezone`, function (done) {
      const test = this;
      Blog.set(test.blog.id, { timeZone }, function (err) {
        if (err) return done.fail(err);
        createEntryWithDate(test, dateMetadata, function (err) {
          if (err) return done.fail(err);
          checkDateOnBlog(test, function (err, date) {
            if (err) return done.fail(err);
            expect(date).toEqual(result);
            done();
          });
        });
      });
    });
  });

  function createTemplate(done) {
    const test = this;
    const templateName = "example";

    const view = {
      name: "entries.html",
      content: `{{#all_entries}}{{#formatDate}}${resultFormat}{{/formatDate}}{{/all_entries}}`,
    };

    Template.create(test.blog.id, templateName, {}, function (err) {
      if (err) return done(err);
      Template.getTemplateList(test.blog.id, function (err, templates) {
        let templateId = templates.filter(
          ({ name }) => name === templateName
        )[0].id;
        Template.setView(templateId, view, function (err) {
          if (err) return done(err);
          Blog.set(
            test.blog.id,
            { forceSSL: false, template: templateId },
            function (err) {
              if (err) return done(err);
              done();
            }
          );
        });
      });
    });
  }

  function createEntryWithDate(test, date, callback) {
    const path = "/test.txt";
    const contents = `Date: ${date}\n\n# Hello, world\n\nThis is a post.`;
    sync(test.blog.id, function (err, folder, done) {
      if (err) return callback(err);
      storage.write(test.blog.id, path, contents).then(
        function () {
          folder.update(path, function (err) {
            if (err) return callback(err);
            done(null, callback);
          });
        },
        function (err) {
          done(err, callback);
        }
      );
    });
  }

  async function checkDateOnBlog(test, callback) {
    const res = await fetch(test.origin);
    expect(res.status).toEqual(200);
    const body = await res.text();
    callback(null, body.trim());
  }

  // Create a webserver for testing remote files
  beforeEach(function (done) {
    let server;
    const test = this;
    server = Express();
    server.use(function (req, res, next) {
      const _get = req.get;
      req.get = function (arg) {
        if (arg === "host") {
          return `${test.blog.handle}.${config.host}`;
        } else return _get(arg);
      };
      next();
    });
    server.use(blogServer);
    test.origin = "http://localhost:" + 8919;
    test.server = server.listen(8919, done);
  });

  afterEach(function (done) {
    this.server.close(done);
  });
});
