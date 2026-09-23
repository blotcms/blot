const Express = require("express");
const SourceCode = new Express.Router();
const Template = require("models/template");
const formJSON = require("helper/formJSON");
const extend = require("helper/extend");
const async = require("async");
const writeChangeToFolder = require("./save/writeChangeToFolder");
const previewReload = require("helper/publishPreviewReload");

SourceCode.param("viewSlug", require("./load/template-views"));
SourceCode.param("viewSlug", require("./load/template-view"));

SourceCode.use((req, res, next) => {
  res.locals.selected = { ...res.locals.selected, source: "selected" };

  next();
});

SourceCode.route("/")
  .get(require("./load/template-views"))
  .get(function (req, res) {
    if (res.locals.views[0] && res.locals.views[0].name) {
      return res.redirect(
        res.locals.base + "/source-code/" + res.locals.views[0].name + "/edit"
      );
    }

    // set the partial template 'yield' to 'template/source-code/edit'
    res.locals.layout = "dashboard/template/layout";
    res.locals.yield = "dashboard/template/source-code/edit";
    res.render("dashboard/template/source-code/layout");
  });

SourceCode.route("/create")
  .get(require("./load/template-views"))
  .get(function (req, res) {
    res.locals.selected = { ...res.locals.selected, create: "selected" };
    res.render("dashboard/template/source-code/create");
  })
  .post(require("./save/fork-if-needed"), function (req, res, next) {
    const name = req.body.name;

    if (req.params.viewSlug === "package.json") {
      return next(new Error("You cannot name a view package.json"));
    }

    Template.getView(req.template.id, name, function (err, view) {
      // We recieve an error when the view doesn't exist
      // so don't exit in case of error here.
      view = view || {};

      let content = view.content || "";
      let url = view.url;

      // Determine the default URL for a new view:
      // foo.html -> /foo
      // foo.rss  -> /foo.rss
      // .html    -> /.html
      if (!url && name.endsWith(".html") && name.length > ".html".length) {
        url = "/" + name.slice(0, -1 * ".html".length);
      } else if (!url) {
        url = "/" + name;
      }

      Template.setView(req.template.id, { name, url, content }, function (err) {
        if (err) return next(err);
        res.redirect(res.locals.base + "/source-code/" + name + "/edit");
      });
    });
  });

SourceCode.route("/:viewSlug/edit")
  .get(function (req, res) {
    req.view.formAction =
      res.locals.base + "/source-code/" + req.view.name + "/edit";
    res.locals.selected = { ...res.locals.selected, edit: "selected" };

    res.locals.title = `${req.view.name} - ${req.template.displayName}`;

    res.locals.layout = "dashboard/template/layout";
    res.render("dashboard/template/source-code/edit");
  })
  .post(require("./save/fork-if-needed"), function (req, res, next) {
    // Send plain-text errors so the template editor shows a clean message
    // instead of the full HTML error page
    function sendError(err) {
      const status = err.status || err.statusCode || 500;
      res.status(status).send(err.message || "An error occurred");
    }

    var view = formJSON(req.body, Template.viewModel);

    view.name = req.view.name;

    if (req.params.viewSlug === "package.json") {
      let parsed;
      try {
        parsed = JSON.parse(view.content);
      } catch (e) {
        return sendError(e);
      }
      Template.package.save(
        req.template.id,
        parsed,
        function (err, views) {
          if (err) return sendError(err);

          Template.getMetadata(req.template.id, function (err, metadata) {
            if (err) return sendError(err);

            const templateForSync = metadata || req.template;

            async.eachSeries(
              Object.keys(views),
              function (name, next) {
              Template.getView(req.template.id, name, function (err, view) {
                // getView returns an error if the view does not exist
                // We want to be able to create new views using local editing
                // we so ignore this error, and create the view object as needed
                view = view || {};
                view.name = view.name || name;
                for (var i in views[name]) view[i] = views[name][i];

                view.url = view.url || "/" + view.name;

                Template.setView(req.template.id, view, next);
              });
            },
              function (err) {
                if (err) return sendError(err);
                writeChangeToFolder(
                  req.blog,
                  templateForSync,
                  view,
                  function (err) {
                    if (err) return sendError(err);
                    // package.json is metadata, not a view file. Publish after the
                    // locals and any view metadata from it are stored so an
                    // open preview tab reloads.
                    previewReload.publish(req.blog.id);
                    if (res.locals.templateForked) {
                      res.set("X-Template-Forked", "1");
                    }
                    res.send("Saved changes!");
                  }
                );
              }
            );
          });
        }
      );
    } else {
      Template.setView(req.template.id, view, function (err) {
        if (err) return sendError(err);
        writeChangeToFolder(req.blog, req.template, view, function (err) {
          if (err) return sendError(err);
          if (res.locals.templateForked) {
            res.set("X-Template-Forked", "1");
          }
          res.send("Saved changes!");
        });
      });
    }
  });

