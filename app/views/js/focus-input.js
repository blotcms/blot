const inputToFocus = document.querySelector("input[autofocus]");

if (inputToFocus) {
  inputToFocus.focus();
  inputToFocus.select();
}
