const Sortable = require("./sortable.js");
const sortEl = document.querySelector(".sortable");
const redirectsContainer = document.getElementById("redirects");

if (redirectsContainer) {
  // Save changes and Cancel show once there is something to save: a redirect
  // added, removed, moved or edited
  const redirectsForm = redirectsContainer.closest("form");
  const saveButtons = redirectsForm && redirectsForm.querySelector(".buttons");

  function showSaveButtons() {
    if (saveButtons) saveButtons.hidden = false;
  }

  if (saveButtons) {
    saveButtons.hidden = true;
    redirectsForm.addEventListener("input", showSaveButtons);
  }

  function announce(message) {
    const announcer = document.getElementById("dashboard-announcer");
    if (!announcer) return;
    announcer.textContent = "";
    setTimeout(function () {
      announcer.textContent = message;
    }, 50);
  }

  // Row inputs are named redirects.<index>.from|to: renumber after a move
  function renumberRows() {
    const sections = redirectsContainer.querySelectorAll("section");
    sections.forEach((section, index) => {
      const inputs = section.querySelectorAll("input");
      inputs.forEach((input) => {
        const name = input.getAttribute("name");
        const newName =
          name.slice(0, name.indexOf(".") + 1) +
          index +
          name.slice(name.lastIndexOf("."));
        input.setAttribute("name", newName);
      });
    });
    showSaveButtons();
  }

  // Name each row's buttons after its "from" value
  function labelRow(section) {
    const from = section.querySelector('input[name*="from"]');
    const suffix = from && from.value ? " from " + from.value : "";
    const handle = section.querySelector(".handle");
    const remove = section.querySelector(".removeLink");
    if (handle) handle.setAttribute("aria-label", "Move redirect" + suffix);
    if (remove) remove.setAttribute("aria-label", "Remove redirect" + suffix);
  }

  redirectsContainer.addEventListener("input", function (e) {
    if (e.target.name && e.target.name.slice(-5) === ".from") {
      labelRow(e.target.closest("section"));
    }
  });

  new Sortable(sortEl, {
    handle: ".handle",
    ghostClass: "sortable-ghost",
    onUpdate: renumberRows,
  });

  // Keyboard reordering: ArrowUp / ArrowDown on a row's handle
  redirectsContainer.addEventListener("keydown", function (e) {
    const handle = e.target.closest(".handle");
    if (!handle || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const row = handle.closest("section");
    const rows = Array.from(redirectsContainer.querySelectorAll("section"));
    const index = rows.indexOf(row);
    if (e.key === "ArrowUp" && index > 0) {
      redirectsContainer.insertBefore(row, rows[index - 1]);
    } else if (e.key === "ArrowDown" && index < rows.length - 1) {
      redirectsContainer.insertBefore(row, rows[index + 1].nextSibling);
    } else {
      return;
    }
    handle.focus();
    renumberRows();
    announce(
      "Moved to position " +
        (rows.indexOf(row) + (e.key === "ArrowUp" ? 0 : 2)) +
        " of " +
        rows.length
    );
  });

  redirectsContainer.addEventListener("click", function (e) {
    const removeButton = e.target.closest(".removeLink");
    if (removeButton) {
      const row = removeButton.closest("section");
      const rows = Array.from(redirectsContainer.querySelectorAll("section"));
      const neighbour =
        rows[rows.indexOf(row) + 1] || rows[rows.indexOf(row) - 1];
      row.remove();
      e.preventDefault();
      showSaveButtons();

      if (neighbour) {
        neighbour.querySelector('input[name*="from"]').focus();
      } else {
        const emptyRedirects = document.getElementById("emptyRedirects");
        emptyRedirects.style.display = "block";
        document.getElementById("addRedirect").focus();
      }
      announce("Redirect removed. Save changes to apply.");

      return false;
    }
  });

  function createRedirect(from) {
    // hide the empty redirects message

    const emptyRedirects = document.getElementById("emptyRedirects");
    emptyRedirects.style.display = "none";

    const index = redirectsContainer.querySelectorAll("section").length;
    const linkID = new Date().getTime();
    const newlink = document.getElementById("new_redirect").cloneNode(true);
    newlink.removeAttribute("style");

    newlink.id += linkID;

    const inputs = newlink.querySelectorAll("input");
    inputs.forEach((input) => {
      input.removeAttribute("disabled");
    });

    const fromInput = newlink.querySelector('input[name*="from"]');
    fromInput.value = from || "";

    const indexInputs = newlink.querySelectorAll('input[name*="{index}"]');
    indexInputs.forEach((input) => {
      const name = input.getAttribute("name");
      const newName = name.split("{index}").join(index);
      input.setAttribute("name", newName);
    });

    redirectsContainer.appendChild(newlink);
    showSaveButtons();

    if (from) {
      newlink.querySelector('input[name*="to"]').focus();
    } else {
      newlink.querySelector('input[name*="from"]').focus();
    }
  }

  const addRedirectButton = document.getElementById("addRedirect");

  addRedirectButton.addEventListener("click", function (e) {
    e.preventDefault();
    createRedirect();
    return false;
  });

  // extract a new redirect from the query 'create'
  // if it exists, and remove it from the query
  const url = new URL(window.location.href);
  const create = url.searchParams.get("create");
  if (create) {
    url.searchParams.delete("create");
    window.history.replaceState({}, "", url.toString());
    createRedirect(create);
  }
}

const bulk = document.getElementById("bulk_redirects");

if (bulk) {
  // Remove inline onclick handlers from all buttons
  document.querySelectorAll("button").forEach((btn) => {
    btn.removeAttribute("onclick");
  });

  // Attach submit handler to the form
  document.querySelectorAll("form").forEach((form) => {
    form.addEventListener("submit", (event) => {
      const textarea = form.querySelector("textarea");
      if (!textarea) return;

      const redirects = textarea.value.trim();
      if (!redirects) return;

      redirects.split("\n").forEach((line, index) => {
        const fromTo = line.split(" ");
        const from = fromTo[0];
        const to = fromTo[1];

        const inputFrom = document.createElement("input");
        inputFrom.className = "lab";
        inputFrom.type = "text";
        inputFrom.placeholder = "from";
        inputFrom.name = `redirects.${index}.from`;
        inputFrom.value = from || "";

        const inputTo = document.createElement("input");
        inputTo.className = "val";
        inputTo.type = "text";
        inputTo.placeholder = "to";
        inputTo.name = `redirects.${index}.to`;
        inputTo.value = to || "";

        form.appendChild(inputFrom);
        form.appendChild(inputTo);
      });

      textarea.remove();
    });
  });
}
