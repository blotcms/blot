var config = require("config");
var Template = require("models/template");
var capitalize = require("helper/capitalize");
var extend = require("helper/extend");
var basename = require("path").basename;
var debug = require("debug")("blot:templates");
var Mustache = require("mustache");
var fs = require("fs-extra");
var Blog = require("models/blog");
var withCallback = require("helper/withCallback");
var _ = require("lodash");
var chokidar = require("chokidar");
var parseTemplate = require("models/template/parseTemplate");
var urlNormalizer = require("helper/urlNormalizer");
var updateCdnManifest = require("models/template/util/updateCdnManifest");
var TEMPLATES_DIRECTORY = require("path").resolve(__dirname + "/source");
var TEMPLATES_OWNER = "SITE";

const client = require("models/client");
const fingerprintFiles = require("helper/fingerprintFiles");
const redisSubscriber = require("helper/redisSubscriber");
const lock = require("helper/lock");

var HIGHLIGHTER_THEMES = require("blog/static/syntax-highlighter");

const fonts = require("blog/static/fonts");

var DEFAULT_FONT = fonts
  .filter((font) => font.name === "System sans-serif")
  .map((font) => {
    font.styles = Mustache.render(font.styles, {
      config: {
        cdn: { origin: config.cdn.origin },
      },
    });
    return font;
  })[0];

var DEFAULT_MONO_FONT = fonts
  .filter((font) => font.name === "System mono")
  .map((font) => {
    font.styles = Mustache.render(font.styles, {
      config: {
        cdn: { origin: config.cdn.origin },
      },
    });
    return font;
  })[0];

// Every process may call this at startup. Template.drop followed by a
// rebuild isn't atomic, so a second process comparing mid-rebuild would see
// missing views and rebuild too. The build pass therefore runs under a Redis
// lock: a process that finds it held waits (retries with backoff, about 95s
// in total) and then runs the pass anyway. By then the holder has finished,
// every template compares unchanged and the pass is a cheap no-op, which
// also guarantees the callback only fires once templates are built. A rebuild
// that changes templates can outlast the wait, so while the lock is still
// held (its holder heartbeats it; a dead holder's lock expires) we keep
// waiting rather than race it. Only if Redis can't take the lock at all do we
// build unlocked: a duplicate build beats none.
const BUILD_LOCK_KEY = "templates:build";
const BUILD_LOCK_OPTIONS = {
  ttl: 60 * 1000,
  heartbeat: 10 * 1000,
  retries: 7,
  onCompromised: function (err) {
    console.error("[templates] build lock compromised:", err.message);
  },
};

// Comparing every template with its stored copy takes seconds of CPU, which
// in development is spent again on each restart and slows the first requests
// after it, though a restart rarely changes a template. So with skipUnchanged,
// a pass leaves a fingerprint of its inputs beside its output in Redis, and the
// next one stops there if they match. Worktree previews share that Redis and
// have their own files, so build() drops the fingerprint: any other write
// (a watcher, a pass without skipUnchanged) must not leave one that describes
// templates which are no longer there.
const BUILD_FINGERPRINT_KEY = "templates:build:fingerprint";
const BUILD_INPUTS = [
  TEMPLATES_DIRECTORY,
  __filename,
  require("path").resolve(__dirname + "/../models/template"),
  require("path").resolve(__dirname + "/../blog/static/fonts/index.json"),
  require("path").resolve(
    __dirname + "/../blog/static/syntax-highlighter/index.json"
  ),
];

async function buildIfChanged(options) {
  let fingerprint;
  let failed = false;

  try {
    fingerprint = await fingerprintFiles(BUILD_INPUTS);

    if ((await client.get(BUILD_FINGERPRINT_KEY)) === fingerprint) {
      debug("Templates unchanged since the last build");
      return;
    }

    await client.del(BUILD_FINGERPRINT_KEY);
  } catch (e) {
    console.error("[templates] build fingerprint unavailable: " + e.message);
    fingerprint = null;
  }

  const onError = () => {
    failed = true;
  };

  let buildError = null;

  try {
    await buildLocked({ ...options, onError });
  } catch (err) {
    buildError = err;
  }

  if (!buildError && !failed && fingerprint) {
    try {
      await client.set(BUILD_FINGERPRINT_KEY, fingerprint);
    } catch (e) {
      console.error("[templates] build fingerprint not saved: " + e.message);
    }
  }

  if (buildError) throw buildError;
}

