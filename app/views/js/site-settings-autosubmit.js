var checkboxes = document.querySelectorAll(".plugin input[type=checkbox]");

function submitForm(form) {
  if (!form) {
    return;
  }

  var xhr = new XMLHttpRequest();
  xhr.open("POST", form.action);
  xhr.onload = function () {};
  xhr.onerror = function () {};
  xhr.send(new FormData(form));
}

if (checkboxes.length) {
  checkboxes.forEach(function (checkbox) {
    checkbox.addEventListener("change", function () {
      var form = this.closest("form");
      var el = this;

      if (!el.closest(".pluginOptions")) {
        if (el.checked) {
          el.closest(".plugin").classList.add("checked");
        } else {
          el.closest(".plugin").classList.remove("checked");
        }
      }

      submitForm(form);
    });
  });
}
