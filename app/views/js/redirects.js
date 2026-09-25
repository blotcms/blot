const Sortable = require('./sortable.js');
const sortEl = document.querySelector(".sortable");
const redirectsContainer = document.getElementById("redirects");

if (redirectsContainer) {

const sortable = new Sortable(sortEl, {
    handle: ".handle",
    ghostClass: "sortable-ghost",
    onUpdate: function () {
      const sections = document.querySelectorAll(".sortable section");
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
    },
  });

  redirectsContainer.addEventListener("click", function (e) {
    if (e.target.classList.contains("removeLink")) {
      e.target.parentNode.remove();
      e.preventDefault();

      if (!redirectsContainer.querySelector("section")) {
        const emptyRedirects = document.getElementById("emptyRedirects");
        emptyRedirects.style.display = "block";
      }

      return false;
    }
  });

  function createRedirect(from) {
    // hide the empty redirects message

    const emptyRedirects = document.getElementById("emptyRedirects");
    emptyRedirects.style.display = "none";

    const index = redirectsContainer.querySelectorAll("section").length;
    const linkID = new Date().getTime();
    const newlink = document
      .getElementById("new_redirect")
      .cloneNode(true);
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

    if (from) {
      newlink.querySelector('input[name*="to"]').focus();
    } else {
      newlink.querySelector('input[name*="from"]').focus();
    }

    e.preventDefault();
    return false;
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

const bulk = document.getElementById('bulk_redirects');

if (bulk)  {



// Remove inline onclick handlers from all buttons
document.querySelectorAll("button").forEach(btn => {
  btn.removeAttribute("onclick");
});

// Attach submit handler to the form
document.querySelectorAll("form").forEach(form => {
  form.addEventListener("submit", event => {
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
