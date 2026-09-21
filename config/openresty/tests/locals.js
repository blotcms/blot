const mustache = require("mustache");
const fs = require("fs-extra");
const path = require("path");
const config = require("config");
const locals = require("../locals");
const { sync } = require("../../../proxy/build/sync-config");

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

describe("openresty config locals", function () {
  const REQUIRED = { NODE_SERVER_IP: "127.0.0.1", REDIS_IP: "127.0.0.1" };

  // Optional locals set, so the sections they guard are rendered too
  const ALL_OPTIONAL = {
    ...REQUIRED,
    DISABLE_HTTP2: "1",
    OPENRESTY_INSTANCE_PRIVATE_IP: "10.0.0.1",
    LUA_PACKAGE_PATH: "/lua",
  };

  const cdn_ips = ["203.0.113.1"];

  const generators = {
    "bare-metal": {
      locals: (env) => locals.baremetal({ env, config, cdn_ips }),
      directory: () => path.join(__dirname, "../conf"),
    },
    container: {
      locals: (env) => locals.container({ env, config, cdn_ips }),
      // proxy/config is generated from config/openresty/conf plus the
      // container adaptations, which read locals of their own
      directory: () => {
        sync();
        return path.join(__dirname, "../../../proxy/config");
      },
    },
  };

  Object.keys(generators).forEach((name) => {
    [
      ["required env only", REQUIRED],
      ["every optional env set", ALL_OPTIONAL],
    ].forEach(([description, env]) => {
      it(`${name}: every variable the templates read has a value (${description})`, function () {
        const directory = generators[name].directory();
        const partials = readPartials(directory);

        expect(
          unresolved(partials["server.conf"], partials, generators[name].locals(env))
        ).toEqual([]);
      });
    });
  });

  it("requires NODE_SERVER_IP and REDIS_IP", function () {
    expect(() => locals.baremetal({ env: {}, config, cdn_ips })).toThrowError(
      "NODE_SERVER_IP not set"
    );
    expect(() =>
      locals.container({ env: { NODE_SERVER_IP: "x" }, config, cdn_ips })
    ).toThrowError("REDIS_IP not set");
  });
});