SourceCode.route("/:viewSlug/configure")
  .get(function (req, res) {
    if (req.params.viewSlug === "package.json") {
      return res.redirect(
        res.locals.base + "/source-code/" + req.view.name + "/edit"
      );
    }

    const allViews =
      (res.locals.getAllViews && res.locals.getAllViews.views) || {};
    const metadata = allViews[req.view.name] || {};

    let urlValue;

    if (Array.isArray(metadata.urlPatterns) && metadata.urlPatterns.length) {
      urlValue =
        metadata.urlPatterns.length === 1
          ? metadata.urlPatterns[0]
          : metadata.urlPatterns;
    }

    if (urlValue === undefined) {
      urlValue = metadata.url || req.view.url || "/" + req.view.name;
    }

    const locals = isPlainObject(metadata.locals) ? metadata.locals : {};
    const partials = isPlainObject(metadata.partials) ? metadata.partials : {};

    const configureData = {
      url: urlValue,
      locals,
      partials,
    };

    req.view.content = JSON.stringify(configureData, null, 2);
    req.view.editorMode = "javascript";
    req.view.formAction =
      res.locals.base + "/source-code/" + req.view.name + "/configure";
    res.locals.selected = { ...res.locals.selected, config: "selected" };

    res.locals.title = `${req.view.name} - ${req.template.displayName}`;
    res.locals.layout = "dashboard/template/layout";
    res.render("dashboard/template/source-code/configure");
  })
  .post(require("./save/fork-if-needed"), function (req, res, next) {
    if (req.params.viewSlug === "package.json") {
      return next(new Error("You cannot configure package.json"));
    }

    if (!req.body || typeof req.body.content !== "string") {
      return next(new Error("Configuration must be a JSON object"));
    }

    let configuration;

    try {
      configuration = JSON.parse(req.body.content);
    } catch (err) {
      return next(err);
    }

    if (!isPlainObject(configuration)) {
      return next(new Error("Configuration must be a JSON object"));
    }

    const updates = { name: req.view.name };
    const allViews =
      (res.locals.getAllViews && res.locals.getAllViews.views) || {};
    const metadata = allViews[req.view.name] || {};
    const fallbackUrl = metadata.url || req.view.url || "/" + req.view.name;

    if (configuration.url === undefined || configuration.url === null) {
      updates.url = fallbackUrl;
    } else if (Array.isArray(configuration.url)) {
      if (!configuration.url.length) {
        return next(new Error("The provided `url` must not be empty"));
      }
      // Validate that all elements are strings (urlNormalizer will throw otherwise)
      const invalidTypeIndex = configuration.url.findIndex(
        (item) => typeof item !== "string"
      );
      if (invalidTypeIndex !== -1) {
        return next(
          new Error(
            `The provided \`url\` array must contain only strings, but found ${typeof configuration.url[invalidTypeIndex]} at index ${invalidTypeIndex}`
          )
        );
      }
      // Validate that all elements are non-empty (empty strings normalize to "" and make views unreachable)
      const emptyIndex = configuration.url.findIndex(
        (item) => !item.trim()
      );
      if (emptyIndex !== -1) {
        return next(
          new Error(
            `The provided \`url\` array must not contain empty or whitespace-only strings, but found empty string at index ${emptyIndex}`
          )
        );
      }
      updates.url = configuration.url;
    } else if (typeof configuration.url === "string") {
      // Treat empty/blank strings as missing to use fallback
      // Empty strings bypass normalization in setView and can make views unreachable
      const trimmedUrl = configuration.url.trim();
      if (!trimmedUrl) {
        updates.url = fallbackUrl;
      } else {
        updates.url = configuration.url;
      }
    } else {
      return next(new Error("The provided `url` must be a string or an array"));
    }

    const localsValue =
      configuration.locals === undefined
        ? metadata.locals || {}
        : configuration.locals;

    if (!isPlainObject(localsValue)) {
      return next(new Error("The provided `locals` must be an object"));
    }

    const partialsValue =
      configuration.partials === undefined
        ? metadata.partials || {}
        : configuration.partials;

    if (!isPlainObject(partialsValue)) {
      return next(new Error("The provided `partials` must be an object"));
    }

    updates.locals = localsValue;
    updates.partials = partialsValue;

    Template.setView(req.template.id, updates, function (err) {
      if (err) return next(err);

      writeChangeToFolder(req.blog, req.template, updates, function (err) {
        if (err) return next(err);

        if (res.locals.templateForked) {
          res.set("X-Template-Forked", "1");
        }

        res.send("Saved changes!");
      });
    });
  });

SourceCode.route("/:viewSlug/rename")
  .get(function (req, res, next) {
    if (req.params.viewSlug === "package.json") {
      return next(new Error("You cannot rename package.json"));
    }

    res.locals.title = `Rename - ${req.view.name} - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, rename: "selected" };
    res.render("dashboard/template/source-code/rename");
  })
  .post(require("./save/fork-if-needed"), function (req, res, next) {
    if (req.params.viewSlug === "package.json") {
      return next(new Error("You cannot rename package.json"));
    }

    var view = formJSON(req.body, Template.viewModel);

    view.locals = view.locals || {};

    extend(view).and(req.view);

    var newName = view.name;
    var oldName = req.params.viewSlug;

    Template.getView(req.template.id, newName, function (err, existingView) {
      if (existingView && !err)
        return next(new Error("A view called " + newName + " already exists"));

      Template.setView(req.template.id, view, function (err) {
        if (err) return next(err);

        Template.dropView(req.template.id, oldName, function (err) {
          if (err) return next(err);

          res.message(
            res.locals.base + "/source-code/" + newName + "/edit",
            "Saved changes!"
          );
        });
      });
    });
  });

SourceCode.route("/:viewSlug/delete")
  .get(function (req, res) {
    res.locals.title = `Delete - ${req.view.name} - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, delete: "selected" };
    res.render("dashboard/template/source-code/delete");
  })
  .post(require("./save/fork-if-needed"), function (req, res, next) {
    Template.dropView(req.template.id, req.view.name, function (err) {
      if (err) return next(err);
      res.redirect(res.locals.base + "/source-code");
    });
  });

module.exports = SourceCode;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
