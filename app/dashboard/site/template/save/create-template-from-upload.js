const async = require("async");
const Template = require("models/template");
const client = require("models/client");
const key = require("models/template/key");
const urlNormalizer = require("helper/urlNormalizer");
const createTemplateWithUniqueName = require("./create-template-with-unique-name");

// Creates a template from the output of parse-uploaded-template.
//
// There is no atomic 'import these views' API: creating a template is one
// write and each view is another. We validate everything we can before
// starting, then write the views one at a time, and drop the whole template
// if any of them fails. Sequential rather than setMultipleViews, which fires
// every setView at once and reports only the last error it happened to see.
//
// Some failures cannot be caught in advance: setView checks partial
// dependency cycles against views already in the database, so two views in
// the same upload which reference each other only fail on the second write.
// That is what the rollback is for.

const setView = (templateID, view) =>
  new Promise((resolve, reject) => {
    Template.setView(templateID, view, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

// setView writes the exact-url lookup key before it writes the view itself,
// so a view which failed part way through leaves a mapping behind that
// Template.drop cannot find: drop reads each url from a view hash, and this
// view never got one. Remove the mappings for every view we attempted.
const dropAttemptedViewUrls = async (templateID, views) => {
  const urls = views
    .map((view) => (Array.isArray(view.url) ? view.url[0] : view.url))
    .filter((url) => typeof url === "string" && url)
    .map(urlNormalizer);

  await Promise.all(
    urls.map((url) =>
      Promise.resolve(client.del(key.url(templateID, url))).catch((err) => {
        console.error(
          "Failed to remove url mapping while rolling back",
          templateID,
          url,
          err
        );
      })
    )
  );
};

const dropTemplate = (owner, templateID) =>
  new Promise((resolve) => {
    // Template.drop takes the id with the owner prefix removed
    const slug = templateID.split(":").slice(1).join(":");

    Template.drop(owner, slug, (err) => {
      if (err) {
        console.error(
          "Failed to roll back uploaded template",
          templateID,
          err
        );
      }
      resolve();
    });
  });

module.exports = async function createTemplateFromUpload ({
  owner,
  name,
  locals = {},
  views = [],
}) {
  if (!owner) throw new Error("An owner is required to create a template");

  const template = await createTemplateWithUniqueName({
    owner,
    name,
    // No slug: Template.create derives one from the name it settles on, which
    // keeps the stored slug and the id routing resolves by in step even when
    // deduplication has had to trim the name
    locals,
    exhaustedMessage:
      "You already have too many templates with this name — rename it and try again",
  });

  try {
    await new Promise((resolve, reject) => {
      async.eachSeries(
        views,
        function (view, next) {
          setView(template.id, view).then(() => next(), next);
        },
        function (err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  } catch (err) {
    // Urls first, then the template. Dropping the template frees its id, and
    // the id is what stops a second upload of the same name being created —
    // so clearing urls afterwards could delete the mappings of a template
    // someone else had just created in the meantime, leaving their views
    // unreachable. While the id is still taken, only our own keys exist.
    await dropAttemptedViewUrls(template.id, views);
    await dropTemplate(owner, template.id);
    throw err;
  }

  return template;
};
