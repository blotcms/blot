describe("template", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var getPartials = require("../index").getPartials;
  var setView = require("../index").setView;

  it("gets a partials for a view", async function () {
    var test = this;
    var partials = {};

    partials[test.view.name] = "";

    var { allPartials } = await getPartials(
      test.blog.id,
      test.template.id,
      partials
    );
    expect(allPartials[test.view.name]).toEqual(test.view.content);
  });

  // If you have a template view 'header.html' which embeds
  // the partial view 'nav.html', when you get the partials
  // for header.html, you should recieve nav.html too.
  it("retrieves partial used in a partial", async function () {
    var test = this;

    // We create a second view which embeds the view
    // already created for this spec. When we call
    // Template.getPartials for the second view, we
    // expect to receive both the second view's contents
    // and the contents of the view already created.
    var parentView = {
      name: "parent.html",
      content: "{{> " + test.view.name + "}}",
    };

    var partials = {};

    partials[parentView.name] = "";

    await setView(test.template.id, parentView);
    var { allPartials } = await getPartials(
      test.blog.id,
      test.template.id,
      partials
    );
    expect(allPartials[test.view.name]).toEqual(test.view.content);
    expect(allPartials[parentView.name]).toEqual(parentView.content);
  });

  it("merges projected allEntries fields from nested partials", async function () {
    var test = this;

    var itemTitle = {
      name: "item-title.html",
      content: "{{#allEntries}}{{title}}{{/allEntries}}",
    };

    var itemURL = {
      name: "item-url.html",
      content: "{{#allEntries}}{{url}}{{/allEntries}}",
    };

    var parentView = {
      name: "parent-merged.html",
      content: "{{> " + itemTitle.name + "}}{{> " + itemURL.name + "}}",
    };

    await setView(test.template.id, itemTitle);
    await setView(test.template.id, itemURL);
    await setView(test.template.id, parentView);

    var partials = {};
    partials[parentView.name] = "";

    var { retrieve } = await getPartials(
      test.blog.id,
      test.template.id,
      partials
    );
    expect(retrieve).toEqual({
      allEntries: { fields: { title: true, url: true } },
    });
  });

  it("projects fields from a partial used inside tagged.entries", async function () {
    var test = this;

    var itemTitle = {
      name: "tagged-item-title.html",
      content: "{{title}}",
    };

    var parentView = {
      name: "tagged-parent.html",
      content:
        "{{#tagged.entries}}{{> " + itemTitle.name + "}}{{/tagged.entries}}",
    };

    await setView(test.template.id, itemTitle);
    await setView(test.template.id, parentView);

    var partials = {};
    partials[parentView.name] = "";

    var { retrieve } = await getPartials(
      test.blog.id,
      test.template.id,
      partials
    );
    expect(retrieve).toEqual({
      tagged: { fields: { title: true } },
    });
  });

  it("does not attribute a partial in an explicit dotted section to the root list", async function () {
    var test = this;

    var item = {
      name: "dotted-item.html",
      content: "{{{html}}}",
    };

    // {{#author.posts}} iterates author's `posts`, not the root posts local.
    var parentView = {
      name: "dotted-parent.html",
      content: "{{#author.posts}}{{> " + item.name + "}}{{/author.posts}}",
    };

    await setView(test.template.id, item);
    await setView(test.template.id, parentView);

    var partials = {};
    partials[parentView.name] = "";

    var { retrieve } = await getPartials(
      test.blog.id,
      test.template.id,
      partials
    );
    expect(retrieve.posts).toBeUndefined();
  });

  it("keeps a partial's stored dependency when it is used inside a section", async function () {
    var test = this;

    // `item` is used inside {{#posts}}, so it inherits the posts context.
    // Its explicit retrieve.latestEntry (a real retrieve local) must still
    // reach the merged retrieve even though the contextual parse never sees it.
    var item = {
      name: "dep-item.html",
      content: "{{title}}",
      retrieve: { latestEntry: true },
    };

    var parentView = {
      name: "dep-parent.html",
      content: "{{#posts}}{{> " + item.name + "}}{{/posts}}",
    };

    await setView(test.template.id, item);
    await setView(test.template.id, parentView);

    var partials = {};
    partials[parentView.name] = "";

    var { retrieve } = await getPartials(
      test.blog.id,
      test.template.id,
      partials
    );
    expect(retrieve.latestEntry).toBe(true);
    expect(retrieve.posts).toEqual({ fields: { title: true } });
  });

  it("resolves file-backed partial paths case-insensitively", async function () {
    await this.set("/Pages/Home.txt", "Hello from home");

    const { allPartials } = await getPartials(this.blog.id, this.template.id, {
      "/pages/home.txt": null,
    });

    expect(allPartials["/pages/home.txt"]).toContain("Hello from home");
    expect(allPartials["/Pages/Home.txt"]).toBeUndefined();
  });

  it("rejects when its arguments are invalid", async function () {
    await expectAsync(
      getPartials(this.blog.id, this.template.id, "nope")
    ).toBeRejected();
  });
});
