var form = document.querySelector(".authenticate-container form");

if (!form) {
  return;
}

var reset = form.querySelector("#reset");
var email = form.querySelector('input[name="email"]');

if (!reset || !email) {
  return;
}

var updateReset = function () {
  reset.href = "/log-in/reset?email=" + encodeURIComponent(email.value);
};

email.addEventListener("change", updateReset);
email.addEventListener("input", updateReset);
