var eachBlog = require("../each/blog");
var Template = require("models/template");
var Blog = require("models/blog");
var fs = require("fs-extra");
var templateDir = require("path").resolve(__dirname + "/../../app/templates");
var makeSlug = require("helper/makeSlug");

// This script is used to archive one of Blot's included templates
// It will create a copy of the template for each blog on which it
// is currently used (preserving the existing blog as-is) and then
// drop the template from the list of available templates for new
// users, or for existing users who were not using the template.

if (require.main === module) {
  if (!process.argv[2]) {
    console.log(`Error: please specify a template name to archive.
  
${fs
  .readdirSync(templateDir + "/latest")
  .filter(name => !name.includes("."))
  .map(name => `node scripts/template/archive ${name}`)
  .join("\n")}`);
    process.exit();
  }

  main(process.argv[2], function (err) {
    if (err) throw err;

    process.exit();
  });
}

function main (name, callback) {
  var templateID = "SITE:" + name;

  if (!fs.existsSync(templateDir + "/" + name))
    console.warn(
      "Warning: could not find existing global template directory at app/templates/" +
        name
    );

  Template.getMetadata(templateID, function (err, template) {
    if (err) return callback(err);

    if (!template)
      return callback(
        new Error("There is no template in the database with id: " + templateID)
      );

    var total = 0;

    console.log(
      "Checking all blogs to see if any use template",
      name,
      "(" + templateID + "):"
    );
    eachBlog(
      function (user, blog, next) {
        if (blog.template !== templateID) return next();

        createCloneWithUniqueSlug(
          blog.id,
          name,
          {
            name: name,
            cloneFrom: blog.template
          },
          function (err, cloneMetadata) {
            if (err) return next(err);

            // We rename the template to include the case-preserved
            // original name. If we do this initially, there is a strange
            // duplicate template bug for unknown reasons.
            Template.setMetadata(
              cloneMetadata.id,
              { name: template.name },
              function (err) {
                if (err) return next(err);

                Template.getMetadata(cloneMetadata.id, function (err, clonedTemplate) {
                  if (err || !clonedTemplate)
                    return next(err || new Error("no template"));

                  Blog.set(
                    blog.id,
                    { template: cloneMetadata.id },
                    function (err) {
                      if (err) return next(err);

                      console.log(
                        blog.id,
                        blog.handle,
                        "used",
                        templateID,
                        "so I created a clone",
                        clonedTemplate.id,
                        "(deduplicated slug:",
                        clonedTemplate.slug,
                        ")",
                        "\nhttp://" + blog.handle + "." + process.env.BLOT_HOST
                      );

                      total++;
                      next();
                    }
                  );
                });
              }
            );
          }
        );
      },
      function (err) {
        if (err) return callback(err);

        console.log();

        Template.drop("SITE", name, function (err) {
          if (err) return callback(err);
          console.log(
            "\nCloned template",
            templateID,
            "for all",
            total,
            "sites currently using it then removed it from the database."
          );
          console.log(
            "You can now safely archive the files in:\napp/templates/" + name
          );
          callback(null);
        });
      }
    );
  });
}

// Template slugs must be unique per blog, so retry with a suffixed slug when
// cloning into a namespace that already owns the target slug.
function createCloneWithUniqueSlug (owner, name, metadata, callback) {
  var baseSlug = makeSlug(name).slice(0, 30);
  var attempt = 1;

  function tryCreate () {
    var suffix = attempt === 1 ? "" : "-" + attempt;
    var trimmedBase = attempt === 1 ? baseSlug : baseSlug.slice(0, 30 - suffix.length);
    var attemptSlug = makeSlug((trimmedBase || baseSlug) + suffix).slice(0, 30);
    var attemptMetadata = Object.assign({}, metadata, {
      slug: attemptSlug
    });
    var attemptName = attemptSlug;

    Template.create(owner, attemptName, attemptMetadata, function (err, meta) {
      if (err && err.code === "EEXISTS") {
        attempt += 1;
        return tryCreate();
      }

      if (err) return callback(err);

      callback(null, meta);
    });
  }

  tryCreate();
}

module.exports = main;
