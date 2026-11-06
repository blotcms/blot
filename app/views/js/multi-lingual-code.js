// Define a dictionary to map language codes to their display names
var dictionary = {
  markdown: "Markdown",
  html: "HTML",
};

// For each multilingual code block, generate tabs before the code block and hide all but the first language
document
  .querySelectorAll("section.multilingual")
  .forEach(function (block, blockIndex) {
    // Rendered with its tabs already (the dashboard's file page)
    if (block.querySelector(".lang-tabs")) return;

    // Create a <ul> element to hold the language tabs
    var tabs = document.createElement("ul");
    tabs.classList.add("lang-tabs");

    // Insert the tabs into the block after the last code block
    block.appendChild(tabs);

    // Iterate over each <pre> element within the block
    block.querySelectorAll("pre").forEach(function (code, i) {
      var lang = code.getAttribute("data-lang") || code.getAttribute("lang");

      // If it's not the first code block, hide it
      if (i > 0) {
        code.style.display = "none";
      }

      // Trim the whitespace from the code block
      code.textContent = code.textContent.trim();

      // Create a <li> element for the tab
      var tab = document.createElement("li");

      // Generate a unique ID for the code block
      var id = lang + "-" + blockIndex + "-" + i;

      // Get the display name for the language from the dictionary, or use the language code itself if not found
      var text = dictionary[lang] || lang;

      // Set the tab's HTML content
      tab.innerHTML = '<a href="#' + id + '">' + text + "</a>";

      // Append the tab to the tabs list
      tabs.appendChild(tab);

      // Set the ID of the code block
      code.id = id;
    });

    // Add a copy button just before the tabs
    // and set the 'data-copy' attribute to the text content of the first code block
    var copy = document.createElement("button");
    // add the html <span class="icon-copy"></span> to the button
    copy.innerHTML = '<span class="icon-copy"></span> Copy';
    copy.classList.add("copy");
    copy.setAttribute("data-copy", block.querySelector("pre").textContent);
    tabs.before(copy);
  });

// Make it possible to switch between languages
document.querySelectorAll(".lang-tabs a").forEach(function (tab) {
  tab.addEventListener("click", function (e) {
    e.preventDefault();

    // Get the ID of the code block associated with the clicked tab
    var id = tab.getAttribute("href").slice(1);

    // Hide all code blocks within the same multilingual block
    tab.parentElement.parentElement.parentElement
      .querySelectorAll("pre")
      .forEach(function (code) {
        code.style.display = "none";
      });

    // Show the selected code block
    document.getElementById(id).style.display = "block";

    // Remove the 'active' class from all tabs within the same multilingual block
    tab.parentElement.parentElement
      .querySelectorAll("a")
      .forEach(function (tab) {
        tab.classList.remove("active");
      });

    // Update the copy button's 'data-copy' attribute to the text content of the selected code block
    tab.parentElement.parentElement.parentElement
      .querySelector(".copy")
      .setAttribute("data-copy", document.getElementById(id).textContent);

    // Add the 'active' class to the clicked tab
    tab.classList.add("active");
  });
});

// Select the first tab by default
document.querySelectorAll(".lang-tabs").forEach(function (tabs) {
  tabs.querySelector("a").click();
});

