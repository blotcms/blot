const Blog = require("models/blog");
const Template = require("models/template");
const storage = require("storage/folder");
const writeToFolder = require("models/template").writeToFolder;
const Git = require("clients/git/git");
const fs = require("fs-extra");
const path = require("path");

async function setup(blogHandle) {
  try {
    // Get blog by handle
    console.log("Looking up blog with handle:", blogHandle);
    let blog;
    try {
      blog = await Blog.get({ handle: blogHandle });
    } catch (err) {
      blog = undefined;
    }
    if (!blog) throw new Error("No blog found with handle: " + blogHandle);

    console.log("Found blog:", blog.id, blog.handle);
    console.log("Blog client:", blog.client);

    // Generate template name
    const timestamp = Date.now();
    const templateName = "test-restore-" + timestamp;
    console.log("Creating template:", templateName);

    // Create template
    const template = await Template.create(blog.id, templateName, {});

    console.log("Template created:", template.id);

    // Enable local editing (this triggers writeToFolder)
    console.log("Enabling local editing...");
    await Template.setMetadata(template.id, { localEditing: true });

    console.log("Local editing enabled, template written to folder");

    // Determine template folder path
    const templateBase = fs.existsSync(
      await storage.path(blog.id, "/Templates")
    )
      ? "Templates"
      : "templates";
    const templateDir = await storage.path(
      blog.id,
      path.join("/", templateBase, template.slug)
    );

    console.log("Template directory:", templateDir);

    // Initialize git repo in template folder
    console.log("Initializing git repository...");
    const git = Git(templateDir);

    await git.raw(["init"]);

    // Create some files and commits
    console.log("Creating initial files and commits...");

    // Create a test file
    const testFile = path.join(templateDir, "test.txt");
    await fs.outputFile(testFile, "Initial commit\n");

    // Add and commit
    await git.raw(["add", "test.txt"]);
    await git.raw(["commit", "-m", "Initial commit"]);

    // Create another file and commit
    const testFile2 = path.join(templateDir, "test2.txt");
    await fs.outputFile(testFile2, "Second commit\n");

    await git.raw(["add", "test2.txt"]);
    await git.raw(["commit", "-m", "Second commit"]);

    // Create a file in .git to ensure there are files to delete
    await fs.outputFile(
      path.join(templateDir, ".git", "test-file.txt"),
      "This should be deleted\n"
    );

    console.log("Git repository initialized with 2 commits");
    console.log("Created test file in .git directory");

    // Now run writeToFolder again to trigger the bug (delete .git files)
    console.log("Running writeToFolder again to trigger bug...");
    await writeToFolder(blog.id, template.id);

    console.log("writeToFolder completed");
    console.log("");
    console.log("Setup complete!");
    console.log("Blog ID:", blog.id);
    console.log("Blog Handle:", blog.handle);
    console.log("Template ID:", template.id);
    console.log("Template Name:", templateName);
    console.log("Template Directory:", templateDir);
    console.log("");
    console.log("The .git directory should now have deleted files.");
    console.log(
      "You can now checkout the latest code and run the restore scripts."
    );
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  const blogHandle = process.argv[2];
  if (!blogHandle) {
    console.error("Usage: node setup-restore-git-test.js <blog-handle>");
    process.exit(1);
  }
  setup(blogHandle);
}

module.exports = setup;
