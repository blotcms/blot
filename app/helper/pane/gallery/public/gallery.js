// The gallery's controls. The server renders the first state; this keeps it in step with
// the URL (?os=mac|win|linux&theme=light|dark|both) without reloading.
(function () {
  const root = document.documentElement;
  const state = { os: root.dataset.os, mode: root.dataset.mode };

  function url() {
    return `?os=${state.os}&theme=${state.mode}`;
  }

  function showRef(ref) {
    const src = ref.getAttribute(`data-ref-${state.os}`);
    const img = ref.querySelector("img");
    const note = ref.querySelector(".note");
    if (src) {
      if (img.getAttribute("src") !== src) img.src = src;
    } else {
      img.removeAttribute("src");
    }
    img.hidden = !src;
    note.hidden = !!src;
  }

  // In overlay the reference is absolutely placed, so the stage must be as big as it.
  function fitAll() {
    document.querySelectorAll(".stage").forEach((stage) => {
      const overlay = stage.closest("section").dataset.compare === "overlay";
      const ref = stage.querySelector(".ref");
      stage.style.minWidth = overlay && ref ? `${ref.offsetWidth + 4}px` : "";
      stage.style.minHeight = overlay && ref ? `${ref.offsetHeight + 4}px` : "";
    });
  }

  function apply() {
    root.dataset.os = state.os;
    root.dataset.mode = state.mode;
    document.querySelectorAll(".tabs a").forEach((a) => {
      a.setAttribute("aria-selected", String(a.dataset.os === state.os));
      a.href = `?os=${a.dataset.os}&theme=${state.mode}`;
    });
    document.querySelectorAll(".modes button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
    });
    document.querySelectorAll(".ref").forEach(showRef);
    history.replaceState(null, "", url() + location.hash);
    fitAll();
  }

  document.querySelectorAll(".tabs a").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      state.os = a.dataset.os;
      apply();
    })
  );
  document.querySelectorAll(".modes button").forEach((b) =>
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      apply();
    })
  );

  // The layout keeps changing until the reference captures have loaded: keep the #fragment's
  // section in view until the reader scrolls.
  const anchor = window.paneKeepAnchor(window, document);

  // References are 2x captures, shown at half size.
  document.querySelectorAll(".ref img").forEach((img) => {
    const size = () => {
      if (img.naturalWidth) img.style.width = `${img.naturalWidth / 2}px`;
      fitAll();
      anchor.go();
    };
    img.addEventListener("load", size);
    size();
  });

  document.querySelectorAll("section").forEach((section) => {
    const slider = section.querySelector(".blend input");
    const label = section.querySelector(".blend");
    section.querySelectorAll("[data-compare]").forEach((button) => {
      if (button === section) return;
      button.addEventListener("click", () => {
        section.dataset.compare = button.dataset.compare;
        section
          .querySelectorAll(".compare button")
          .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        label.hidden = button.dataset.compare !== "overlay";
        fitAll();
      });
    });
    if (slider)
      slider.addEventListener("input", () =>
        section.style.setProperty("--blend", slider.value / 100)
      );
  });

  anchor.go();
  window.addEventListener("load", anchor.go);
  setTimeout(anchor.stop, 5000);

  if (window.EventSource) {
    const events = new EventSource("/events");
    events.onmessage = () => location.reload();
  }
})();
