// The store is meant to be lifted into a project of its own, so nothing in this
// directory may depend on the rest of Blot: it may require its own files, Node
// built-ins, and packages declared in package.json, and nothing else. Anything
// host-specific (configuration, locks, S3 clients) is passed in.
const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const STORE = path.join(__dirname, "..");

function declaredPackages() {
  let dir = STORE;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return new Set();
    dir = parent;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// Everything `source` loads: { specifier } for each require("...") or import,
// and { dynamic: true } for a require of anything which isn't a string
function loads(source) {
  const code = withoutComments(source);
  const found = [];

  for (const m of code.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g)) found.push({ specifier: m[2] });
  for (const m of code.matchAll(/\brequire\(\s*(?!["'])/g)) found.push({ dynamic: true });
  for (const m of code.matchAll(/^\s*import\s[^;]*?from\s*(["'])([^"']+)\1/gm)) found.push({ specifier: m[2] });
  for (const m of code.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g)) found.push({ specifier: m[2] });
  for (const m of code.matchAll(/\bimport\(\s*(?!["'])/g)) found.push({ dynamic: true });

  return found;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// What is wrong with the loads in the file at `file`
function problems(file, source, packages) {
  const out = [];

  for (const load of loads(source)) {
    if (load.dynamic) {
      out.push("loads something it cannot be checked for");
      continue;
    }

    const { specifier } = load;
    if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved !== STORE && !resolved.startsWith(STORE + path.sep)) out.push("requires " + specifier + ", outside the store");
    } else if (specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0])) {
      continue;
    } else if (!packages.has(packageName(specifier))) {
      out.push("requires " + specifier + ", which is neither a built-in nor a declared package");
    }
  }

  return out;
}

describe("git store standalone", function () {
  const packages = declaredPackages();

  it("requires nothing from outside its own directory but built-ins and declared packages", function () {
    // This file holds examples of what is not allowed, so it is not read
    const files = sourceFiles(STORE).filter((file) => file !== __filename);
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const found = problems(file, fs.readFileSync(file, "utf8"), packages);
      expect(found).toEqual([], path.relative(STORE, file));
    }
  });

  describe("the check", function () {
    const here = path.join(STORE, "example.js");
    const check = (source) => problems(here, source, new Set(["@aws-sdk/client-s3"]));

    it("allows built-ins, declared packages and its own files", function () {
      expect(check('const fs = require("fs"); const z = require("node:zlib"); const p = require("fs/promises");')).toEqual([]);
      expect(check('const s3 = require("@aws-sdk/client-s3"); const c = require("@aws-sdk/client-s3/dist");')).toEqual([]);
      expect(check('require("./cache"); require("./objectStore/memory"); require("./errors");')).toEqual([]);
    });

    it("rejects Blot's modules, however they are reached", function () {
      expect(check('require("config")')).toEqual([jasmine.stringMatching(/config/)]);
      expect(check('require("models/blog")')).toEqual([jasmine.stringMatching(/models/)]);
      expect(check('require("helper/clfdate")')).toEqual([jasmine.stringMatching(/helper/)]);
      expect(check('require("../../sync")')).toEqual([jasmine.stringMatching(/outside the store/)]);
      expect(check('require("../../../../config")')).toEqual([jasmine.stringMatching(/outside the store/)]);
    });

    it("rejects packages which aren't declared", function () {
      expect(check('require("left-pad")')).toEqual([jasmine.stringMatching(/left-pad/)]);
    });

    it("rejects a require it can't check, and imports", function () {
      expect(check("require(name)")).toEqual(["loads something it cannot be checked for"]);
      expect(check('import x from "config";')).toEqual([jasmine.stringMatching(/config/)]);
      expect(check('const x = await import("config");')).toEqual([jasmine.stringMatching(/config/)]);
    });

    it("ignores mentions in comments", function () {
      expect(check('// require("config")\n/* require("models/blog") */\nconst a = 1;')).toEqual([]);
    });
  });
});