async function main(options) {
  const run = options.skipUnchanged ? buildIfChanged : buildLocked;

  await run(options);

  if (options.watch) {
    debug("Built all templates.");
    debug("Watching templates directory for changes");
    watch(TEMPLATES_DIRECTORY);

    // Rebuilds templates when we load new states
    // using scripts/state/info.js
    redisSubscriber({
      channel: "templates:rebuild",
      onMessage: function () {
        main({}).catch(function () {});
      },
    });
  }
}

async function buildLocked(options) {
  let held = null;

  while (!held) {
    try {
      held = await lock(BUILD_LOCK_KEY, BUILD_LOCK_OPTIONS);
    } catch (e) {
      if (e.code !== "ELOCKED") {
        console.error(
          "[templates] build lock unavailable, building anyway: " + e.message
        );
        break;
      }
      console.error("[templates] build lock still held, waiting again");
    }
  }

  // buildPass can throw (e.g. an unreadable directory); every outcome must
  // still release the lock before it is reported.
  try {
    await buildPass(options);
  } finally {
    if (held) {
      try {
        await held.release();
      } catch (e) {
        console.error("[templates] build lock release failed:", e.message);
      }
    }
  }
}

async function buildPass(options) {
  await buildAll(TEMPLATES_DIRECTORY, options);
  await checkForExtinctTemplates(TEMPLATES_DIRECTORY);
}

// Builds any templates inside the directory
async function buildAll(directory, options) {
  var dirs = templateDirectories(directory);

  var results = await Promise.all(
    dirs.map(function (dir) {
      return build(dir).then(
        function () {
          return {};
        },
        function (error) {
          return { error };
        }
      );
    })
  );

  results.forEach(function (result, i) {
    if (result.error) {
      if (!options.watch) {
        throw result.error;
      } else {
        console.error("Error building: " + dirs[i]);
        console.error(result.error.stack);
        if (options.onError) options.onError();
      }
    }
  });
}

