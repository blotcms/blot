function renderBreadcrumbs() {
  const breadcrumbsContainer = document.querySelector(".breadcrumbs");

  if (!breadcrumbsContainer) return;

  const activeLink =
    document.querySelector(".sidebar a.active") ||
    document.querySelector(".menubar a.active");

  if (!activeLink) return;

  const breadcrumbs = [{ label: activeLink.textContent, url: activeLink.href }];

  let parent = activeLink.parentElement;

  while (parent) {
    if (
      parent.classList.contains("sidebar") ||
      parent.classList.contains("menubar")
    ) {
      break;
    }

    if (parent.classList.contains("submenu")) {
      breadcrumbs.unshift({
        label: parent.previousSibling.querySelector("a").textContent,
        url: parent.previousSibling.querySelector("a").href,
      });
    }

    parent = parent.parentElement;
  }

  if (breadcrumbs.length > 1) {
    breadcrumbsContainer.innerHTML = breadcrumbs
      .map(
        (breadcrumb, index) =>
          `<a href="${breadcrumb.url}" class="breadcrumb">${breadcrumb.label}</a>`
      )
      .join(" ");
  }
}

document.addEventListener("DOMContentLoaded", renderBreadcrumbs);
