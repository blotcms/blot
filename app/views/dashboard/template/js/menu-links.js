// Assumes SortableJS is available globally as `Sortable`.
// Replaces jQuery selectors/events with vanilla DOM APIs.

const Sortable = require('../../../js/sortable.js');

(function () {
  const sortableEl = document.querySelector(".sortable");
  const menuEl = document.getElementById("menu");
  const emptyMenuEl = document.getElementById("emptyMenu");
  const addBtn = document.getElementById("add");
  const linkTemplate = document.getElementById("link_");

  function updateEmptyMenuVisibility() {
    if (!menuEl || !emptyMenuEl) return;
    const hasSections = !!menuEl.querySelector("section");
    emptyMenuEl.style.display = hasSections ? "none" : "";
  }

  function renameInputsBySectionIndex() {
    const sortable = document.querySelector(".sortable");
    if (!sortable) return;

    const sections = Array.from(sortable.querySelectorAll("section"));

    sections.forEach((section, index) => {
      const inputs = Array.from(section.querySelectorAll("input"));

      inputs.forEach((input) => {
        const name = input.getAttribute("name");
        if (!name) return;

        const firstDot = name.indexOf(".");
        const lastDot = name.lastIndexOf(".");
        if (firstDot === -1 || lastDot === -1 || lastDot <= firstDot) return;

        const newName =
          name.slice(0, firstDot + 1) + index + name.slice(lastDot);

        input.setAttribute("name", newName);
        console.log(name + " > " + newName);
      });

      console.log("");
    });
  }

  // Sortable
  if (sortableEl && typeof Sortable !== "undefined") {
    Sortable.create(sortableEl, {
      handle: ".handle",
      ghostClass: "sortable-ghost",
      onUpdate: renameInputsBySectionIndex,
    });
  }

  // Delegate clicks inside #menu for ".removeLink"
  if (menuEl) {
    menuEl.addEventListener("click", (e) => {
      const removeLink = e.target.closest(".removeLink");
      if (!removeLink || !menuEl.contains(removeLink)) return;

      // Match original behavior: if it has class "page", toggle .details
      if (removeLink.classList.contains("page")) {
        const details = removeLink.parentElement?.parentElement?.querySelector(".details");
        if (details) {
          // jQuery toggle() equivalent
          const isHidden =
            details.style.display === "none" ||
            getComputedStyle(details).display === "none";
          details.style.display = isHidden ? "" : "none";
        }
        return;
      }

      // Otherwise remove the parent element
      e.preventDefault();
      removeLink.parentElement?.remove();

      updateEmptyMenuVisibility();
      return false;
    });
  }

  // Add new link
  if (addBtn && menuEl && linkTemplate) {
    addBtn.addEventListener("click", (e) => {
      e.preventDefault();

      const index = menuEl.querySelectorAll("section").length;
      const linkID = Date.now();

      // Clone template
      const newlink = linkTemplate.cloneNode(true);
      newlink.removeAttribute("style");

      if (emptyMenuEl) emptyMenuEl.style.display = "none";

      // Update id
      newlink.id = (newlink.id || "link_") + linkID;

      // Enable inputs
      newlink.querySelectorAll("input").forEach((input) => {
        input.removeAttribute("disabled");
      });

      // Replace {index} in input names
      newlink
        .querySelectorAll('input[name*="{index}"]')
        .forEach((input) => {
          input.name = input.name.split("{index}").join(String(index));
        });

      // Replace {id} in input values (only when value contains {id})
      newlink
        .querySelectorAll('input[value*="{id}"]')
        .forEach((input) => {
          input.value = input.value.split("{id}").join(String(linkID));
        });

      menuEl.appendChild(newlink);

      // Focus: [name="title_<id>"]
      const titleInput = document.querySelector(`[name="title_${linkID}"]`);
      if (titleInput) titleInput.focus();

      return false;
    });
  }

  // Initialize empty state correctly on load
  updateEmptyMenuVisibility();
})();
