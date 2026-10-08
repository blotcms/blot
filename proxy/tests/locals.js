const mustache = require("mustache");
const fs = require("fs-extra");
const path = require("path");
const config = require("config");
const locals = require("../build/locals");

// Mustache renders a variable it cannot find as an empty string. This walks a
// template the way mustache would render it, with real values, and returns
// every variable or partial it could not find.
function unresolved(template, partials, values) {
  const missing = new Set();
  const parsed = {};
  const parse = (source) => mustache.parse(source);

  const lookup = (name, scopes) => {
    const [first, ...rest] = name.split(".");
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i];
      if (scope === null || scope === undefined) continue;
      if (typeof scope !== "object" || !(first in scope)) continue;
      let value = scope[first];
      for (const key of rest) {
        value = value === null || value === undefined ? undefined : value[key];
      }
      return value;
    }
    return undefined;
  };

  const walk = (tokens, scopes) => {
    for (const token of tokens) {
      const [type, name, , , children] = token;

      if (type === "name" || type === "&" || type === "{") {
        const value = lookup(name, scopes);
        if (value === undefined || value === null || value === "") {
          missing.add(name);
        }
      } else if (type === "#") {
        const value = lookup(name, scopes);
        if (Array.isArray(value)) {
          value.forEach((item) => walk(children, [...scopes, item]));
        } else if (value) {
          walk(children, [...scopes, value]);
        }
      } else if (type === "^") {
        const value = lookup(name, scopes);
        if (!value || (Array.isArray(value) && !value.length)) {
          walk(children, scopes);
        }
      } else if (type === ">") {
        if (!(name in partials)) {
          missing.add(`partial ${name}`);
        } else {
          parsed[name] = parsed[name] || parse(partials[name]);
          walk(parsed[name], scopes);
        }
      }
    }
  };

  walk(parse(template), [values]);

  return Array.from(missing).sort();
}

function readPartials(directory) {
  const partials = {};
  fs.readdirSync(directory)
    .filter((file) => file.endsWith(".conf"))
    .forEach((file) => {
      partials[file] = fs.readFileSync(path.join(directory, file), "utf8");
    });
  return partials;
}

describe("unresolved (the check itself)", function () {
  it("finds a variable which would render empty", function () {
    expect(unresolved("{{a}} {{b}}", {}, { a: 1 })).toEqual(["b"]);
  });

  it("finds a missing partial", function () {
    expect(unresolved("{{> x.conf}}", {}, {})).toEqual(["partial x.conf"]);
  });

  it("only looks inside a section which would be rendered", function () {
    expect(unresolved("{{#a}}{{b}}{{/a}}", {}, {})).toEqual([]);
    expect(unresolved("{{#a}}{{b}}{{/a}}", {}, { a: true })).toEqual(["b"]);
  });

  it("looks inside an inverted section which would be rendered", function () {
    expect(unresolved("{{^a}}{{b}}{{/a}}", {}, {})).toEqual(["b"]);
    expect(unresolved("{{^a}}{{b}}{{/a}}", {}, { a: true })).toEqual([]);
  });

  it("resolves list items, dotted names and partials", function () {
    expect(
      unresolved(
        "{{#l}}{{ip}}{{/l}} {{r.host}} {{> p.conf}}",
        { "p.conf": "{{x}}" },
        { l: [{ ip: 1 }], r: { host: 1 }, x: 1 }
      )
    ).toEqual([]);
  });
});

describe("proxy config locals", function () {
  // Optional locals set, so the sections they guard are rendered too
  const ALL_OPTIONAL = {
    DISABLE_HTTP2: "1",
    OPENRESTY_INSTANCE_PRIVATE_IP: "10.0.0.1",
    LUA_PACKAGE_PATH: "/lua",
  };

  const directory = path.join(__dirname, "../config");

  [
    ["no env at all", {}],
    ["every optional env set", ALL_OPTIONAL],
    ["logging to files", { LOG_TO_STDOUT: "false" }],
    ["without reuseport", { ENABLE_REUSEPORT: "false" }],
  ].forEach(([description, env]) => {
    it(`every variable the templates read has a value (${description})`, function () {
      const partials = readPartials(directory);

      expect(
        unresolved(partials["server.conf"], partials, locals.container({ env, config }))
      ).toEqual([]);
    });
  });

  it("every runtime placeholder has a default", function () {
    const used = new Set();
    const collect = (text) =>
      (text.match(/\$\{PROXY_[A-Z_]+\}/g) || []).forEach((placeholder) =>
        used.add(placeholder.slice(2, -1))
      );

    // some are written into the templates, others come in through the locals
    Object.values(readPartials(directory)).forEach(collect);
    collect(JSON.stringify(locals.container({ env: {}, config })));

    expect(used.size).toBeGreaterThan(0);
    expect(Array.from(used).sort()).toEqual(
      Object.keys(locals.runtimeDefaults({})).sort()
    );
  });

  it("needs no environment: the host-specific values are runtime settings", function () {
    expect(() => locals.container({ env: {}, config })).not.toThrow();
  });
});
