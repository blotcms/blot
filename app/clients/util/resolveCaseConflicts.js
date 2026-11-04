const path = require("path");
const folder = require("storage/folder");
const clfdate = require("helper/clfdate");

const prefix = () => `${clfdate()} case-conflict:`;

const canonicalName = (name) => name.normalize("NFC").toLowerCase();

const sortByName = (entries) =>
  entries.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "variant" })
  );

const listEntries = async (blogID, relDir) => {
  return sortByName(await folder.listNames(blogID, relDir));
};

const getParentPaths = (relPath) => {
  const parents = [];
  let current = path.posix.dirname(relPath);
  while (current && current !== ".") {
    parents.push(current);
    if (current === "/") break;
    current = path.posix.dirname(current);
  }
  return parents;
};

const updatePathAndParents = async (update, relPath) => {
  const unique = new Set([relPath, ...getParentPaths(relPath)]);
  for (const entry of unique) {
    await update(entry);
  }
};

const collectTreePaths = async (blogID, relDir) => {
  const entries = await listEntries(blogID, relDir);
  const paths = [relDir];

  for (const entry of entries) {
    const childRel = path.posix.join(relDir, entry.name);
    paths.push(childRel);
    if (entry.isDirectory) {
      const childPaths = await collectTreePaths(blogID, childRel);
      paths.push(...childPaths.filter((p) => p !== childRel));
    }
  }

  return paths;
};

const updateTree = async (blogID, update, relDir) => {
  const paths = await collectTreePaths(blogID, relDir);
  for (const entry of paths) {
    await update(entry);
  }
  const parents = getParentPaths(relDir);
  for (const parent of parents) {
    await update(parent);
  }
};

const splitName = (name) => {
  const lastDot = name.lastIndexOf(".");
  if (lastDot > 0) {
    return { base: name.slice(0, lastDot), ext: name.slice(lastDot) };
  }
  return { base: name, ext: "" };
};

const generateConflictName = (existingLowerSet, originalName) => {
  const { base, ext } = splitName(originalName);
  let suffix = " (conflict)";
  let counter = 2;
  let candidate = `${base}${suffix}${ext}`;

  while (existingLowerSet.has(canonicalName(candidate))) {
    suffix = ` (conflict ${counter})`;
    candidate = `${base}${suffix}${ext}`;
    counter += 1;
  }

  existingLowerSet.add(canonicalName(candidate));
  return candidate;
};

const abortIfRequested = (signal) => {
  if (signal && signal.aborted) {
    const error = new Error("Case conflict resolution aborted");
    error.name = "AbortError";
    throw error;
  }
};

