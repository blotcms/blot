var eachBlog = require("../each/blog");
var Template = require("models/template");
var Blog = require("models/blog");
var fs = require("fs-extra");
var templateDir = require("path").resolve(__dirname + "/../../app/templates");
var makeSlug = require("helper/makeSlug");
var promisify = require("util").promisify;

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
  .filter((name) => !name.includes("."))
  .map((name) => `node scripts/template/archive ${name}`)
  .join("\n")}`);
    process.exit();
  }

  main(process.argv[2]).then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}

// Runs doThis(user, blog) for each blog, one at a time, and resolves once
// every blog has been done. A rejection stops the run, as an error did before.
function eachBlogAsync(doThis) {
  return new Promise(function (resolve, reject) {
    eachBlog(
      function (user, blog, next) {
        doThis(user, blog).then(() => next(), next);
      },
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

async function main(name) {
  var templateID = "SITE:" + name;
  var setTemplateMetadata = promisify(Template.setMetadata);
  var dropTemplate = promisify(Template.drop);

  if (!fs.existsSync(templateDir + "/" + name))
    console.warn(
      "Warning: could not find existing global template directory at app/templates/" +
        name
    );

  var template = await Template.getMetadata(templateID);

  if (!template)
    throw new Error(
      "There is no template in the database with id: " + templateID
    );

  var total = 0;

  console.log(
    "Checking all blogs to see if any use template",
    name,
    "(" + templateID + "):"
  );

  await eachBlogAsync(async function (user, blog) {
    if (blog.template !== templateID) return;

    var cloneMetadata = await createCloneWithUniqueSlug(blog.id, name, {
      name: name,
      cloneFrom: blog.template,
    });

    // We rename the template to include the case-preserved
    // original name. If we do this initially, there is a strange
    // duplicate template bug for unknown reasons.
    await setTemplateMetadata(cloneMetadata.id, { name: template.name });

    var clonedTemplate = await Template.getMetadata(cloneMetadata.id);

    if (!clonedTemplate) throw new Error("no template");

    await Blog.set(blog.id, { template: cloneMetadata.id });

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
  });

  console.log();

  await dropTemplate("SITE", name);

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
}

// Template slugs must be unique per blog, so retry with a suffixed slug when
// cloning into a namespace that already owns the target slug.
async function createCloneWithUniqueSlug(owner, name, metadata) {
  var createTemplate = promisify(Template.create);
  var baseSlug = makeSlug(name).slice(0, 30);
  var attempt = 1;

  while (true) {
    var suffix = attempt === 1 ? "" : "-" + attempt;
    var trimmedBase =
      attempt === 1 ? baseSlug : baseSlug.slice(0, 30 - suffix.length);
    var attemptSlug = makeSlug((trimmedBase || baseSlug) + suffix).slice(0, 30);
    var attemptMetadata = Object.assign({}, metadata, {
      slug: attemptSlug,
    });
    var attemptName = attemptSlug;

    try {
      return await createTemplate(owner, attemptName, attemptMetadata);
    } catch (err) {
      if (!(err && err.code === "EEXISTS")) throw err;
      attempt += 1;
    }
  }
}

module.exports = main;
