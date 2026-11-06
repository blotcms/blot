var revalidateButton = document.querySelector("button.revalidate");

if (revalidateButton) {
  revalidateButton.addEventListener("click", function () {
    revalidateButton.classList.add("working");
  });
}
