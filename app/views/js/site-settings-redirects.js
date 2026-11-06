const redirectsContainer = document.getElementById("redirects");
const redirectsForm = document.querySelector(
  'form[action*="/settings/redirects"]'
);

if (!redirectsContainer && !redirectsForm) {
  return;
}

document
  .querySelectorAll(".buttons a, .buttons input, .buttons button")
  .forEach(function (button) {
    button.addEventListener("click", function (event) {
      event.target.classList.add("disabled");
    });
  });
