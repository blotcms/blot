const exifInput = document.querySelector('input[name="imageExif"]');

if (exifInput) {
  const exifRadios = document.querySelectorAll('input[name="imageExif"]');

  exifRadios.forEach((radio) => {
    radio.addEventListener("change", function () {
      const form = this.closest("form");

      if (form && typeof window.submitForm === "function") {
        window.submitForm(form);
      }
    });
  });
}
