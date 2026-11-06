const initCopyButtons = function () {
  const copyButtons = document.querySelectorAll("button.copy");

  const copyWithTextArea = function (text) {
    const auxiliary = document.createElement("textarea");
    auxiliary.setAttribute("readonly", "");
    auxiliary.style.position = "fixed";
    auxiliary.style.left = "-9999px";
    auxiliary.value = text;
    document.body.appendChild(auxiliary);

    try {
      auxiliary.select();
      return document.execCommand("copy");
    } catch (error) {
      return false;
    } finally {
      document.body.removeChild(auxiliary);
    }
  };

  const copyText = function (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(
          function () {
            return true;
          },
          function () {
            return copyWithTextArea(text);
          }
        );
      }
    } catch (error) {
      return Promise.resolve(copyWithTextArea(text));
    }

    return Promise.resolve(copyWithTextArea(text));
  };

  copyButtons.forEach(function (button) {
    // check that the attribute 'data-copy-init' is unset
    if (button.getAttribute("data-copy-init") === "true") {
      return; // already initialized
    }

    // set the attribute 'data-copy-init' to true
    button.setAttribute("data-copy-init", "true");

    button.addEventListener("click", function (event) {
      // ensure all other copy buttons are reset
      copyButtons.forEach(function (button) {
        button.classList.remove("copied");
        button.innerHTML = button.innerHTML.replace("Copied", "Copy");
      });

      const target = event.currentTarget;
      // get the text from the attribute 'data-copy' or
      // from the text node previous to the button
      const text =
        target.getAttribute("data-copy") ||
        target.previousSibling.textContent.trim();
      const originalText = target.innerHTML;

      copyText(text).then(function (copied) {
        if (!copied) return;

        // replace 'Copy' in the button with 'Copied!'
        target.classList.add("copied");
        target.innerHTML = originalText.replace("Copy", "Copied");
        setTimeout(function () {
          target.classList.remove("copied");
          target.innerHTML = originalText;
        }, 2000);
      });
    });
  });
};

initCopyButtons();

window.initCopyButtons = initCopyButtons;
