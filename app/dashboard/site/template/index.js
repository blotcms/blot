const Express = require("express");
const TemplateEditor = new Express.Router();
const formJSON = require("helper/formJSON");
const Template = require("models/template");
const Blog = require("models/blog");
const archiver = require("archiver");
const duplicateTemplate = require("./save/duplicate-template");
const persistTemplateUpdate = require("./save/persist-template-update");
const removeTemplateAssetsIfUnreferenced = require("./save/upload-image").removeTemplateAssetsIfUnreferenced;
const loadFavicon = require("./load/favicon");
const syntaxHighlighterPreview = require("./syntax-highlighter-preview");

function loadFaviconForProfileImage(req, res, next) {
  return req.params.key === "profile_image" ? loadFavicon(req, res, next) : next();
}

// /template/default and /template/default/... redirect to the installed template's slug
// so docs can deep link to e.g. /sites/gitt/template/default/links
TemplateEditor.use("/default", (req, res, next) => {
  const slug = res.locals.template?.slug;
  // When the installed template's own slug is literally "default" (the user
  // named a local template "default") there is nothing to disambiguate: fall
  // through to the /:templateSlug route, which loads it directly. Redirecting
  // here would point /template/default at itself and loop until the browser
  // bails with ERR_TOO_MANY_REDIRECTS.
  if (!slug || slug === "default") return next();
  const pathSuffix = req.path || "";
  res.redirect(`${res.locals.base}/template/${slug}${pathSuffix}`);
});

TemplateEditor.param("viewSlug", require("./load/template-views"));

TemplateEditor.param("viewSlug", require("./load/template-view"));

TemplateEditor.param("templateSlug", require("./load/template"));

TemplateEditor.use((req, res, next) => {
  res.locals.layout = "dashboard/template/layout";
  res.locals.dashboardBase = res.locals.base;
  next();
});

// Load templates for the sidebar
TemplateEditor.use(require("./templates"));

TemplateEditor.get("/", (req, res) => {
  res.render("dashboard/template");
});

TemplateEditor.route("/disable")
  .get((req, res) => {
    res.locals.title = "Disable template";
    res.render("dashboard/template/disable");
  })
  .post((req, res, next) => {
    // either disable the current template
    // or enable the current template
  });

TemplateEditor.route("/new")
  .get((req, res) => {
    res.locals.newSelected = "selected";
    res.locals.title = "New template";
    res.render("dashboard/template/new");
  })
  .post((req, res, next) => {
    Template.create(req.blog.id, req.body.name, (err, template) => {
      if (err) return next(err);
      res.redirect(req.baseUrl + "/" + template.slug);
    });
  });

// Creates a template from a dropped folder or zip file. Two path segments, so
// it cannot be captured by the single-segment /:templateSlug route below.
TemplateEditor.post("/new/upload", require("./save/upload-template"));

TemplateEditor.route("/:templateSlug/install")
  .get(function (req, res) {
    res.locals.title = `Install - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, install: "selected" };
    res.render("dashboard/template/install");
  })
  .post(function (req, res, next) {
    var templateID = req.body.template;
    const log = typeof req.log === "function" ? req.log : function () {};

    if (typeof templateID !== "string") {
      const err = new TypeError("Invalid template ID");
      err.status = 400;
      return next(err);
    }

    const ownerPrefix = `${req.blog.id}:`;
    if (
      !templateID.startsWith("SITE:") &&
      !templateID.startsWith(ownerPrefix)
    ) {
      const err = new Error("No permission to install template");
      err.status = 403;
      return next(err);
    }

    var updates = { template: templateID };
    log("Installing template", templateID);
    Blog.set(req.blog.id, updates, function (err) {
      if (err) return next(err);

      log("Installed template", templateID);
      log("Removing enabled from local templates");

      Template.removeEnabledFromAllTemplates(
        req.blog.id,
        function (removeErr) {
          log("Removed enabled from local templates");

          if (removeErr) {
            console.warn(
              "Failed to remove enabled from local templates after install",
              req.blog.id,
              removeErr
            );
          }
          res.redirect(
            "/sites/" + req.blog.handle + "/template/" + req.params.templateSlug
          );
        }
      );
    });
  });

function prepareTemplateUpdate(req, res, next) {
  let body = formJSON(req.body, Template.metadataModel);
  let newLocals = body.locals;
  let newPartials = body.partials;
  let locals = req.template.locals;
  let partials = req.template.partials;

  for (const local in locals) {
    if (typeof locals[local] === "boolean" && newLocals[local] !== undefined)
      newLocals[local] = newLocals[local] === "on";
  }

  for (let key in newLocals) {
    if (typeof locals[key] === "object") {
      for (let prop in newLocals[key]) {
        locals[key][prop] = newLocals[key][prop];
      }
    } else {
      locals[key] = newLocals[key];
    }
  }

  for (let key in newPartials) partials[key] = newPartials[key];

  req.locals = locals;
  req.partials = partials || {};

  next();
}

TemplateEditor.route("/:templateSlug")
  .all(require("./load/font-inputs"))
  .all(require("./load/syntax-highlighter"))
  .all(require("./load/color-inputs"))
  .all(require("./load/presets"))
  .all(require("./load/url-inputs"))
  .all(require("./load/image-inputs"))
  .all(require("./load/favicon"))
  .all(require("./load/index-inputs"))
  .all(require("./load/sort-input"))
  .all(require("./load/navigation-inputs"))
  .all(require("./load/dates"))
  .post(
    require("./save/fork-if-needed"),
    prepareTemplateUpdate,
    require("./save/layout-inputs"),
    persistTemplateUpdate
  )
  .get(function (req, res) {
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.render("dashboard/template/settings");
  });

TemplateEditor.route("/:templateSlug/uploads/:key")
  .get(require("./load/url-inputs"), function (req, res, next) {
    res.locals.upload = res.locals.uploads.find((i) => i.key === req.params.key);
    if (!res.locals.upload) return next();
    res.locals.title = `${res.locals.upload.label} - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.render("dashboard/template/controls/upload-form");
  })
  .post(require("./save/fork-if-needed"), require("./save/upload-local"));

