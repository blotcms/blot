let instance;

function createFontPicker() {
  let container = document.querySelector("[data-template-font-picker]");

  if (!container) {
    container = document.createElement("div");
    container.className = "template-font-picker";
    container.dataset.templateFontPicker = "true";
    container.hidden = true;
    container.innerHTML =
      "<div data-font-picker-filters></div><div data-font-picker-options></div>";
  }

  if (container.parentElement !== document.body) {
    document.body.appendChild(container);
  }

  if (!container.hasAttribute("tabindex")) {
    container.setAttribute("tabindex", "-1");
  }

  container.setAttribute("aria-hidden", container.hidden ? "true" : "false");

  const filtersRoot = container.querySelector("[data-font-picker-filters]");
  const optionsRoot = container.querySelector("[data-font-picker-options]");

  const filterButtons = filtersRoot
    ? Array.from(filtersRoot.querySelectorAll("[data-font-picker-filter]"))
    : [];
  const optionButtons = optionsRoot
    ? Array.from(optionsRoot.querySelectorAll("[data-font-option-id]"))
    : [];

  let currentFilter = filtersRoot
    ? filtersRoot.dataset.fontPickerDefaultFilter || "all"
    : "all";
  let activeContext = null;
  let hideTimer = null;

  const cancelHide = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const scheduleHide = () => {
    cancelHide();
    hideTimer = setTimeout(() => {
      hide();
    }, 150);
  };

  const applyFilter = (filter) => {
    currentFilter = filter;
    filterButtons.forEach((button) => {
      const isActive = button.dataset.fontPickerFilter === filter;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    optionButtons.forEach((button) => {
      const tags = (button.dataset.fontTags || "").split(" ").filter(Boolean);
      const shouldShow = filter === "all" || tags.indexOf(filter) > -1;
      button.style.display = shouldShow ? 'block' : 'none';
    });

    if (optionsRoot) {
      optionsRoot.scrollTop = 0;
    }
  };

  const position = (anchor) => {
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const scrollY = window.scrollY || window.pageYOffset;
    const scrollX = window.scrollX || window.pageXOffset;

    const top = scrollY + rect.bottom + 6;

    container.style.minWidth = rect.width + "px";

    const viewportWidth =
      document.documentElement.clientWidth || window.innerWidth;

    const containerWidth = container.offsetWidth;
    let left = scrollX + rect.left;

    const maxLeft = scrollX + viewportWidth - containerWidth - 16;
    const minLeft = scrollX + 8;

    if (!Number.isNaN(maxLeft)) {
      left = Math.min(left, maxLeft);
    }

    left = Math.max(left, minLeft);

    container.style.top = top + "px";
    container.style.left = left + "px";
  };

  const hide = () => {
    cancelHide();
    if (!activeContext) {
      container.hidden = true;
      container.classList.remove("is-visible");
      container.setAttribute("aria-hidden", "true");
      return;
    }

    const context = activeContext;
    activeContext = null;

    container.hidden = true;
    container.classList.remove("is-visible");
    container.setAttribute("aria-hidden", "true");

    if (context.onHide) {
      context.onHide();
    }
  };

  const show = (context) => {
    if (!context || !context.anchor) return;

    cancelHide();

    if (
      activeContext &&
      activeContext.onHide &&
      activeContext.anchor !== context.anchor
    ) {
      activeContext.onHide();
    }

    activeContext = context;
    container.hidden = false;
    container.classList.add("is-visible");
    container.setAttribute("aria-hidden", "false");
    // highlightSelection(context.currentValue);

    requestAnimationFrame(() => {
      position(context.anchor);
    });
  };

  filterButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      applyFilter(button.dataset.fontPickerFilter || "all");
    });
  });

  optionButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (!activeContext) return;

      const option = {
        id: button.dataset.fontOptionId,
        html: button.innerHTML.trim(),
      };

      if (activeContext.onSelect) {
        activeContext.onSelect(option);
      }

      hide();
    });
  });

  if (filtersRoot && !filterButtons.length) {
    currentFilter = "all";
  }

  applyFilter(currentFilter);

  document.addEventListener("click", (event) => {
    if (!activeContext) return;
    const anchor = activeContext.anchor;
    if (container.contains(event.target)) return;
    if (anchor && anchor.contains(event.target)) return;
    hide();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hide();
    }
  });

  const reposition = () => {
    if (activeContext) {
      position(activeContext.anchor);
    }
  };

  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);

  return {
    show,
    hide,
    scheduleHide,
    cancelHide,
  };
}

module.exports = function getFontPicker() {
  if (!instance) {
    instance = createFontPicker();
  }

  return instance;
};
