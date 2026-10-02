describe("notifyAdminIfResyncFoundChanges", function () {
  const modulePath = require.resolve("../notifyResyncFoundChanges");
  const emailPath = require.resolve("helper/email");

  let original;

  beforeEach(function () {
    original = require.cache[emailPath];
  });

  afterEach(function () {
    if (original) {
      require.cache[emailPath] = original;
    } else {
      delete require.cache[emailPath];
    }
    delete require.cache[modulePath];
  });

  function load(sentEmails) {
    require.cache[emailPath] = {
      id: emailPath,
      filename: emailPath,
      loaded: true,
      exports: {
        RESYNC_FOUND_CHANGES: function (uid, locals, callback) {
          sentEmails.push(locals);
          callback();
        },
      },
    };

    delete require.cache[modulePath];
    return require(modulePath);
  }

  const blog = { id: "blogidblogidblogid", handle: "example" };
  const client = {
    display_name: "Dropbox",
    countChanges: function (summary) {
      return (summary && summary.downloaded) || 0;
    },
  };

  it("sends an email when the client counts more than zero changes", function () {
    const sentEmails = [];
    const notify = load(sentEmails);

    notify(blog, client, {
      downloaded: 2,
      removed: 1,
      createdDirs: 0,
      modifiedDuringWalk: 1,
    });

    expect(sentEmails.length).toEqual(1);
    const locals = sentEmails[0];
    expect(locals.id).toEqual(blog.id);
    expect(locals.handle).toEqual(blog.handle);
    expect(locals.truncatedId).toEqual(blog.id.slice(0, 12));
    expect(locals.client).toEqual("Dropbox");
    expect(locals.changeCount).toEqual(2);
    expect(locals.changeCountPlural).toEqual(true);
    expect(locals.downloaded).toEqual(2);
    expect(locals.removed).toEqual(1);
    expect(locals.createdDirs).toEqual(0);
    expect(locals.modifiedDuringWalk).toEqual(1);
  });

  it("does not send an email when the counted changes are zero", function () {
    const sentEmails = [];
    const notify = load(sentEmails);

    notify(blog, client, { downloaded: 0, removed: 0, createdDirs: 0 });

    expect(sentEmails.length).toEqual(0);
  });

  it("does not send an email when the client has no countChanges", function () {
    const sentEmails = [];
    const notify = load(sentEmails);

    notify(blog, { display_name: "iCloud" }, { downloaded: 5 });

    expect(sentEmails.length).toEqual(0);
  });

  it("does not throw when summary is undefined (e.g. a swallowed resync error)", function () {
    const sentEmails = [];
    const notify = load(sentEmails);

    expect(function () {
      notify(blog, client, undefined);
    }).not.toThrow();

    expect(sentEmails.length).toEqual(0);
  });

  it("singularizes the change count message for exactly one change", function () {
    const sentEmails = [];
    const notify = load(sentEmails);

    notify(blog, client, { downloaded: 1 });

    expect(sentEmails[0].changeCount).toEqual(1);
    expect(sentEmails[0].changeCountPlural).toEqual(false);
  });
});