// Path to a directory containing template files
async function build(directory) {
  debug("..", require("path").basename(directory), directory);

  client.del(BUILD_FINGERPRINT_KEY).catch(function (e) {
    console.error("[templates] build fingerprint not cleared: " + e.message);
  });

  var templatePackage;
  var name, template, description, id;
  var snapshot;

  try {
    templatePackage = fs.readJsonSync(directory + "/package.json");
  } catch (e) {
    templatePackage = {};
    console.warn("     ", "Warning: ENOENT " + directory + "/package.json");
    // package.json is optional
  }

  try {
    id = TEMPLATES_OWNER + ":" + basename(directory);
    name = templatePackage.name || capitalize(basename(directory));
    description = templatePackage.description || "";

    template = {
      description: description,
      // templatePackage can be {} (missing/unreadable/mid-write
      // package.json - see above, deliberately tolerated), so this
      // can't just be templatePackage.locals: that's undefined in
      // exactly that case, and every .locals.* read below would throw.
      locals: templatePackage.locals || {},
    };

    // Set the default font for each template
    if (template.locals.body_font !== undefined) {
      template.locals.body_font = _.merge(
        _.cloneDeep(DEFAULT_FONT),
        template.locals.body_font
      );
    }

    if (template.locals.heading_font !== undefined) {
      template.locals.heading_font = _.merge(
        _.cloneDeep(DEFAULT_FONT),
        template.locals.heading_font
      );
    }

    if (template.locals.font !== undefined) {
      template.locals.font = _.merge(
        _.cloneDeep(DEFAULT_FONT),
        template.locals.font
      );
    }

    if (template.locals.navigation_font !== undefined) {
      template.locals.navigation_font = _.merge(
        _.cloneDeep(DEFAULT_FONT),
        template.locals.navigation_font
      );
    }

    if (template.locals.syntax_highlighter !== undefined) {
      template.locals.syntax_highlighter = {
        ...HIGHLIGHTER_THEMES.find(
          ({ id }) =>
            id ===
            (template.locals.syntax_highlighter.id || "stackoverflow-light")
        ),
      };
    }

    if (template.locals.coding_font !== undefined) {
      template.locals.coding_font = _.merge(
        _.cloneDeep(DEFAULT_MONO_FONT),
        template.locals.coding_font
      );
    }

    if (template.locals.syntax_highlighter_font !== undefined) {
      template.locals.syntax_highlighter_font = _.merge(
        _.cloneDeep(DEFAULT_MONO_FONT),
        template.locals.syntax_highlighter_font
      );
    }

    snapshot = assembleTemplateSnapshot(
      directory,
      templatePackage,
      template.locals
    );
  } catch (e) {
    // A template folder can be caught mid-edit (a save landing between
    // chokidar's change event and a template being fully rewritten, a
    // package.json briefly missing/malformed, etc). That's a build
    // failure for this one template, not a reason to crash the whole
    // process - log it and let the next file change in this folder
    // trigger a fresh, hopefully-complete rebuild.
    e.message = "Failed to build " + basename(directory) + ": " + e.message;
    throw e;
  }

  var storedMetadata;

  try {
    storedMetadata = await Template.getMetadata(id);
  } catch (metadataErr) {
    if (metadataErr.code !== "ENOENT") throw metadataErr;
  }

  var viewsResult;

  try {
    viewsResult = await Template.getAllViews(id);
  } catch (viewsErr) {
    if (viewsErr.code !== "ENOENT") throw viewsErr;
  }

  var storedViews = viewsResult && viewsResult.views;

  var metadataSnapshot = {
    name: name,
    description: description,
    locals: normalizeLocalsForComparison(snapshot.locals, true),
  };

  var storedMetadataSnapshot = storedMetadata
    ? {
        name: storedMetadata.name,
        description: storedMetadata.description,
        locals: normalizeLocalsForComparison(storedMetadata.locals || {}),
      }
    : null;

  var storedViewSnapshot = createStoredViewSnapshot(storedViews);

  var metadataMatches =
    storedMetadataSnapshot &&
    _.isEqual(storedMetadataSnapshot, metadataSnapshot);
  var viewsMatch = _.isEqual(storedViewSnapshot, snapshot.views);

  if (metadataMatches && viewsMatch) {
    debug("..", basename(directory), "unchanged, skipping rebuild.");
    return;
  }

  var developmentForks = await collectDevelopmentForks(
    id,
    storedMetadata,
    storedViews
  );

  // Template.drop's outcome has never been checked here
  try {
    await Template.drop(TEMPLATES_OWNER, basename(directory));
  } catch (e) {}

  await Template.create(TEMPLATES_OWNER, name, template);

  var buildViewsErr = null;

  try {
    await buildViews(id, snapshot.definitions);
  } catch (e) {
    buildViewsErr = e;
  }

  // No blog in production uses a SITE template: Blog.set forks
  // one into the blog's own copy, which doesn't change with it.
  // In development the watcher rebuilds inside a running
  // process, where a preview of this template on any blog
  // caches its views by that blog's cacheID, so every blog's
  // cache is flushed there. Every valid view has already been
  // persisted by buildViews regardless of buildViewsErr, so a
  // broken view elsewhere shouldn't leave views stuck stale.
  if (config.environment === "development") {
    await bumpCacheIDForEveryBlog(id);
  }

  if (buildViewsErr) throw buildViewsErr;
  if (config.environment !== "development") return;

  await refreshDevelopmentForks(id, developmentForks);
}

async function buildViews(id, definitions) {
  var views = Object.keys(definitions || {}).sort();
  var errors = {};

  // One view failing to build (e.g. invalid Mustache) must not prevent
  // every other view from building too - alphabetically-later views
  // would otherwise never get rebuilt after Template.drop() wiped the
  // previous, working set. So we always carry on and collect errors
  // instead, keyed by view name (same shape readFromFolder.js uses for
  // its own metadata.errors), then persist them once every view has had
  // a chance to build.
  for (const name of views) {
    var definition = definitions[name];
    var view = definition.view;
    var path = definition.path;

    try {
      await Template.setView(id, view);
    } catch (err) {
      var errorView = _.cloneDeep(view);
      errorView.content = err.toString();
      // Not waited for, and its outcome has never been checked
      Template.setView(id, errorView).catch(function () {});
      if (path) err.message += " in " + path;
      errors[name] = err.message;
    }
  }

  // Always write errors, even when empty, so a previously-broken
  // view's error is cleared once it's fixed rather than lingering.
  await Template.setMetadata(id, { errors });

  var names = Object.keys(errors);
  if (!names.length) return;

  throw new Error(
    names.length +
      " view" +
      (names.length === 1 ? "" : "s") +
      " failed to build: " +
      names.map((name) => name + ": " + errors[name]).join("; ")
  );
}

