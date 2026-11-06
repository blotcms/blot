const customDomainInput = document.getElementById("customDomain");

if (customDomainInput) {
  const submitButton = document.querySelector('.buttons button[type="submit"]');

  if (submitButton) {
    const initialValue = customDomainInput.value;

    customDomainInput.addEventListener("input", function (event) {
      if (event.target.value && !initialValue) {
        submitButton.textContent = "Set up custom domain";
      } else if (!event.target.value && initialValue) {
        submitButton.textContent = "Remove custom domain";
      } else {
        submitButton.textContent = "Save changes";
      }
    });
  }
}
