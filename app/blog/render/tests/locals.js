var renderLocals = require("../locals");

describe("renderLocals", function () {
  var req, res, callback;

  beforeEach(function () {
    req = {};
    callback = jasmine.createSpy("callback");
  });

  it("renders template tags in string locals against the full locals object", function () {
    res = {
      locals: {
        name: "World",
        title: "Hello {{name}}",
        partials: {},
      },
    };

    renderLocals(req, res, callback);

    expect(res.locals.title).toEqual("Hello World");
    expect(callback).toHaveBeenCalledWith(null, req, res);
  });

  it("leaves strings without template tags unchanged", function () {
    res = { locals: { description: "Plain text", partials: {} } };

    renderLocals(req, res, callback);

    expect(res.locals.description).toEqual("Plain text");
  });

  it("leaves non-string locals untouched", function () {
    res = { locals: { count: 123, enabled: true, partials: {} } };

    renderLocals(req, res, callback);

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

    renderLocals(req, res, callback);

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

    renderLocals(req, res, callback);

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

    renderLocals(req, res, callback);

    expect(res.locals.partials.sub).toEqual("Hello {{name}}");
  });

  it("leaves a local unchanged when rendering it throws", function () {
    res = {
      // An unclosed tag makes the underlying mustache renderer throw.
      locals: { title: "Hello {{> missing}", partials: {} },
    };

    renderLocals(req, res, callback);

    expect(res.locals.title).toEqual("Hello {{> missing}");
    expect(callback).toHaveBeenCalledWith(null, req, res);
  });

  it("still calls back when a circular local causes traversal to fail", function () {
    var circular = {};
    circular.self = circular;

    res = { locals: { circular: circular, partials: {} } };

    expect(function () {
      renderLocals(req, res, callback);
    }).not.toThrow();

    expect(callback).toHaveBeenCalledWith(null, req, res);
  });

  it("throws when res.locals.partials is missing", function () {
    res = { locals: { title: "Hello" } };

    expect(function () {
      renderLocals(req, res, callback);
    }).toThrowError();
  });
});
