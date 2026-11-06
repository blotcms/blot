const Template = require("models/template");

const createTemplate = (template) => {
  return new Promise((resolve, reject) => {
    Template.create(
      template.owner,
      template.name,
      template,
      function (error, newTemplate) {
        if (error) {
          reject(error);
        } else {
          resolve(newTemplate);
        }
      }
    );
  });
};

module.exports = createTemplate;
