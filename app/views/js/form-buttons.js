document
  .querySelectorAll(".buttons a, .buttons input, .buttons button")
  .forEach(function (button) {
    button.addEventListener("click", function (a) {
      button.classList.add("working");

      // if the button or link text contains 'save' then replace with 'saving'
      if (button.innerText.toLowerCase().includes("save")) {
        // replace 'Save' with 'Saving' and 'save' with 'saving'
        button.innerText = button.innerText
          .replace(/Save/g, "Saving")
          .replace(/save/g, "saving");
      }
    });
  });