// The build expands `syntax_highlighter` to the full theme object, but
// models/template/injectLocals strips these volatile fields before the
// metadata is stored (see SYNTAX_HIGHLIGHTER_PROPS_TO_DELETE). Comparing the
// two representations directly would never match, so every startup would take
// the Template.drop/recreate path and flush the cache for every blog using a
// template that declares a syntax highlighter. Normalise both sides first.
var SYNTAX_HIGHLIGHTER_VOLATILE_PROPS = [
  "background",
  "tags",
  "name",
  "colors",
];

// injectLocals overwrites every `font`/`*_font` local's `styles` with the
// canonical @font-face CSS from blog/static/fonts/index.json, Mustache-rendered
// with the real config.cdn.origin, on every setMetadata write. The on-disk
// source keeps the raw `{{{config.cdn.origin}}}` token or (post the woff2
// migration) omits `styles` entirely, so the two representations never compare
// equal and a template with a non-system font (et-book, source-serif, ...)
// drops/recreates on every startup.
//
// `styles` is fully derived from the font `id`, so on the *disk* snapshot we
// render it from the registry exactly as injectLocals would - making the
// snapshot represent the desired stored state. The *stored* snapshot is left
// as-is. Result: a genuine registry change (e.g. .eot/.ttf -> .woff2) is a
// real diff and triggers exactly one rebuild that refreshes the stored CSS;
// once stored matches the registry, subsequent startups compare equal and
// there is no rebuild loop.
function renderFontStylesFromRegistry(fontStyles) {
  return Mustache.render(fontStyles || "", {
    config: { cdn: { origin: config.cdn.origin } },
  });
}

function normalizeLocalsForComparison(locals, renderFontStyles) {
  var normalized = _.cloneDeep(locals || {});

  if (
    normalized.syntax_highlighter &&
    typeof normalized.syntax_highlighter === "object"
  ) {
    SYNTAX_HIGHLIGHTER_VOLATILE_PROPS.forEach(function (prop) {
      delete normalized.syntax_highlighter[prop];
    });
  }

  if (renderFontStyles) {
    Object.keys(normalized).forEach(function (key) {
      if (key !== "font" && key.indexOf("_font") === -1) return;

      var local = normalized[key];
      if (!local || typeof local !== "object" || !local.id) return;

      var registryFont = fonts.find(function (f) {
        return f.id === local.id;
      });
      if (registryFont)
        local.styles = renderFontStylesFromRegistry(registryFont.styles);
    });
  }

  return normalized;
}

function assembleTemplateSnapshot(directory, templatePackage, locals) {
  var definitions = {};
  var views = {};
  var overrides = templatePackage.views || {};

  fs.readdirSync(directory).forEach(function (entry) {
    var path = directory + "/" + entry;
    var viewFilename = basename(path);

    if (viewFilename === "package.json" || viewFilename.slice(0, 1) === ".")
      return;

    var viewName = viewFilename;

    if (viewName.slice(0, 1) === "_") {
      viewName = viewName.slice(1);
    }

    var viewContent;

    try {
      viewContent = fs.readFileSync(path, "utf-8");
    } catch (err) {
      return;
    }

    var view = {
      name: viewName,
      content: viewContent,
      url: "/" + viewName,
    };

    if (overrides && overrides[view.name]) {
      var newView = _.cloneDeep(overrides[view.name]);
      extend(newView).and(view);
      view = newView;
    }

    if (!view.name) view.name = viewName;
    if (!view.url) view.url = "/" + viewName;
    view.locals = view.locals || {};
    view.partials = view.partials || {};

    definitions[view.name] = {
      path: path,
      view: view,
    };

    views[view.name] = createViewSnapshot(view);
  });

  return {
    definitions: definitions,
    views: views,
    locals: _.cloneDeep(locals || {}),
  };
}

function createViewSnapshot(view) {
  var urlInfo = normalizeUrl(view.url, view.name);
  var parseResult = parseTemplate(view.content || "");
  var partials = _.cloneDeep(view.partials || {});

  extend(partials).and(parseResult.partials || {});

  return {
    content: view.content,
    url: urlInfo.url,
    urlPatterns: urlInfo.urlPatterns,
    partials: partials,
    locals: view.locals || {},
  };
}

