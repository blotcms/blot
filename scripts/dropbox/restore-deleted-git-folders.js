const path = require("path");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const getConfirmation = require("../util/getConfirmation");
const createClient = require("clients/dropbox/util/createClient");
const folder = require("storage/folder");

const posixJoin = path.posix.join;

const walkLocalGitFolder = async (blogID, templateFolder, templateName) => {
  const gitPath = path.join("/", templateFolder, templateName, ".git");

  try {
    const stats = await folder.stat(blogID, gitPath);
    if (!stats.isDirectory) return null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  // walk yields paths from the blog's folder; report them from the .git folder
  const depth = gitPath.split("/").filter(Boolean).length;
  const files = [];

  for await (const file of folder.walk(blogID, gitPath)) {
    files.push(file.split("/").filter(Boolean).slice(depth).join("/"));
  }

  return files;
};

const isGitFolderCorrupted = async (blogID, templateFolder, templateName) => {
  const files = await walkLocalGitFolder(blogID, templateFolder, templateName);
  if (files === null) return false;

  return files.length === 0;
};

const stats = {
  blogsProcessed: 0,
  gitFoldersFound: 0,
  filesRestored: 0,
};

const getClient = (blogID) => {
  return new Promise((resolve, reject) => {
    createClient(blogID, (err, client, account) => {
      if (err) return reject(err);
      resolve({ client, account });
    });
  });
};

const readTemplateDirectories = async (blogID) => {
  const templateFolders = [];
  const candidates = ["/Templates", "/templates"];

  for (const candidate of candidates) {
    let entries;

    try {
      entries = await folder.listNames(blogID, candidate);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }

    entries
      .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
      .forEach((entry) => {
        templateFolders.push({
          folder: candidate.replace(/^\//, ""),
          name: entry.name,
        });
      });
  }

  return templateFolders;
};

const listAllEntries = async (client, params) => {
  const entries = [];
  let response = await client.filesListFolder(params);
  let result = response.result || response;

  entries.push(...result.entries);

  while (result.has_more) {
    response = await client.filesListFolderContinue({ cursor: result.cursor });
    result = response.result || response;
    entries.push(...result.entries);
  }

  return entries;
};

const listDeletedGitFiles = async (client, gitPath) => {
  console.log("Listing deleted git files");

  const entries = await listAllEntries(client, {
    path: gitPath,
    recursive: true,
    include_deleted: true,
  });

  const gitPathLower = gitPath.toLowerCase();

  return entries.filter((entry) => {
    if (entry.path_lower === gitPathLower) return false;
    if (!entry.path_lower.startsWith(gitPathLower + "/")) return false;
    return entry[".tag"] === "deleted";
  });
};

const getLatestRevision = async (client, filePath) => {
  const response = await client.filesListRevisions({ path: filePath });
  const result = response.result || response;

  if (!result.entries || !result.entries.length) return null;

  return (
    result.entries.find((revision) => revision.is_current) || result.entries[0]
  );
};

const restoreFile = (client, filePath, rev) => {
  return client.filesRestore({ path: filePath, rev });
};

// Add retry wrapper for restoreFile
const restoreFileWithRetry = async (client, filePath, rev, maxRetries = 3) => {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await restoreFile(client, filePath, rev);
    } catch (err) {
      lastError = err;

      // Only retry on timeout errors
      if (
        err.code === "ETIMEDOUT" ||
        err.errno === "ETIMEDOUT" ||
        err.type === "system"
      ) {
        if (attempt < maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt) * 1000;
          console.log(
            `Retry attempt ${attempt + 1}/${maxRetries} for ${filePath} after ${delay}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // For non-timeout errors or final attempt, throw immediately
      throw err;
    }
  }

  throw lastError;
};

const restoreGitFolder = async (client, blog, gitPath, files, templateName) => {
  const message = `Restore deleted .git files at ${gitPath} containing ${files.length} files for blog ${blog.id} (${blog.handle})?`;

  const confirmed = await getConfirmation(message);

  if (!confirmed) {
    console.log("Skipped", gitPath);
    return 0;
  }

  let restored = 0;

  for (const file of files) {
    try {
      const revision = await getLatestRevision(client, file.path_lower);
      if (!revision) {
        console.log("No revisions found for", file.path_display);
        continue;
      }

      console.log("Restoring", file.path_display, "in", templateName);
      await restoreFileWithRetry(client, file.path_lower, revision.rev);
      restored += 1;
      console.log("Restored", file.path_display, "in", templateName);
    } catch (err) {
      console.log("Error restoring", file.path_display, err.message || err);
    }
  }

  return restored;
};

const processBlog = async (blog) => {
  if (!blog || blog.client !== "dropbox") return;

  stats.blogsProcessed += 1;

  const templates = await readTemplateDirectories(blog.id);

  if (!templates.length) {
    console.log("No template directories for", blog.id, blog.handle);
    return;
  }

  let client;
  let account;

  try {
    ({ client, account } = await getClient(blog.id));
  } catch (err) {
    console.log("Error creating Dropbox client for", blog.id, err);
    return;
  }

  for (const template of templates) {
    const templatePath = posixJoin(
      account.folder || "/",
      template.folder,
      template.name
    );

    console.log(
      "Checking template",
      template.name,
      "at",
      templatePath,
      "for blog",
      blog.id,
      blog.handle
    );

    const corrupted = await isGitFolderCorrupted(
      blog.id,
      template.folder,
      template.name
    );

    if (!corrupted) {
      console.log(
        `Local .git for ${template.folder}/${template.name} is healthy or missing; skipping.`
      );
      continue;
    }

    const gitPath = posixJoin(templatePath, ".git");
    let files;

    try {
      files = await listDeletedGitFiles(client, gitPath);
    } catch (err) {
      console.log("Error listing deleted files for", gitPath, err);
      continue;
    }

    if (!files.length) {
      console.log("No deleted files found in", gitPath);
      continue;
    }

    stats.gitFoldersFound += 1;

    try {
      const restored = await restoreGitFolder(
        client,
        blog,
        gitPath,
        files,
        template.name
      );
      stats.filesRestored += restored;
    } catch (err) {
      console.log("Error during restoration for", gitPath, err);
    }
  }
};

if (require.main === module) {
  eachBlogOrOneBlog(processBlog)
    .then(() => {
      console.log("Processed blogs:", stats.blogsProcessed);
      console.log("Deleted .git folders found:", stats.gitFoldersFound);
      console.log("Files restored:", stats.filesRestored);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Script failed:", err);
      process.exit(1);
    });
}
