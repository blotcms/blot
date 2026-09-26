const Pickr = require('./pickr/es5.min.js');

const ajax = require('../js/ajax.js');
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

Array.from(document.querySelectorAll("form.color-picker")).forEach((form) => {
  // Simple example, see optional options for more configuration.
  const pickr = Pickr.create({
    el: form.querySelector(".color-picker-popup"),
    theme: "monolith", // or 'monolith', or 'nano'
    default: form.querySelector("input.value").value,
    useAsButton: true,
    position: "bottom-end",
    components: {
      // Main components
      preview: true,
      opacity: true,
      hue: true,

      // Input / output Options
      interaction: {
        // hex: true,
        // rgba: true,
        // hsla: true,
        // hsva: true,
        // cmyk: true,
        input: true,
        // clear: true,
        save: true,
      },
    },
  });

  // Choosing a palette writes the new value into the hidden input. Pickr
  // keeps the color it was created with unless told, and saving from that
  // stale picker would put the previous color back.
  form.addEventListener("template-preset-color", (event) => {
    const value = event.detail && event.detail.value;
    if (value) pickr.setColor(value, true);
  });

  pickr
    .on("show", () => form.classList.add("is-open"))
    .on("hide", () => form.classList.remove("is-open"))
    .on("save", (color, instance) => {
      form.querySelector("input.value").value = color.toHEXA().toString();
      form.dispatchEvent(
        new CustomEvent("template-local-changed", {
          bubbles: true,
          detail: { group: "colors" },
        })
      );
      fetch(withAjax(window.location.href), {
        method: "post",
        body: new URLSearchParams(new FormData(form)), // for application/x-www-form-urlencoded
      }).then(handleAjaxSaveResponse);

      // close pickr after save
      instance.hide();
    })
    .on("change", (color, instance) => {
      form.querySelector(".previous").style.background = color.toHEXA();
    });
});
