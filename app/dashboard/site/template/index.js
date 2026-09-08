const Express = require("express");
const TemplateEditor = new Express.Router();
const formJSON = require("helper/formJSON");
const Template = require("models/template");
const Blog = require("models/blog");
const archiver = require("archiver");
const duplicateTemplate = require("./save/duplicate-template");
const { isAjaxRequest, sendAjaxResponse } = require("./save/ajax-response");
const writeChangeToFolder = require('./save/writeChangeToFolder');

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
    res.locals.title = `Install - ${req.template.name}`;
    res.locals.selected = { ...res.locals.selected, install: "selected" };
    res.render("dashboard/template/install");
  })
  .post(function (req, res, next) {
    var templateID = req.body.template;
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
    Blog.set(req.blog.id, updates, function (err) {
      if (err) return next(err);

      Template.removeEnabledFromAllTemplates(
        req.blog.id,
        function (removeErr) {
          if (removeErr) {
            console.warn(
              "Failed to remove enabled from local templates after install",
              req.blog.id,
              removeErr
            );
          }
          res.message(
            "/sites/" + req.blog.handle + "/template/" + req.params.templateSlug,
            "Installed template"
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

function persistTemplateUpdate(req, res, next) {
  Template.update(
    req.blog.id,
    req.params.templateSlug,
    { locals: req.locals, partials: req.partials },
    function (err) {
      if (err) return next(err);
      writeChangeToFolder(req.blog, req.template, {}, function (err) {
        if (err) return next(err);

        if (isAjaxRequest(req)) {
          const ajaxOptions = {};
          if (res.locals.templateForked) {
            ajaxOptions.headers = { "X-Template-Forked": "1" };
          }
          return sendAjaxResponse(res, ajaxOptions);
        }

        res.message(req.baseUrl + req.url, "Success!");
      });
    },
  );
}

TemplateEditor.route("/:templateSlug")
  .all(require("./load/font-inputs"))
  .all(require("./load/syntax-highlighter"))
  .all(require("./load/color-inputs"))
  .all(require("./load/url-inputs"))
  .all(require("./load/index-inputs"))
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
    res.locals.title = `${res.locals.upload.label} - ${req.template.name}`;
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.render("dashboard/template/controls/upload-form");
  })
  .post(require("./save/fork-if-needed"), require("./save/upload-local"));

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
    res.locals.title = `Syntax highlighter - ${req.template.name}`;
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
    res.locals.title = `Local editing - ${req.template.name}`;
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
    res.locals.title = `Duplicate - ${req.template.name}`;
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
    res.locals.title = `Rename - ${req.template.name}`;
    res.locals.selected = { ...res.locals.selected, rename: "selected" };
    res.render("dashboard/template/rename");
  })
  .post(function (req, res, next) {
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
    res.locals.title = `Links - ${req.template.name}`;
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.render("dashboard/template/links");
  })
  .post(function (req, res, next) {
    res.message(res.locals.base, "Saved links!");
  });

TemplateEditor.route("/:templateSlug/photo")
  .get(function (req, res) {
    res.locals.title = `Photo - ${req.template.name}`;
    res.locals.selected = { ...res.locals.selected, settings: "selected" };
    res.render("dashboard/template/photo");
  })
  .post(function (req, res, next) {
    res.message(res.locals.base, "Saved photo!");
  });

TemplateEditor.route("/:templateSlug/delete")
  .get(function (req, res, next) {
    res.locals.title = `Delete - ${req.template.name}`;
    res.locals.selected = { ...res.locals.selected, delete: "selected" };
    res.render("dashboard/template/delete");
  })
  .post(function (req, res, next) {
    const idSlug = req.template.id.split(":").slice(1).join(":");
    Template.removeFromFolder(req.blog.id, req.template.id, function () {
      Template.drop(req.blog.id, idSlug, function (err) {
        if (err) return next(err);

        const currentTemplateIDSlug = req.blog.template
          .split(":")
          .slice(1)
          .join(":");

        res.message(
          res.locals.dashboardBase +
            "/template/" +
            (currentTemplateIDSlug || ""),
          "Deleted template <b>" + req.template.name + "</b>"
        );
      });
    });
  });

TemplateEditor.route("/:templateSlug/reset")
  .get(function (req, res, next) {
    res.locals.title = `Reset - ${req.template.name}`;
    res.locals.selected = { ...res.locals.selected, reset: "selected" };
    res.render("dashboard/template/reset");
  })
  .post(function (req, res, next) {
    const idSlug = req.template.id.split(":").slice(1).join(":");
    // work out if this template is currently installed on this site
    Template.drop(req.blog.id, idSlug, function (err) {
      if (err) return next(err);
      if (req.blog.template === req.template.id) {
        Blog.set(req.blog.id, { template: "SITE:" + idSlug }, function (err) {
          if (err) return next(err);
          res.message(
            res.locals.dashboardBase + "/template/" + idSlug,
            "Reset template <b>" + req.template.name + "</b>"
          );
        });
      } else {
        res.message(
          res.locals.dashboardBase + "/template/" + idSlug,
          "Reset template <b>" + req.template.name + "</b>"
        );
      }
    });
  });

TemplateEditor.use("/:templateSlug/source-code", require("./source-code"));

module.exports = TemplateEditor;
