const path = require("path");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const folder = require("storage/folder");
const getConfirmation = require("../util/getConfirmation");
const createDriveClient = require("clients/google-drive/serviceAccount/createDriveClient");
const database = require("clients/google-drive/database");

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const walkLocalGitFolder = async (blogID, templateBase, templateName) => {
  const gitPath = path.join(templateBase, templateName, ".git");

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

const isGitFolderCorrupted = async (blogID, templateBase, templateName) => {
  const files = await walkLocalGitFolder(blogID, templateBase, templateName);
  if (files === null) return false;

  return files.length === 0;
};

const listTemplateFolders = async (blogID) => {
  const templates = [];
  const candidateDirs = ["/Templates", "/templates"];

  for (const dir of candidateDirs) {
    try {
      const entries = await folder.listNames(blogID, dir);

      for (const entry of entries) {
        if (entry.isDirectory && !entry.name.startsWith(".")) {
          templates.push({ name: entry.name, base: dir });
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }

  return templates;
};

const listTrashedChildren = async (drive, parentId) => {
  const trashed = [];
  const stack = [parentId];

  while (stack.length) {
    const currentParent = stack.pop();
    let pageToken;

    do {
      // Query for ALL children (both trashed and non-trashed)
      // so we can explore non-trashed folders that may contain trashed files
      const res = await drive.files.list({
        q: `'${currentParent}' in parents`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields: "nextPageToken, files(id, name, mimeType, parents, trashed)",
        pageToken,
      });

      const files = res.data.files || [];

      for (const file of files) {
        // Add trashed items to the result
        if (file.trashed) {
          trashed.push(file);
        }

        // Push ALL folders onto the stack (trashed or not) so we can explore them
        // This allows us to find trashed files inside non-trashed subfolders
        if (file.mimeType === FOLDER_MIME_TYPE) {
          stack.push(file.id);
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  return trashed;
};

const findGitFolderId = async (drive, templateFolderId) => {
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${templateFolderId}' in parents and name = '.git' and trashed = false and mimeType = '${FOLDER_MIME_TYPE}'`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: "nextPageToken, files(id, name, parents)",
      pageToken,
    });

    const files = res.data.files || [];

    if (files.length) return files[0].id;

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return null;
};

const findDeletedGitFiles = async (drive, gitFolderId, localGitFiles = []) => {
  const trashedChildren = await listTrashedChildren(drive, gitFolderId);
  const parentMap = new Map();

  parentMap.set(gitFolderId, { id: gitFolderId, name: ".git", parents: [] });
  for (const item of trashedChildren) {
    parentMap.set(item.id, item);
  }

  const buildRelativePath = (item) => {
    const parts = [];
    let current = item;

    while (current && current.id !== gitFolderId) {
      parts.unshift(current.name);
      const parentId = current.parents && current.parents[0];
      current = parentMap.get(parentId);
    }

    return parts.join("/");
  };

  const localSet = new Set(localGitFiles);
  const shouldFilter = localGitFiles && localGitFiles.length > 0;
  const deletedFiles = [];

  for (const item of trashedChildren) {
    if (item.mimeType === FOLDER_MIME_TYPE) continue;

    const relativePath = buildRelativePath(item);

    if (shouldFilter && !localSet.has(relativePath)) continue;

    deletedFiles.push(item);
  }

  return deletedFiles;
};

const restoreFiles = async (drive, files) => {
  let restored = 0;

  for (const file of files) {
    try {
      await drive.files.update({
        fileId: file.id,
        requestBody: { trashed: false },
        supportsAllDrives: true,
      });
      restored += 1;
    } catch (err) {
      console.error("Failed to restore", file.id, "-", err.message);
    }
  }

  return restored;
};

const processBlog = async (blog) => {
  if (blog.client !== "google-drive")
    return { gitFoldersFound: 0, filesRestored: 0 };

  console.log(`Processing blog ${blog.id} (${blog.handle})`);

  const account = await database.blog.get(blog.id);

  if (!account) {
    console.log("  No Google Drive account info; skipping.");
    return { gitFoldersFound: 0, filesRestored: 0 };
  }

  const { folderId, serviceAccountId } = account;
  const drive = await createDriveClient(serviceAccountId);
  const folder = database.folder(folderId);

  const templates = await listTemplateFolders(blog.id);

  if (!templates.length) {
    console.log("  No template directories found.");
    return { gitFoldersFound: 0, filesRestored: 0 };
  }

  let gitFoldersFound = 0;
  let filesRestored = 0;

  for (const { name, base } of templates) {
    const templatePath = path.posix.join(base, name);
    const templateFolderId = await folder.getByPath(templatePath);

    if (!templateFolderId) {
      console.log(
        `  Missing template folder in Drive for ${templatePath}; skipping.`
      );
      continue;
    }

    const corrupted = await isGitFolderCorrupted(blog.id, base, name);

    if (!corrupted) {
      console.log(
        `  Local .git for ${templatePath} is healthy or missing; skipping.`
      );
      continue;
    }

    const gitFolderId = await findGitFolderId(drive, templateFolderId);

    if (!gitFolderId) {
      console.log(
        `  No .git folder found in Drive for ${templatePath}; skipping.`
      );
      continue;
    }

    gitFoldersFound += 1;

    const localGitFiles = await walkLocalGitFolder(blog.id, base, name);
    const deletedFiles = await findDeletedGitFiles(
      drive,
      gitFolderId,
      localGitFiles
    );

    if (!deletedFiles.length) {
      console.log(`  No deleted files found for ${templatePath}/.git.`);
      continue;
    }

    const message =
      `Restore ${deletedFiles.length} deleted files for blog ${blog.id} (${blog.handle}), ` +
      `template ${templatePath}, path ${templatePath}/.git?`;

    console.log(
      `  Found corrupted .git at ${templatePath}/.git with ${deletedFiles.length} trashed files.`
    );
    const confirmed = await getConfirmation(message);

    if (!confirmed) {
      console.log("  Skipping restore.");
      continue;
    }

    const restoredCount = await restoreFiles(drive, deletedFiles);
    filesRestored += restoredCount;
    console.log(`  Restored ${restoredCount} items for ${templatePath}/.git.`);
  }

  return { gitFoldersFound, filesRestored };
};

if (require.main === module) {
  let blogsProcessed = 0;
  let totalGitFolders = 0;
  let totalFilesRestored = 0;

  const wrappedProcessBlog = async (blog) => {
    const result = await processBlog(blog);
    blogsProcessed += 1;
    totalGitFolders += result.gitFoldersFound;
    totalFilesRestored += result.filesRestored;
  };

  eachBlogOrOneBlog(wrappedProcessBlog)
    .then(() => {
      console.log("Processing complete.");
      console.log("Blogs processed:", blogsProcessed);
      console.log("Deleted .git folders found:", totalGitFolders);
      console.log("Files restored:", totalFilesRestored);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Script terminated with error:", err);
      process.exit(1);
    });
}
