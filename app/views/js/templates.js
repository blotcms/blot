const shuffle = (array) => {
  for (let index = array.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [array[index], array[randomIndex]] = [array[randomIndex], array[index]];
  }

  return array;
};

const initTemplateHero = () => {
  const hero = document.querySelector(".templates-hero");

  if (!hero) return;

  const grid = hero.querySelector(".templates-hero-grid");
  const images = Array.from(hero.querySelectorAll(".templates-hero-image"));
  const fadeStart = performance.now();
  const shuffledImages = shuffle([...images]);

  hero.classList.add("templates-hero-animations-enabled");

  images.forEach((image, index) => {
    const plannedDelay = index * 0.025 + Math.random() * 0.1;
    let started = false;

    const startImage = () => {
      if (started) return;
      started = true;

      const elapsed = (performance.now() - fadeStart) / 1000;
      const remaining = Math.max(0, plannedDelay - elapsed);

      window.setTimeout(() => {
        image.classList.add("templates-hero-image-ready");
      }, remaining * 1000);
    };

    const sourceImage = Array.from(image.querySelectorAll("img")).find(
      (candidate) => getComputedStyle(candidate).display !== "none"
    );

    if (!sourceImage || sourceImage.complete) {
      startImage();
      return;
    }

    sourceImage.addEventListener("load", startImage, { once: true });
    sourceImage.addEventListener("error", startImage, { once: true });
  });

  shuffledImages.forEach((image) => grid.appendChild(image));
};

initTemplateHero();