// `signal` is optional ({ aborted: boolean }). When it is set, resolution
// stops with an AbortError before the next rename, move or merge.
// `ignore` is an optional predicate (relative path -> boolean). Matching
// entries are neither renamed nor descended into, so version control
// folders and other ignored paths are left alone. Without it every entry is
// considered (iCloud's behaviour).
module.exports = async function resolveCaseConflicts(
  blogID,
  publish,
  update,
  signal,
  ignore
) {
  const isIgnored = (relDir, entry) =>
    typeof ignore === "function" && ignore(path.posix.join(relDir, entry.name));

  if (!publish) {
    publish = () => {};
  }
  if (!update) {
    update = () => {};
  }

  const renameEntry = async (relDir, originalName, newName) => {
    abortIfRequested(signal);
    const fromRel = path.posix.join(relDir, originalName);
    const toRel = path.posix.join(relDir, newName);
    const fromStat = await folder.stat(blogID, fromRel);
    const fromTreePaths = fromStat.isDirectory
      ? await collectTreePaths(blogID, fromRel)
      : null;
    await folder.move(blogID, fromRel, toRel);
    console.log(prefix(), "Renamed conflict", fromRel, "->", toRel);
    publish("Renamed conflict", fromRel, "->", toRel);
    await updatePathAndParents(update, fromRel);
    await updatePathAndParents(update, toRel);
    if (fromTreePaths) {
      for (const entry of fromTreePaths) {
        await update(entry);
      }
      await updateTree(blogID, update, toRel);
    }
  };

  const moveEntry = async (fromRel, toRel) => {
    abortIfRequested(signal);
    const fromStat = await folder.stat(blogID, fromRel);
    const fromTreePaths = fromStat.isDirectory
      ? await collectTreePaths(blogID, fromRel)
      : null;
    await folder.move(blogID, fromRel, toRel);
    await updatePathAndParents(update, fromRel);
    await updatePathAndParents(update, toRel);
    if (fromTreePaths) {
      for (const entry of fromTreePaths) {
        await update(entry);
      }
      await updateTree(blogID, update, toRel);
    }
  };

  const mergeDirectory = async (targetRel, sourceRel) => {
    const entries = await listEntries(blogID, sourceRel);

    for (const entry of entries) {
      abortIfRequested(signal);
      const sourceChildRel = path.posix.join(sourceRel, entry.name);
      const targetChildRel = path.posix.join(targetRel, entry.name);

      if (await folder.exists(blogID, targetChildRel)) {
        const targetStat = await folder.stat(blogID, targetChildRel);

        if (targetStat.isDirectory && entry.isDirectory) {
          await mergeDirectory(targetChildRel, sourceChildRel);
        } else if (targetStat.isDirectory && !entry.isDirectory) {
          const targetEntries = await listEntries(blogID, targetRel);
          const existingLowerSet = new Set(
            targetEntries.map((item) => canonicalName(item.name))
          );
          const conflictName = generateConflictName(existingLowerSet, entry.name);
          await moveEntry(sourceChildRel, path.posix.join(targetRel, conflictName));
        } else if (!targetStat.isDirectory && entry.isDirectory) {
          const targetEntries = await listEntries(blogID, targetRel);
          const existingLowerSet = new Set(
            targetEntries.map((item) => canonicalName(item.name))
          );
          const conflictName = generateConflictName(existingLowerSet, entry.name);
          await renameEntry(targetRel, entry.name, conflictName);
          await moveEntry(sourceChildRel, targetChildRel);
        } else {
          const targetEntries = await listEntries(blogID, targetRel);
          const existingLowerSet = new Set(
            targetEntries.map((item) => canonicalName(item.name))
          );
          const conflictName = generateConflictName(existingLowerSet, entry.name);
          await moveEntry(sourceChildRel, path.posix.join(targetRel, conflictName));
        }
      } else {
        await moveEntry(sourceChildRel, targetChildRel);
      }
    }

    await folder.remove(blogID, sourceRel);
    await updatePathAndParents(update, sourceRel);
    await updateTree(blogID, update, targetRel);
  };

  const resolveDir = async (relDir) => {
    abortIfRequested(signal);
    const allEntries = await listEntries(blogID, relDir);
    const entries = allEntries.filter((entry) => !isIgnored(relDir, entry));
    const existingLowerSet = new Set(
      allEntries.map((entry) => canonicalName(entry.name))
    );
    const groups = new Map();
    const orderedKeys = [];

    for (const entry of entries) {
      const key = canonicalName(entry.name);
      if (!groups.has(key)) {
        groups.set(key, []);
        orderedKeys.push(key);
      }
      groups.get(key).push(entry);
    }

    const resolvedDirs = new Set();

    for (const key of orderedKeys) {
      abortIfRequested(signal);
      const group = groups.get(key);
      if (!group || group.length < 2) continue;

      const dirs = group.filter((entry) => entry.isDirectory);
      const files = group.filter((entry) => !entry.isDirectory);

      if (dirs.length > 0) {
        const canonicalDir = dirs[0];
        const canonicalRel = path.posix.join(relDir, canonicalDir.name);

        for (const entry of dirs.slice(1)) {
          const sourceRel = path.posix.join(relDir, entry.name);
          await mergeDirectory(canonicalRel, sourceRel);
        }

        for (const entry of files) {
          const conflictName = generateConflictName(existingLowerSet, entry.name);
          await renameEntry(relDir, entry.name, conflictName);
        }

        await resolveDir(canonicalRel);
        resolvedDirs.add(canonicalRel);
      } else {
        const winner = files[0];
        for (const entry of files.slice(1)) {
          const conflictName = generateConflictName(existingLowerSet, entry.name);
          await renameEntry(relDir, entry.name, conflictName);
        }
        resolvedDirs.add(path.posix.join(relDir, winner.name));
      }
    }

    abortIfRequested(signal);
    const updatedEntries = await listEntries(blogID, relDir);
    for (const entry of updatedEntries) {
      if (!entry.isDirectory || isIgnored(relDir, entry)) continue;
      const childRel = path.posix.join(relDir, entry.name);
      if (resolvedDirs.has(childRel)) continue;
      await resolveDir(childRel);
    }
  };

  await resolveDir("/");
};
