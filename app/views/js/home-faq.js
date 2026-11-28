// The questions on the homepage and the pricing page (.home-faq), after the
// pattern library's FAQ "animated expansion": one answer open at a time, its
// height opening on a spring, its text fading in, the plus turning into a
// minus (css/home.css). Each question is a <details>, so without this script
// they still open and close; with reduced motion they open at once.

const springValue = require("./spring.js");

const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Seconds the answer's height takes to settle
const OPEN = 0.5;
const CLOSE = 0.4;

const enhance = (list) => {
  list.classList.add("faq-js");
  const items = [...list.querySelectorAll(":scope > details")];

  const answers = items.map((item) => {
    // The answer's paragraphs, in a wrapper whose height is animated
    const panel = document.createElement("div");
    const inner = document.createElement("div");
    panel.className = "faq-answer";
    inner.className = "faq-answer-inner";
    [...item.childNodes]
      .filter((node) => node.nodeName !== "SUMMARY")
      .forEach((node) => inner.appendChild(node));
    panel.appendChild(inner);
    item.appendChild(panel);

    const height = springValue(0, (v) => {
      panel.style.height = v + "px";
    });

    if (item.open) {
      item.classList.add("is-open");
      panel.style.height = "auto";
    }

    return { item, panel, inner, height };
  });

  const set = (answer, open) => {
    const { item, panel, inner, height } = answer;
    if (open === item.classList.contains("is-open")) return;
    item.classList.toggle("is-open", open);

    if (motion.matches) {
      item.open = open;
      panel.style.height = open ? "auto" : "0px";
      return;
    }

    // Start from the height on screen, mid-animation or not
    height.set(panel.getBoundingClientRect().height);

    if (open) {
      item.open = true;
      height.to(inner.scrollHeight, OPEN, () => {
        if (item.classList.contains("is-open")) panel.style.height = "auto";
      });
    } else {
      // Stays open until the answer has closed, so it stays visible
      height.to(0, CLOSE, () => {
        if (!item.classList.contains("is-open")) item.open = false;
      });
    }
  };

  answers.forEach((answer) => {
    answer.item.querySelector("summary").addEventListener("click", (event) => {
      event.preventDefault();
      const open = !answer.item.classList.contains("is-open");
      answers.forEach((other) => set(other, open && other === answer));
    });
  });
};

document.querySelectorAll(".home-faq").forEach(enhance);