function normalizeUrl(url, name) {
  var urls;

  if (_.isArray(url)) {
    urls = url;
  } else if (_.isString(url)) {
    urls = [url];
  } else {
    urls = ["/" + name];
  }

  var normalized = urls.map(urlNormalizer);

  return { url: normalized[0], urlPatterns: normalized };
}

function createStoredViewSnapshot(views) {
  var map = {};
  var list;

  if (!views) return map;

  if (Array.isArray(views)) {
    list = views;
  } else {
    list = Object.keys(views).map(function (key) {
      return views[key];
    });
  }

  list.forEach(function (view) {
    if (!view || !view.name) return;

    map[view.name] = {
      content: view.content,
      url: view.url,
      urlPatterns: view.urlPatterns || (view.url ? [view.url] : []),
      partials: view.partials || {},
      locals: view.locals || {},
    };
  });

  return map;
}

async function checkForExtinctTemplates(directory) {
  var names = fs.readdirSync(directory).map(function (name) {
    return name.toLowerCase();
  });

  debug("Checking for extinct templates...");

  var templates = await Template.getTemplateList("");

  templates = templates.filter(function (template) {
    return template.owner === TEMPLATES_OWNER;
  });

  templates = templates.filter(function (template) {
    return names.indexOf(template.name.toLowerCase()) === -1;
  });

  if (templates.length) {
    debug(
      templates.length +
        " templates no longer exist. Please run these scripts to safely remove them from the database:"
    );
  }

  templates.forEach(function (template) {
    debug("node scripts/template/archive.js", template.id.split(":")[1]);
  });
}

function watch(directory) {
  // Stop the process from exiting automatically
  process.stdin.resume();
  debug("Watching", directory, "for changes...");

  // Builds one directory at a time, in the order the changes arrived
  var queue = Promise.resolve();

  function enqueue(directory) {
    queue = queue.then(async function () {
      console.time("Built " + directory);
      try {
        await build(directory);
      } catch (err) {
        console.error(err.message);
      }
      console.timeEnd("Built " + directory);
    });
  }

  // When chokidar first crawls a directory to watch
  // it fires 'add' events for every file it finds.
  // We watch until its crawled everything 'ready'
  // in order to actually listen to new changes.
  let ready = false;

  chokidar
    .watch(directory, { cwd: directory })
    .on("ready", function () {
      ready = true;
    })
    .on("all", (event, path) => {
      if (!ready) return;

      if (!path) return;

      const subdirectory = path.split("/")[0];

      if (subdirectory[0] === ".") return;

      enqueue(directory + "/" + subdirectory);
    });
}

// Generate list of template names based on the names of
// directories inside $directory (e.g. ['console', ...])
function templateDirectories(directory) {
  return fs
    .readdirSync(directory)
    .filter(function (name) {
      return (
        name[0] !== "." &&
        name !== "_" &&
        name.toLowerCase().indexOf("readme") === -1
      );
    })
    .map(function (name) {
      return directory + "/" + name;
    });
}

async function bumpCacheIDForEveryBlog(templateID) {
  var ids = await Blog.getAllIDs();

  for (const blogID of ids) {
    await Blog.set(blogID, { cacheID: Date.now() });

    debug("..", templateID, "flushed for blog", blogID);
  }
}

var DELETED_PACKAGE_VALUE = { developmentRefreshDeleted: true };

async function collectDevelopmentForks(templateID, baseMetadata, baseViews) {
  if (config.environment !== "development") return [];

  var basePackage = packageConfiguration(baseMetadata, baseViews);
  var ids = await Blog.getAllIDs();
  var forks = [];

  for (const blogID of ids) {
    var blog = await Blog.get({ id: blogID });
    var templates = await Template.getTemplateList(blogID);

    var fork = templates.find(function (template) {
      return (
        template.cloneFrom === templateID &&
        template.owner === blogID &&
        template.name.toLowerCase() === templateID.split(":")[1].toLowerCase()
      );
    });

    if (!fork) continue;

    var result = await Template.getAllViews(fork.id);
    var views = result.views;

    forks.push({
      blog: blog,
      metadata: fork,
      overlay: packageOverlay(basePackage, packageConfiguration(fork, views)),
    });
  }

  return forks;
}

