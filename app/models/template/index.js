var siteOwner = "SITE";

module.exports = {
  create: require("./create"),
  update: require("./update"),
  getMetadata: require("./getMetadata"),
  setMetadata: require("./setMetadata"),

  getFullView: require("./getFullView"),
  getView: require("./getView"),
  getViewByURL: require("./getViewByURL"),
  getViewsByURLs: require("./getViewsByURLs"),
  setView: require("./setView"),
  dropView: require("./dropView"),
  getPartials: require("./getPartials"),
  getAllViews: require("./getAllViews"),
  getTemplateList: require("./getTemplateList"),

  createShareID: require("./createShareID"),
  dropShareID: require("./dropShareID"),
  getByShareID: require("./getByShareID"),

  drop: require("./drop"),

  makeID: require("./util/makeID"),
  isOwner: require("./isOwner"),
  siteOwner: siteOwner,

  buildFromFolder: require("./buildFromFolder"),
  readFromFolder: require("./readFromFolder"),
  writeToFolder: require("./writeToFolder"),
  removeFromFolder: require("./removeFromFolder"),
  removeEnabledFromAllTemplates: require("./removeEnabledFromAllTemplates"),
  
  package: require("./package"),
  viewModel: require("./viewModel"),
  metadataModel: require("./metadataModel"),
};
