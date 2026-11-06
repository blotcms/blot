async function getBreadcrumbs(blogId, dir, cacheID) {
  if (dir === "/") {
    return [];
  }

  const names = dir.split("/").filter(Boolean);
  const breadcrumbs = [];

  for (let i = 0; i < names.length; i++) {
    breadcrumbs.push({
      name: names[i],
      url: i === 0 ? "/folder/" + names[i] : names[i],
    });
  }

  return breadcrumbs;
}

module.exports = getBreadcrumbs;
