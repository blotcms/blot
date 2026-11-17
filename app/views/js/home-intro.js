const typed = document.querySelector("[data-home-example]");

if (typed) {
  const example = typed.parentElement;
  const phrases = [
    typed.textContent,
    "journal with Google Docs",
    "company site using Microsoft Word",
    "travel journal with Ulysses",
    "photo essay using Lightroom",
    "documentation site with VS Code",
    "blog using Obsidian",
  ];

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  let current = 0;
  let animation;

  async function rotate(signal) {
    while (!signal.aborted) {
      await wait(3600);
      if (signal.aborted) return;
      example.classList.add("is-selected");
      await wait(380);
      if (signal.aborted) return;

      example.classList.remove("is-selected");
      example.classList.add("is-typing");
      typed.textContent = "";
      current = (current + 1) % phrases.length;
      await wait(160);

      for (const character of phrases[current]) {
        if (signal.aborted) return;
        typed.textContent += character;
        await wait(character === " " ? 115 : 65);
      }

      if (signal.aborted) return;
      example.classList.remove("is-typing");
    }
  }

  function syncAnimation() {
    if (document.hidden || motion.matches) {
      animation?.abort();
      animation = undefined;
      example.classList.remove("is-animated", "is-selected", "is-typing");
      typed.textContent = phrases[motion.matches ? 0 : current];
      return;
    }

    if (animation) return;
    animation = new AbortController();
    example.classList.add("is-animated");
    void rotate(animation.signal);
  }

  document.addEventListener("visibilitychange", syncAnimation);
  motion.addEventListener("change", syncAnimation);
  syncAnimation();
}
