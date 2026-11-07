const key = require("./key");
const client = require("models/client");
const getMetadata = require("./getMetadata");
const getView = require("./getView");
const promiseOnly = require("helper/promiseOnly");
const updateCdnManifest = require("./util/updateCdnManifest");
const cacheID = require("./util/cacheID");

module.exports = promiseOnly(async function dropView(templateID, viewName) {
  const multi = client.multi();

  const metadata = await getMetadata(templateID);
  const view = await getView(templateID, viewName);

  multi.del(key.view(templateID, viewName));
  multi.hDel(key.urlPatterns(templateID), viewName);
  multi.sRem(key.allViews(templateID), viewName);
  multi.hSet(key.metadata(templateID), "cacheID", cacheID.create());

  if (view) {
    multi.del(key.url(templateID, view.url));
    multi.del(key.view(templateID, view.name));
  }

  await multi.exec();
  await cacheID.bumpBlogIfInstalled(metadata.owner, templateID);
  await updateCdnManifest(templateID);

  return "Deleted " + templateID;
});
