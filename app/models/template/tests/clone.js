describe("template", function () {
  require("./setup")();

  const getMetadata = require("../getMetadata");
  const { promisify } = require("util");
  const getMetadataAsync = promisify(getMetadata);
  const setView = promisify(require("../setView"));
  const create = promisify(require("../create"));

  it("keeps the favicon local when cloning within the same blog", async function () {
    const favicon = {
      prefix: "favicon-11111111-1111-1111-1111-111111111111",
      ico: "https://cdn.example/" + this.blog.id + "/_template_assets/favicon.ico",
    };
    const source = await create(this.blog.id, "faviconsource", { locals: { favicon } });
    const copy = await create(this.blog.id, "faviconcopy", { cloneFrom: source.id });
    const meta = await getMetadataAsync(copy.id);
    expect(meta.locals.favicon).toEqual(favicon);
  });

  it("generates different CDN hashes for cloned templates", async function () {
    // Create source template with a view that has CDN retrieval
    const sourceTemplateName = "templatename";
    const sourceTemplate = await create(this.blog.id, sourceTemplateName, {});

    // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});

    // Add a view to be retrieved
    const viewName = "style.css";
    const viewContent = "body{color:red}";
    await setView(sourceTemplate.id, {
      name: viewName,
      content: viewContent,
    });

    // Add a view which invokes the CDN function
    await setView(sourceTemplate.id, {
      name: "head.html",
      content: "{{#cdn}}/style.css{{/cdn}}",
    });

    // Get source template metadata with CDN manifest
    const sourceMetadata = await getMetadataAsync(sourceTemplate.id);

    expect(sourceMetadata.cdn).toBeDefined();
    expect(sourceMetadata.cdn[viewName]).toBeDefined();
    const sourceHash = sourceMetadata.cdn[viewName];
    expect(typeof sourceHash).toBe("string");
    expect(sourceHash.length).toBe(32);

    // Clone the template
    const clonedTemplateName = "templatenamecloned";
    const clonedTemplate = await create(this.blog.id, clonedTemplateName, {
      cloneFrom: sourceTemplate.id,
    });

    // Verify cloned template has different ID
    expect(clonedTemplate.id).not.toBe(sourceTemplate.id);
    expect(clonedTemplate.id).toContain(clonedTemplateName);

    // Install the cloned template so the CDN manifest is generated
    await this.blog.update({template: clonedTemplate.id});

    // Get cloned template metadata with CDN manifest
    const clonedMetadata = await getMetadataAsync(clonedTemplate.id);

    expect(clonedMetadata.cdn).toBeDefined();
    expect(clonedMetadata.cdn[viewName]).toBeDefined();
    const clonedHash = clonedMetadata.cdn[viewName];
    expect(typeof clonedHash).toBe("string");
    expect(clonedHash.length).toBe(32);

    // Verify hashes are different (because template IDs are different)
    expect(clonedHash).not.toBe(sourceHash);
  });

  it("cloned template CDN manifest is independent from source", async function () {
    // Create source template
    const sourceTemplateName = "template";
    const sourceTemplate = await create(this.blog.id, sourceTemplateName, {});

    // Add a view to be retrieved
    const viewName = "style.css";
    const viewContent = "body{color:red}";
    await setView(sourceTemplate.id, {
      name: viewName,
      content: viewContent,
    });

    // Add a view which invokes the CDN function
    await setView(sourceTemplate.id, {
      name: "head.html",
      content: "{{#cdn}}/style.css{{/cdn}}",
    });

    // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});

    const sourceMetadataBefore = await getMetadataAsync(sourceTemplate.id);
    const sourceHashBefore = sourceMetadataBefore.cdn[viewName];

    // Clone the template
    const clonedTemplateName = "templatenamecloned";
    const clonedTemplate = await create(this.blog.id, clonedTemplateName, {
      cloneFrom: sourceTemplate.id,
    });

    // Install the template so the CDN manifest is generated
    await this.blog.update({template: clonedTemplate.id});

    // Get cloned template hash
    const clonedMetadata = await getMetadataAsync(clonedTemplate.id);
    const clonedHash = clonedMetadata.cdn[viewName];
    

    // Modify source template content
    const updatedContent = "body { color: blue; }";
    await setView(sourceTemplate.id, {
      name: viewName,
      content: updatedContent,
    });

        // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});
    const sourceMetadataAfter = await getMetadataAsync(sourceTemplate.id);
    const sourceHashAfter = sourceMetadataAfter.cdn[viewName];

    // Verify source template hash changed
    expect(sourceHashAfter).not.toBe(sourceHashBefore);

    // Verify cloned template hash remains unchanged (independent)
    await this.blog.update({template: clonedTemplate.id});
    const clonedMetadataAfter = await getMetadataAsync(clonedTemplate.id);
    const clonedHashAfter = clonedMetadataAfter.cdn[viewName];
    expect(clonedHashAfter).toBe(clonedHash);
  });

  it("clones template with multiple CDN targets and generates different hashes for all", async function () {
    const sourceTemplate = await create(this.blog.id, "templatename", {});

    // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});

    // Add multiple views to be retrieved
    await setView(sourceTemplate.id, {
      name: "style.css",
      content: "body{color:red}",
    });
    await setView(sourceTemplate.id, {
      name: "script.js",
      content: "console.log('test');",
    });

    // Add views that invoke CDN function
    await setView(sourceTemplate.id, {
      name: "head.html",
      content: "{{#cdn}}/style.css{{/cdn}}",
    });
    await setView(sourceTemplate.id, {
      name: "footer.html",
      content: "{{#cdn}}/script.js{{/cdn}}",
    });

    const sourceMetadata = await getMetadataAsync(sourceTemplate.id);
    const sourceHashes = {
      "style.css": sourceMetadata.cdn["style.css"],
      "script.js": sourceMetadata.cdn["script.js"],
    };

    // Clone the template
    const clonedTemplate = await create(this.blog.id, "templatenamecloned", {
      cloneFrom: sourceTemplate.id,
    });

    // Install the template so the CDN manifest is generated
    await this.blog.update({template: clonedTemplate.id});

    // Get cloned template hashes
    const clonedMetadata = await getMetadataAsync(clonedTemplate.id);
    const clonedHashes = {
      "style.css": clonedMetadata.cdn["style.css"],
      "script.js": clonedMetadata.cdn["script.js"],
    };

    // Verify all hashes are different
    expect(clonedHashes["style.css"]).not.toBe(sourceHashes["style.css"]);
    expect(clonedHashes["script.js"]).not.toBe(sourceHashes["script.js"]);

    // Verify all hashes are valid 32-character strings
    Object.values(clonedHashes).forEach((hash) => {
      expect(typeof hash).toBe("string");
      expect(hash.length).toBe(32);
    });
  });

  it("stores cloned template CDN files on disk with correct hashes", async function () {
    const fs = require("fs-extra");
    const path = require("path");
    const config = require("config");
    const sourceTemplate = await create(this.blog.id, "templatename", {});

        // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});

    const viewName = "style.css";
    const viewContent = "body{color:red}";
    await setView(sourceTemplate.id, { name: viewName, content: viewContent });
    await setView(sourceTemplate.id, {
      name: "head.html",
      content: "{{#cdn}}/style.css{{/cdn}}",
    });

    const sourceMetadata = await getMetadataAsync(sourceTemplate.id);
    const sourceHash = sourceMetadata.cdn[viewName];
    const viewBaseName = path.basename(viewName);

     // Verify source template file also exists (different hash)
    const sourceDir1 = sourceHash.substring(0, 2);
    const sourceDir2 = sourceHash.substring(2, 4);
    const sourceHashRemainder = sourceHash.substring(4);
    const sourceFilePath = path.join(
      config.data_directory,
      "cdn",
      "template",
      sourceDir1,
      sourceDir2,
      sourceHashRemainder,
      viewBaseName
    );
    expect(await fs.pathExists(sourceFilePath)).toBe(true);

    // Clone the template
    const clonedTemplate = await create(this.blog.id, "templatenamecloned", {
      cloneFrom: sourceTemplate.id,
    });

            // Install the template so the CDN manifest is generated
    await this.blog.update({template: clonedTemplate.id});

    const clonedMetadata = await getMetadataAsync(clonedTemplate.id);
    const clonedHash = clonedMetadata.cdn[viewName];

    // Verify file exists on disk for cloned template
    const dir1 = clonedHash.substring(0, 2);
    const dir2 = clonedHash.substring(2, 4);
    const hashRemainder = clonedHash.substring(4);
    const filePath = path.join(
      config.data_directory,
      "cdn",
      "template",
      dir1,
      dir2,
      hashRemainder,
      viewBaseName
    );

    expect(await fs.pathExists(filePath)).toBe(true);
    const fileContent = await fs.readFile(filePath, "utf8");
    expect(fileContent).toBe(viewContent);

    // Previous hash not purged after installation switch
    expect(await fs.pathExists(sourceFilePath)).toBe(true);
  });

  it("preserves metadata except CDN manifest when cloning", async function () {
    const sourceTemplate = await create(this.blog.id, "templatename", {
      locals: { color: "red", size: "large" },
    });
            // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});



    await setView(sourceTemplate.id, {
      name: "style.css",
      content: "body{color:red}",
    });
    await setView(sourceTemplate.id, {
      name: "head.html",
      content: "{{#cdn}}/style.css{{/cdn}}",
    });

    const sourceMetadata = await getMetadataAsync(sourceTemplate.id);

    // Clone the template
    const clonedTemplate = await create(this.blog.id, "templatenamecloned", {
      cloneFrom: sourceTemplate.id,
    });

                // Install the template so the CDN manifest is generated
    await this.blog.update({template: clonedTemplate.id});


    const clonedMetadata = await getMetadataAsync(clonedTemplate.id);

    // Verify metadata is preserved
    expect(clonedMetadata.locals).toEqual(sourceMetadata.locals);

    // Verify CDN manifest is regenerated (not copied)
    expect(clonedMetadata.cdn).toBeDefined();
    expect(clonedMetadata.cdn["style.css"]).toBeDefined();
    expect(clonedMetadata.cdn["style.css"]).not.toBe(
      sourceMetadata.cdn["style.css"]
    );
  });

  it("clones template with no CDN usage and creates empty manifest", async function () {
    const sourceTemplate = await create(this.blog.id, "templatename", {});

    // Add views without CDN usage
    await setView(sourceTemplate.id, {
      name: "entries.html",
      content: "<h1>Hello</h1>",
    });
    await setView(sourceTemplate.id, {
      name: "style.css",
      content: "body{color:red}",
    });

    // Don't call updateCdnManifest - template has no CDN usage
    const sourceMetadata = await getMetadataAsync(sourceTemplate.id);
    expect(sourceMetadata.cdn).toEqual({});

    // Clone the template
    const clonedTemplate = await create(this.blog.id, "templatenamecloned", {
      cloneFrom: sourceTemplate.id,
    });

    const clonedMetadata = await getMetadataAsync(clonedTemplate.id);

    // Verify manifest is empty (not copied from source)
    expect(clonedMetadata.cdn).toEqual({});
  })

  it("allows independent modification of cloned template CDN assets", async function () {
    const sourceTemplate = await create(this.blog.id, "templatename", {});

                    // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});


    const viewName = "style.css";
    await setView(sourceTemplate.id, {
      name: viewName,
      content: "body{color:red}",
    });
    await setView(sourceTemplate.id, {
      name: "head.html",
      content: "{{#cdn}}/style.css{{/cdn}}",
    });

    const sourceMetadataBefore = await getMetadataAsync(sourceTemplate.id);
    const sourceHashBefore = sourceMetadataBefore.cdn[viewName];

    // Clone the template
    const clonedTemplate = await create(this.blog.id, "templatenamecloned", {
      cloneFrom: sourceTemplate.id,
    });

                        // Install the template so the CDN manifest is generated
    await this.blog.update({template: clonedTemplate.id});


    const clonedMetadataBefore = await getMetadataAsync(clonedTemplate.id);
    const clonedHashBefore = clonedMetadataBefore.cdn[viewName];

    // Modify cloned template's view content
    await setView(clonedTemplate.id, {
      name: viewName,
      content: "body { color: green; }",
    });

    const clonedMetadataAfter = await getMetadataAsync(clonedTemplate.id);
    const clonedHashAfter = clonedMetadataAfter.cdn[viewName];

    // Verify cloned template's hash changed
    expect(clonedHashAfter).not.toBe(clonedHashBefore);


                        // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});

    // Verify source template's hash remains unchanged
    const sourceMetadataAfter = await getMetadataAsync(sourceTemplate.id);
    const sourceHashAfter = sourceMetadataAfter.cdn[viewName];
    expect(sourceHashAfter).toBe(sourceHashBefore);
  });

  it("generates correct CDN URLs for cloned template using new hashes", async function () {
    const sourceTemplate = await create(this.blog.id, "templatename", {});
    // Install the template so the CDN manifest is generated
    await this.blog.update({template: sourceTemplate.id});

    const viewName = "style.css";
    await setView(sourceTemplate.id, {
      name: viewName,
      content: "body{color:red}",
    });
    await setView(sourceTemplate.id, {
      name: "head.html",
      content: "{{#cdn}}/style.css{{/cdn}}",
    });

        // Generate URLs for both
    const generateCdnUrl = require("../util/generateCdnUrl");

    const sourceMetadata = await getMetadataAsync(sourceTemplate.id);
    const sourceHash = sourceMetadata.cdn[viewName];
    const sourceUrl = generateCdnUrl(viewName, sourceHash);

    // Clone the template
    const clonedTemplate = await create(this.blog.id, "templatenamecloned", {
      cloneFrom: sourceTemplate.id,
    });

    // Install the template so the CDN manifest is generated
    await this.blog.update({template: clonedTemplate.id});

    const clonedMetadata = await getMetadataAsync(clonedTemplate.id);
    const clonedHash = clonedMetadata.cdn[viewName];
    const clonedUrl = generateCdnUrl(viewName, clonedHash);

    // Verify URLs are different (different hashes)
    expect(clonedUrl).not.toBe(sourceUrl);

    // Verify URL format is correct (uses basename, not full path)
    expect(clonedUrl).toContain("/template/");
    expect(clonedUrl).toContain(clonedHash.substring(0, 2));
    expect(clonedUrl).toContain(clonedHash.substring(2, 4));
    expect(clonedUrl).toContain(clonedHash.substring(4));
    expect(clonedUrl).toContain("style.css");
    expect(clonedUrl).not.toContain("/style.css/"); // Should not have extra slashes
  });
});

describe("template clone across blogs", function () {
  global.test.templates();
  global.test.blogs(2);

  const { promisify } = require("util");
  const create = promisify(require("../create"));
  const clone = promisify(require("../clone"));
  const getMetadataAsync = promisify(require("../getMetadata"));

  it("drops the favicon local so a copy never references another blog's assets", async function () {
    const [source, recipient] = this.blogs;
    const favicon = {
      prefix: "favicon-22222222-2222-2222-2222-222222222222",
      ico: "https://cdn.example/" + source.id + "/_template_assets/favicon.ico",
    };
    const sourceTemplate = await create(source.id, "shared", { locals: { favicon, color: "red" } });

    const toID = recipient.id + ":shared";
    await clone(sourceTemplate.id, toID, {
      id: toID,
      owner: recipient.id,
      name: "shared",
      slug: "shared",
      locals: {},
    });

    const copyMeta = await getMetadataAsync(toID);
    expect(copyMeta.locals.favicon).toBeUndefined();
    expect(copyMeta.locals.color).toEqual("red");
  });
});