function packageConfiguration(metadata, views) {
  var result = { locals: authoredLocals(metadata && metadata.locals) };

  Object.keys(views || {}).forEach(function (name) {
    var view = views[name];
    if (!view) return;

    var configuration = {};
    var patterns = view.urlPatterns || (view.url ? [view.url] : []);
    if (patterns.length > 1) configuration.url = _.cloneDeep(patterns);
    else if (view.url && view.url !== "/" + name) configuration.url = view.url;

    if (view.locals && Object.keys(view.locals).length)
      configuration.locals = _.cloneDeep(view.locals);

    var partials = _.cloneDeep(view.partials || {});
    var parsedPartials = parseTemplate(view.content || "").partials || {};
    Object.keys(parsedPartials).forEach(function (partial) {
      if (_.isEqual(partials[partial], parsedPartials[partial]))
        delete partials[partial];
    });
    if (Object.keys(partials).length) configuration.partials = partials;

    if (Object.keys(configuration).length) {
      result.views = result.views || {};
      result.views[name] = configuration;
    }
  });

  return result;
}

function authoredLocals(locals) {
  var result = normalizeLocalsForComparison(locals || {});
  Object.keys(result).forEach(function (key) {
    if (
      (key === "font" || key.indexOf("_font") !== -1) &&
      result[key] &&
      typeof result[key] === "object"
    ) {
      delete result[key].styles;
    }
  });
  return result;
}

function packageOverlay(base, fork) {
  if (_.isEqual(base, fork)) return undefined;

  if (!_.isPlainObject(base) || !_.isPlainObject(fork))
    return _.cloneDeep(fork);

  var overlay = {};
  Object.keys(base).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(fork, key)) {
      overlay[key] = DELETED_PACKAGE_VALUE;
      return;
    }
    var difference = packageOverlay(base[key], fork[key]);
    if (difference !== undefined) overlay[key] = difference;
  });
  Object.keys(fork).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(base, key))
      overlay[key] = _.cloneDeep(fork[key]);
  });
  return Object.keys(overlay).length ? overlay : undefined;
}

function applyPackageOverlay(value, overlay) {
  if (overlay === DELETED_PACKAGE_VALUE) return undefined;
  if (!_.isPlainObject(overlay)) return _.cloneDeep(overlay);

  var result = _.isPlainObject(value) ? _.cloneDeep(value) : {};
  Object.keys(overlay).forEach(function (key) {
    var updated = applyPackageOverlay(result[key], overlay[key]);
    if (updated === undefined) delete result[key];
    else result[key] = updated;
  });
  return result;
}

async function refreshDevelopmentForks(templateID, forks) {
  if (config.environment !== "development") return;

  for (const saved of forks || []) {
    var old = saved.metadata;
    console.log("Refreshing development template fork", old.id);

    await Template.drop(old.owner, old.slug);

    var fresh = await Template.create(old.owner, old.name, {
      slug: old.slug,
      cloneFrom: templateID,
      localEditing: old.localEditing === true,
    });

    await applyForkPackageOverlay(fresh.id, saved.overlay);

    if (saved.blog.template === old.id && fresh.id !== old.id) {
      await Blog.set(old.owner, { template: fresh.id });
    }

    await updateCdnManifest(fresh.id);
    await Blog.set(old.owner, { cacheID: Date.now() });

    if (!old.localEditing) continue;

    await Template.writeToFolder(old.owner, fresh.id);
  }
}

async function applyForkPackageOverlay(templateID, overlay) {
  var result = await Template.getAllViews(templateID);
  var views = result.views;
  var metadata = result.metadata;

  var packageData = applyPackageOverlay(
    packageConfiguration(metadata, views),
    overlay || {}
  );

  await Template.setMetadata(templateID, {
    locals: packageData.locals || {},
  });

  for (const name of Object.keys(views || {})) {
    var configuration = (packageData.views && packageData.views[name]) || {};

    await Template.setView(templateID, {
      name: name,
      url: configuration.url || "/" + name,
      locals: configuration.locals || {},
      partials: configuration.partials || {},
    });
  }
}

module.exports = withCallback(main);

// Last, so every const above is initialised before main() runs
if (require.main === module) {
  // if this script is run directly in the terminal
  // in the development environment without the flag
  // --no-watch, we want to watch the templates directory for changes
  // and rebuild the templates when they change.
  let watch =
    config.environment === "development" &&
    !process.argv.includes("--no-watch");

  console.log("Building templates... watch=" + watch);
  (async function () {
    // A failure is an unhandled rejection, which exits the process
    await main({ watch });
    console.log("Done building templates.");
    if (!watch) process.exit();
  })();
}
