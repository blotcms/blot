const renderLocals = require("../locals");

describe("renderLocals", function () {
  let req, res;

  beforeEach(function () {
    req = {};
  });

  it("renders template tags in string locals against the full locals object", function () {
    res = {
      locals: {
        name: "World",
        title: "Hello {{name}}",
        partials: {},
      },
    };

    renderLocals(req, res);

    expect(res.locals.title).toEqual("Hello World");
  });

  it("leaves strings without template tags unchanged", function () {
    res = { locals: { description: "Plain text", partials: {} } };

    renderLocals(req, res);

    expect(res.locals.description).toEqual("Plain text");
  });

  it("leaves non-string locals untouched", function () {
    res = { locals: { count: 123, enabled: true, partials: {} } };

    renderLocals(req, res);

    expect(res.locals.count).toEqual(123);
    expect(res.locals.enabled).toEqual(true);
  });

  it("recurses into nested objects", function () {
    res = {
      locals: {
        entry: { title: "{{greeting}}, entry!" },
        greeting: "Hi",
        partials: {},
      },
    };

    renderLocals(req, res);

    expect(res.locals.entry.title).toEqual("Hi, entry!");
  });

  it("recurses into arrays", function () {
    res = {
      locals: {
        name: "World",
        items: ["Hello {{name}}", "plain"],
        partials: {},
      },
    };

    renderLocals(req, res);

    expect(res.locals.items[0]).toEqual("Hello World");
    expect(res.locals.items[1]).toEqual("plain");
  });

  it("does not render tags inside the partials object", function () {
    res = {
      locals: {
        name: "World",
        partials: { sub: "Hello {{name}}" },
      },
    };

    renderLocals(req, res);

    expect(res.locals.partials.sub).toEqual("Hello {{name}}");
  });

  it("leaves a local unchanged when rendering it throws", function () {
    res = {
      // An unclosed tag makes the underlying mustache renderer throw.
      locals: { title: "Hello {{> missing}", partials: {} },
    };

    renderLocals(req, res);

    expect(res.locals.title).toEqual("Hello {{> missing}");
  });

  it("does not throw when a circular local causes traversal to fail", function () {
    const circular = {};
    circular.self = circular;

    res = { locals: { circular: circular, partials: {} } };

    expect(function () {
      renderLocals(req, res);
    }).not.toThrow();
  });

  it("throws when res.locals.partials is missing", function () {
    res = { locals: { title: "Hello" } };

    expect(function () {
      renderLocals(req, res);
    }).toThrowError();
  });
});
