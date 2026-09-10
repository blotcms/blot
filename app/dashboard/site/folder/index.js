const localPath = require("helper/localPath");
const getBreadcrumbs = require("./breadcrumbs");
const getFile = require("./file");
const getFolder = require("./folder");
const Stat = require("./stat");
const clfdate = require("helper/clfdate");

async function middleware(req, res, next) {
  try {
    // Normalize the string to fix an encoding bug
    // "ブ".length => 1
    // "ブ".length => 2
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize

    const dir = req.params.path ? "/" + req.params.path.normalize('NFC') : '/';

    const pageOptions = {
      page: req.query.page,
      pageSize: req.query.pageSize,
      sort: req.query.sort,
      order: req.query.order,
    };

    res.locals.folder = await loadFolder(req.blog, dir, pageOptions);

    addPaginationUrls(res.locals.folder, res.locals.base, dir, req.query);

    for (const breadcrumb of res.locals.folder.breadcrumbs) {
      res.locals.breadcrumbs.add(breadcrumb.name, breadcrumb.url);
    }

    if (req.params.path) {

      if (res.locals.folder.directory) {
        res.render("dashboard/folder/directory");
      } else {
        res.render("dashboard/folder/file");
      }

    } else if (req.xhr || req.query.partial) {

      // Infinite-scroll / sort fetches only need the directory listing, not
      // the whole dashboard shell.
      res.render("dashboard/folder/directory");

    } else {
      next();
    }

  } catch (err) {

    if (err && err.code === 'ENOENT' && req.params.path) {
      res.locals.folder = {directory: true, contents: []};
      res.render("dashboard/folder");
    } else {
      console.log("HERE", err);
      next(err);
    }

  }
}

// Cache the root directory folder data for 100 folders
// unless the blog is currenltly in the process of syncing
const folderCache = {};

const invalidateCache = (blog) => {
  const prefix = `${blog.id}_${blog.cacheID}_`;

  for (const key of Object.keys(folderCache)) {
    if (key.startsWith(prefix)) {
      delete folderCache[key];
    }
  }

  // Drop the cached whole-folder stat sweep used for date / size sorts.
  if (typeof getFolder.invalidateStatCache === "function") {
    getFolder.invalidateStatCache(blog);
  }
};

// Build the links the directory template renders as "Previous" / "Next" and
// the infinite-scroll fetcher reuses. Kept out of loadFolder so the cached
// folder object stays free of request-specific state.
const addPaginationUrls = (folder, base, dir, query = {}) => {
  if (!folder || !folder.pagination) return;

  const baseUrl =
    dir === "/"
      ? base + "/"
      : base + "/folder" + dir.split("/").map(encodeURIComponent).join("/");

  const params = [];
  const parsedSize = parseInt(query.pageSize, 10);
  if (Number.isFinite(parsedSize) && parsedSize > 0)
    params.push("pageSize=" + parsedSize);
  if (folder.pagination.sort && folder.pagination.sort !== "name")
    params.push("sort=" + encodeURIComponent(folder.pagination.sort));
  if (folder.pagination.order && folder.pagination.order !== "asc")
    params.push("order=" + encodeURIComponent(folder.pagination.order));

  const carry = params.length ? "&" + params.join("&") : "";

  folder.pagination.previousUrl =
    baseUrl + "?page=" + folder.pagination.previousPage + carry;
  folder.pagination.nextUrl =
    baseUrl + "?page=" + folder.pagination.nextPage + carry;
};

const loadFolder = async (blog, dir, options = {}) => {

  const page = parseInt(options.page, 10);
  const pageSize = parseInt(options.pageSize, 10);
  const sort = options.sort === "modified" || options.sort === "size"
    ? options.sort
    : "name";
  const order = options.order === "desc" ? "desc" : "asc";
  const cacheKey =
    blog.id +
    '_' +
    blog.cacheID +
    '_' +
    dir +
    '_p' +
    (Number.isFinite(page) && page > 0 ? page : 1) +
    '_s' +
    (Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 'default') +
    '_' + sort + '_' + order;
  const synced = blog.status.message.toLowerCase() === 'synced';
  
  if (synced && folderCache[cacheKey]) {
    // console.log(clfdate(), 'folder cache HIT', cacheKey);
    return folderCache[cacheKey];
  } else {
    // console.log(clfdate(), 'folder cache MISS', cacheKey);
  }

  if (Object.keys(folderCache).length >= 100) {
    const oldestCacheKey = Object.keys(folderCache)[0];
    delete folderCache[oldestCacheKey];
  }

  const local = localPath(blog.id, dir);
  const stat = await Stat(local, blog.timeZone);

  const folder = {
    root: dir === '/',
    directory: stat.directory,
    file: stat.file,
    stat,
  };

  if (stat.file) {
    const [breadcrumbs, fileStat] = await Promise.all([
      getBreadcrumbs(blog.id, dir, blog.cacheID),
      getFile(blog, dir)
    ]);

    folder.breadcrumbs = breadcrumbs;
    folder.stat = { ...folder.stat, ...fileStat };

  } else if (stat.directory) {
    const [breadcrumbs, folderContents] = await Promise.all([
      getBreadcrumbs(blog.id, dir, blog.cacheID),
      getFolder(blog, dir, { page, pageSize, sort, order })
    ]);

    folder.contents = folderContents.contents;
    folder.pagination = folderContents.pagination;
    folder.breadcrumbs = breadcrumbs;
  }

  if (dir === '/') {
    folderCache[cacheKey] = folder;
  }

  // console.log('folder cache is', JSON.stringify(folderCache, null, 2));

  return folder;
}


middleware.invalidateCache = invalidateCache;

module.exports = middleware;