TemplateEditor.route("/:templateSlug/images/:key")
  .get(require("./load/image-inputs"), loadFaviconForProfileImage, function (req, res, next) {
    res.locals.image = res.locals.images.find((item) => item.key === req.params.key);
    if (!res.locals.image) return next();
    res.locals.image.isProfileImage = res.locals.image.key === "profile_image";
    res.locals.title = `${res.locals.image.label} - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.render("dashboard/template/controls/image-form");
  })
  .post(
    require("./load/image-inputs"),
    loadFaviconForProfileImage,
    require("./save/preflight-image"),
    require("./save/fork-if-needed"),
    require("./save/upload-image")
  );

TemplateEditor.route("/:templateSlug/favicon")
  .get(require("./load/favicon"), function (req, res) {
    res.locals.title = `Favicon - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.render("dashboard/template/controls/favicon-form");
  })
  .post(require("./save/fork-if-needed"), require("./save/upload-favicon"));

// Catch-all for /uploads/ without a key - redirect to template settings
// This must come AFTER the specific route above
TemplateEditor.get("/:templateSlug/uploads", function (req, res) {
  res.redirect(res.locals.base || `${req.baseUrl}/${req.params.templateSlug}`);
});

TemplateEditor.route("/:templateSlug/syntax-highlighter")
  .all(require("./load/font-inputs"))
  .all(require("./load/syntax-highlighter"))
  .post(
    require("./save/fork-if-needed"),
    prepareTemplateUpdate,
    require("./save/layout-inputs"),
    persistTemplateUpdate
  )
  .get(function (req, res) {
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.locals.title = `Syntax highlighter - ${req.template.displayName}`;
    res.locals.syntaxHighlighterPreview = syntaxHighlighterPreview;
    res.render("dashboard/template/syntax-highlighter");
  });

TemplateEditor.route("/:templateSlug/local-editing")
  .get(require("./load/template-views"), function (req, res) {
    res.locals.enabled = req.template.localEditing;
    res.locals.selected = {
      ...res.locals.selected,
      source: "selected",
      local_editing: "selected",
    };
    res.locals.title = `Local editing - ${req.template.displayName}`;
    res.render("dashboard/template/source-code/local-editing");
  })
  .post(require("./save/fork-if-needed"), function (req, res, next) {
    if (req.template.localEditing) {
      Template.removeFromFolder(req.blog.id, req.template.id, function () {
        Template.setMetadata(
          req.template.id,
          { localEditing: false },
          function (err) {
            if (err) return next(err);
            res.message(
              "/sites/" +
                req.blog.handle +
                "/template/" +
                req.template.id.split(":").slice(1).join(":") +
                "/source-code",
              "Moved template from your folder"
            );
          }
        );
      });
    } else {
      Template.setMetadata(
        req.template.id,
        { localEditing: true },
        function (err) {
          if (err) return next(err);

          res.message(
            "/sites/" +
              req.blog.handle +
              "/template/" +
              req.template.id.split(":").slice(1).join(":") +
              "/source-code",
            "Moved template to your folder"
          );

          Template.writeToFolder(req.blog.id, req.template.id, function () {
            // could we do something with this error? Could we wait to render the page?
            // it would be useful to have a progress bar here to prevent
            // busted folder state
            // we should also do something with the error
          });
        }
      );
    }
  });

