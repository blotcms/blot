const Template = require("models/template");

const createTemplate = async (template) =>
  Template.create(template.owner, template.name, template);

module.exports = createTemplate;
