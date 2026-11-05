
describe("template", function () {
  const { promisify } = require("util");

  const writeToFolder =  promisify(require("../index").writeToFolder);
  const removeFromFolder =  promisify(require("../index").removeFromFolder);
  const setView =  promisify(require("../index").setView);
  const setMetadata =  promisify(require("../index").setMetadata);

  const folder = require('storage/folder');

  require("./setup")({ createTemplate: true });

  it("removes a template from a folder", async function () {
    var test = this;
    var view = {
      name: "index.html",
      content: "<h1>Title</h1>",
    };

    await setView(this.template.id, view);
    await setMetadata(this.template.id, {localEditing: true});

    await writeToFolder(test.blog.id, test.template.id);
        
    const names = async (path) =>
      (await folder.listNames(test.blog.id, path)).map((entry) => entry.name);

    const templateFolderContents = await names('/Templates');
    const templateSubFolderContents = await names('/Templates/' + test.template.slug);

    expect(templateFolderContents).toContain(test.template.slug);
    expect(templateSubFolderContents).toContain(view.name);
    expect(templateSubFolderContents).toContain('package.json');

    await removeFromFolder(test.blog.id, test.template.id);

    const updatedTemplateFolderContents = await names('/Templates');

    expect(updatedTemplateFolderContents).not.toContain(test.template.slug);    
  });

});
