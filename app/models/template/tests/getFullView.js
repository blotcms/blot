describe("template", function () {
  require("./setup")({ createTemplate: true });

  var async = require("async");
  var getFullView = require("../index").getFullView;
  var setView = require("../index").setView;

  it("gets a full view", function (done) {
    var test = this;

    var header = {
      name: "header.html",
      content: "<header>Header content</header>",
    };

    var view = {
      name: "page.html",
      locals: { words: "test words" },
      content: "Page content {{> " + header.name + "}}",
    };

    var views = [view, header];

    async.map(views, setView.bind(null, test.template.id), function (err) {
      if (err) return done.fail(err);

      getFullView(test.blog.id, test.template.id, view.name, function (
        err,
        fullView
      ) {
        if (err) return done.fail(err);

        expect(fullView).toEqual(jasmine.any(Array));

        var allPartials = {};
        allPartials[header.name] = header.content;

        expect(fullView[0]).toEqual(view.locals); // view.locals
        expect(fullView[1]).toEqual(allPartials); // allPartials
        expect(fullView[2]).toEqual({}); // view.retrieve
        expect(fullView[3]).toEqual("text/html"); // view.type
        expect(fullView[4]).toEqual(view.content);

        done();
      });
    });
  });


  it("merges projected allEntries fields from view and partials", function (done) {
    var test = this;

    var partial = {
      name: "entry-url.html",
      content: "{{#allEntries}}{{url}}{{/allEntries}}",
    };

    var view = {
      name: "entries.html",
      content: "{{#allEntries}}{{title}}{{/allEntries}}{{> " + partial.name + "}}",
    };

    async.map([view, partial], setView.bind(null, test.template.id), function (err) {
      if (err) return done.fail(err);

      getFullView(test.blog.id, test.template.id, view.name, function (err, fullView) {
        if (err) return done.fail(err);

        expect(fullView[2]).toEqual({
          allEntries: { fields: { title: true, url: true } },
        });

        done();
      });
    });
  });


  it("handles partial usage inside allEntries sections", function (done) {
    var test = this;

    var partial = {
      name: "entry-partial.html",
      content: "{{{html}}}",
    };

    var view = {
      name: "entries-with-partial.html",
      content: "{{#allEntries}}{{> " + partial.name + "}}{{/allEntries}}",
    };

    async.map([view, partial], setView.bind(null, test.template.id), function (err) {
      if (err) return done.fail(err);

      getFullView(test.blog.id, test.template.id, view.name, function (err, fullView) {
        if (err) return done.fail(err);

        expect(fullView[2]).toEqual({
          allEntries: { fields: { html: true } },
        });

        done();
      });
    });
  });


  it("keeps a heavy field a partial renders under a nested entry predicate", function (done) {
    var test = this;

    var partial = {
      name: "entry-thumbnail-partial.html",
      content: "{{{html}}}",
    };

    var view = {
      name: "entries-thumbnail-with-partial.html",
      content:
        "{{#allEntries}}{{#thumbnail}}{{> " +
        partial.name +
        "}}{{/thumbnail}}{{/allEntries}}",
    };

    async.map([view, partial], setView.bind(null, test.template.id), function (err) {
      if (err) return done.fail(err);

      getFullView(test.blog.id, test.template.id, view.name, function (err, fullView) {
        if (err) return done.fail(err);

        // {{{html}}} inside {{#thumbnail}} has no `thumbnail.html`, so Mustache
        // resolves it from the parent entry - projection must keep `html`.
        // `thumbnail` is still recorded, and nothing leaks to the top level.
        expect(fullView[2]).toEqual({
          allEntries: { fields: { thumbnail: true, html: true } },
        });

        done();
      });
    });
  });

  it("projects fields from partials used inside tagged.entries", function (done) {
    var test = this;

    var partial = {
      name: "tagged-entry-partial.html",
      content: "{{title}}",
    };

    var view = {
      name: "tagged-with-partial.html",
      content:
        "{{#tagged.entries}}{{> " + partial.name + "}}{{/tagged.entries}}",
    };

    async.map([view, partial], setView.bind(null, test.template.id), function (err) {
      if (err) return done.fail(err);

      getFullView(test.blog.id, test.template.id, view.name, function (err, fullView) {
        if (err) return done.fail(err);

        expect(fullView[2]).toEqual({
          tagged: { fields: { title: true } },
        });

        done();
      });
    });
  });

  it("keeps a heavy field a nested partial renders in a fresh context", function (done) {
    var test = this;

    // `item` is first used at the root, then reached again through `wrapper`
    // inside {{#allEntries}}. The bundle backstop must still keep `html`.
    var item = { name: "bundle-item.html", content: "{{{html}}}" };
    var wrapper = {
      name: "bundle-wrapper.html",
      content: "{{> " + item.name + "}}",
    };
    var view = {
      name: "bundle-parent.html",
      content:
        "{{> " +
        item.name +
        "}}{{#allEntries}}{{title}}{{> " +
        wrapper.name +
        "}}{{/allEntries}}",
    };

    async.map(
      [item, wrapper, view],
      setView.bind(null, test.template.id),
      function (err) {
        if (err) return done.fail(err);

        getFullView(test.blog.id, test.template.id, view.name, function (
          err,
          fullView
        ) {
          if (err) return done.fail(err);

          expect(fullView[2].allEntries.fields.html).toBe(true);
          expect(fullView[2].allEntries.fields.title).toBe(true);

          done();
        });
      }
    );
  });

  it("keeps a heavy field referenced only from a string local", function (done) {
    var test = this;

    var view = {
      name: "snippet-view.html",
      locals: { snippet: "{{#allEntries}}{{{html}}}{{/allEntries}}" },
      content: "{{#allEntries}}{{title}}{{/allEntries}}{{{snippet}}}",
    };

    setView(test.template.id, view, function (err) {
      if (err) return done.fail(err);

      getFullView(test.blog.id, test.template.id, view.name, function (
        err,
        fullView
      ) {
        if (err) return done.fail(err);

        expect(fullView[2].allEntries.fields.html).toBe(true);
        expect(fullView[2].allEntries.fields.title).toBe(true);

        done();
      });
    });
  });

});