// Template output: Mustache input -> HTML output (with optional intermediate views)
// Detect runs of adjacent <pre> elements that end with a <pre> having class "output"
// (e.g. html template, json view, html output) and wrap them with a tab UI + copy button.
(function () {
  var groups = [];

  function hasClass(el, name) {
    return (
      (" " + (el.getAttribute("class") || "") + " ").indexOf(
        " " + name + " "
      ) !== -1
    );
  }

  function viewTypeForPre(pre) {
    var classList = (pre.getAttribute("class") || "")
      .split(/\s+/)
      .filter(Boolean);
    var generic = ["code", "window", "output"];

    // Known language-ish classes → view types
    if (classList.indexOf("html") !== -1) return "HTML";
    if (classList.indexOf("css") !== -1) return "CSS";
    if (classList.indexOf("json") !== -1) return "JSON";
    if (
      classList.indexOf("javascript") !== -1 ||
      classList.indexOf("js") !== -1
    )
      return "JS";

    var candidate = classList.find(function (c) {
      return generic.indexOf(c) === -1;
    });
    if (!candidate) return "Code";
    return candidate.charAt(0).toUpperCase() + candidate.slice(1);
  }

  function labelForPane(pre, i, total) {
    // If a data-file attribute is present, prefer showing the filename
    var file = pre.getAttribute("data-file");
    if (file) {
      return { html: '<span class="icon-file"></span> ' + file };
    }

    var viewType = viewTypeForPre(pre);

    // First pane: "Template $VIEWTYPE"
    if (i === 0) return { text: "Template " + viewType };

    // Last pane (pre.output): "Output $VIEWTYPE"
    if (i === total - 1) return { text: "Output " + viewType };

    // Middle JSON pane(s): "View JSON"
    if (hasClass(pre, "json")) return { text: "View JSON" };

    // Fallback for any other middle pane
    return { text: "View " + viewType };
  }

  document.querySelectorAll("pre.output").forEach(function (secondPre) {
    var firstPre = secondPre.previousElementSibling;
    if (!firstPre || firstPre.tagName !== "PRE") return;
    if (secondPre.closest(".code-block")) return;

    // Walk backwards to collect all immediately preceding <pre> siblings
    var pres = [];
    var current = secondPre;
    while (current && current.tagName === "PRE") {
      pres.unshift(current);
      current = current.previousElementSibling;
    }
    if (pres.length < 2) return;

    groups.push(pres);
  });

  groups.forEach(function (pres, index) {
    var container = document.createElement("div");
    container.className = "code-block";

    var toolbar = document.createElement("div");
    toolbar.className = "code-block-toolbar";

    var tabs = document.createElement("ul");
    tabs.className = "code-block-tabs";

    var ids = pres.map(function (_, i) {
      return "code-block-" + index + "-" + i;
    });

    pres.forEach(function (pre, i) {
      var label = labelForPane(pre, i, pres.length);
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.setAttribute("href", "#" + ids[i]);
      if (label && label.html) {
        a.innerHTML = label.html;
      } else if (label && label.text) {
        a.textContent = label.text;
      } else {
        a.textContent = String(label);
      }
      li.appendChild(a);
      tabs.appendChild(li);
    });

    var copy = document.createElement("button");
    copy.innerHTML = '<span class="icon-copy"></span> Copy';
    copy.classList.add("copy");
    copy.setAttribute("data-copy", pres[0].textContent);

    toolbar.appendChild(tabs);
    toolbar.appendChild(copy);

    pres[0].parentNode.insertBefore(container, pres[0]);
    container.appendChild(toolbar);

    pres.forEach(function (pre, i) {
      var pane = document.createElement("div");
      pane.className = "code-block-wrapper" + (i === 0 ? " active" : "");
      pane.setAttribute("data-pane-id", ids[i]);
      if (i > 0) pane.style.display = "none";

      pre.removeAttribute("id");
      pane.appendChild(pre);
      container.appendChild(pane);
    });

    tabs.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var id = a.getAttribute("href").slice(1);
        container
          .querySelectorAll(".code-block-wrapper")
          .forEach(function (pane) {
            pane.style.display =
              pane.getAttribute("data-pane-id") === id ? "block" : "none";
            pane.classList.toggle(
              "active",
              pane.getAttribute("data-pane-id") === id
            );
          });
        tabs.querySelectorAll("a").forEach(function (link) {
          link.classList.toggle("active", link === a);
        });
        var activePane = container.querySelector(".code-block-wrapper.active");
        var text = activePane ? activePane.textContent : "";
        copy.setAttribute("data-copy", text.trim());
      });
    });

    tabs.querySelector("a").classList.add("active");
  });
})();