TemplateEditor.route("/:templateSlug/download-zip").get(function (req, res) {
  // create a zip file of the template on the fly and send it to the user
  // then in a streaming fashion, append the files to the zip file
  // then send the zip file to the user
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${req.template.slug}-template.zip`
  );
  res.setHeader("Content-Type", "application/zip");

  const archive = archiver("zip", {
    zlib: { level: 9 }, // Sets the compression level.
  });

  // Handle errors
  archive.on("error", function (err) {
    res.status(400).send({ error: err.message });
  });

  // Pipe the archive data to the response.
  archive.pipe(res);

  Template.getAllViews(req.template.id, function (err, views, template) {
    if (err || !views || !template)
      return res.status(400).send({ error: err.message });

    // Add the views to the archive
    for (const view in views) {
      archive.append(views[view].content, { name: view });
    }

    const package = Template.package.generate(req.blog.id, template, views);

    // append the template JSON as 'package.json'
    archive.append(package, { name: "package.json" });

    // Finalize the archive
    archive.finalize();
  });
});

TemplateEditor.route("/:templateSlug/duplicate")
  .get(function (req, res) {
    res.locals.title = `Duplicate - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, duplicate: "selected" };
    res.render("dashboard/template/duplicate");
  })
  .post(async (req, res, next) => {
    try {
      const template = await duplicateTemplate({
        owner: req.blog.id,
        template: req.template,
      });

      res.message(
        "/sites/" +
          req.blog.handle +
          "/template/" +
          template.id.split(":").slice(1).join(":"),
        "Duplicated template <b>" + template.name + "</b>"
      );
    } catch (err) {
      next(err);
    }
  });

TemplateEditor.route("/:templateSlug/rename")
  .get(function (req, res) {
    res.locals.title = `Rename - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, rename: "selected" };
    res.render("dashboard/template/rename");
  })
  .post(function (req, res, next) {
    if (req.template.localEditing) {
      return next(
        new Error(
          "You cannot rename a locally edited template — rename its folder instead"
        )
      );
    }

    Template.setMetadata(
      req.template.id,
      { name: req.body.name },
      function (err) {
        if (err) return next(err);
        res.message(res.locals.base, "Renamed template!");
      }
    );
  });

TemplateEditor.route("/:templateSlug/links")
  .get(require("dashboard/site/load/menu"), function (req, res) {
    res.locals.title = `Links - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.render("dashboard/template/links");
  })
  .post(function (req, res, next) {
    res.message(res.locals.base, "Saved links!");
  });

TemplateEditor.route("/:templateSlug/photo")
  .get(require("./load/favicon"), function (req, res) {
    res.locals.title = `Photo - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.locals.photoPath = `${req.baseUrl}/${req.params.templateSlug}/photo`;
    res.render("dashboard/template/photo");
  })
  .post(
    require("./load/favicon"),
    require("./save/photo")
  );

TemplateEditor.route("/:templateSlug/delete")
  .get(function (req, res, next) {
    res.locals.title = `Delete - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, delete: "selected" };
    res.render("dashboard/template/delete");
  })
  .post(function (req, res, next) {
    const idSlug = req.template.id.split(":").slice(1).join(":");
    const imageLocals = Object.values(req.template.locals || {})
      .filter((value) => value && value.url)
      .map((value) => ({
        ...value,
        thumbnails: Object.fromEntries(
          Object.entries(value.thumbnails || {}).map(([name, thumbnail]) => [name, { ...thumbnail }])
        ),
      }));

    Template.removeFromFolder(req.blog.id, req.template.id, function () {
      Template.drop(req.blog.id, idSlug, function (err) {
        if (err) return next(err);

        removeTemplateAssetsIfUnreferenced({ blog: req.blog }, imageLocals)
          .then(() => {
            const currentTemplateIDSlug = req.blog.template
              .split(":")
              .slice(1)
              .join(":");

            res.message(
              res.locals.dashboardBase +
                "/template/" +
                (currentTemplateIDSlug || ""),
              "Deleted template <b>" + req.template.displayName + "</b>"
            );
          })
          .catch(next);
      });
    });
  });

TemplateEditor.route("/:templateSlug/reset")
  .get(function (req, res, next) {
    res.locals.title = `Reset - ${req.template.displayName}`;
    res.locals.selected = { ...res.locals.selected, reset: "selected" };
    res.render("dashboard/template/reset");
  })
  .post(function (req, res, next) {
    const idSlug = req.template.id.split(":").slice(1).join(":");
    const imageLocals = Object.values(req.template.locals || {})
      .filter((value) => value && value.url)
      .map((value) => ({
        ...value,
        thumbnails: Object.fromEntries(
          Object.entries(value.thumbnails || {}).map(([name, thumbnail]) => [name, { ...thumbnail }])
        ),
      }));

    const finishReset = () => {
      removeTemplateAssetsIfUnreferenced({ blog: req.blog }, imageLocals)
        .then(() => {
          res.message(
            res.locals.dashboardBase + "/template/" + idSlug,
            "Reset template <b>" + req.template.displayName + "</b>"
          );
        })
        .catch(next);
    };

    // work out if this template is currently installed on this site
    Template.drop(req.blog.id, idSlug, function (err) {
      if (err) return next(err);
      if (req.blog.template === req.template.id) {
        Blog.set(req.blog.id, { template: "SITE:" + idSlug }, function (err) {
          if (err) return next(err);
          finishReset();
        });
      } else {
        finishReset();
      }
    });
  });

TemplateEditor.use("/:templateSlug/source-code", require("./source-code"));

module.exports = TemplateEditor;
