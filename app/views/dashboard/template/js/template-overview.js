// The template list's filter pills and search: they hide the cards that
// don't match, all of which the server rendered
var browser = document.querySelector("[data-template-browser]");

if (browser) {
  var search = browser.querySelector("[data-template-search]");
  var noResults = browser.querySelector("[data-template-no-results]");
  var filters = browser.querySelectorAll("[data-template-filter]");
  var cards = browser.querySelectorAll("[data-template-type]");
  var templateFilter = "all";

  function filterCards() {
    var query = search.value.trim().toLocaleLowerCase();
    var visibleCount = 0;

    cards.forEach(function (card) {
      var name = card
        .querySelector("[data-template-name]")
        .textContent.toLocaleLowerCase();
      var matches =
        (!query || name.indexOf(query) !== -1) &&
        (templateFilter === "all" ||
          card.dataset.templateType === templateFilter);

      card.hidden = !matches;
      if (matches) visibleCount += 1;
    });

    if (visibleCount > 0) {
      noResults.textContent = "";
    } else if (query) {
      noResults.textContent = "No templates match your search.";
    } else if (templateFilter === "yours") {
      noResults.textContent =
        "You have no templates of your own yet. Open one of Blot's and copy it to customize it.";
    } else {
      noResults.textContent = "No templates to show.";
    }
  }

  search.addEventListener("input", filterCards);

  filters.forEach(function (button) {
    button.addEventListener("click", function () {
      templateFilter = button.dataset.templateFilter;
      filters.forEach(function (other) {
        var pressed = other === button;
        other.setAttribute("aria-pressed", pressed ? "true" : "false");
        other.classList.toggle("is-active", pressed);
      });
      filterCards();
    });
  });
}
