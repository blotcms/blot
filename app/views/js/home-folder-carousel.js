const initHomeFolderCarousel = (carousel) => {
  const viewport = carousel.querySelector(".home-folder-viewport");
  const track = carousel.querySelector(".home-folder-track");
  const previous = carousel.querySelector("[data-home-folder-prev]");
  const next = carousel.querySelector("[data-home-folder-next]");
  const cards = Array.from(track ? track.children : []);

  if (!viewport || !track || !previous || !next || cards.length < 2) return;

  const cloneCount = Math.min(4, cards.length);
  const before = cards.slice(-cloneCount).map((card) => {
    const clone = card.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    return clone;
  });
  const after = cards.slice(0, cloneCount).map((card) => {
    const clone = card.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    return clone;
  });

  track.prepend(...before);
  track.append(...after);

  let position = cloneCount;
  let moving = false;
  const pendingMoves = [];
  let timer = null;
  let paused = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const setActiveCard = () => {
    Array.from(track.children).forEach((card, index) => {
      card.classList.toggle("is-active", index === position);
    });
  };

  const getPositionTransform = () => {
    const activeCard = track.children[position];

    const viewportStyles = window.getComputedStyle(viewport);
    const trackOffset = track.offsetLeft + parseFloat(viewportStyles.paddingLeft || "0");
    const activeCardCenter = trackOffset + activeCard.offsetLeft + activeCard.offsetWidth / 2;
    const viewportCenter = viewport.clientWidth / 2;

    return `translate3d(${viewportCenter - activeCardCenter}px, 0, 0)`;
  };

  const setPosition = (animate, transform) => {
    track.style.transition = animate && !reducedMotion
      ? "transform 650ms cubic-bezier(0.22, 1, 0.36, 1)"
      : "none";
    track.style.transform = transform || getPositionTransform();
  };

  const getTransitionTarget = (nextPosition) => {
    if (reducedMotion) {
      position = nextPosition;
      setActiveCard();
      return getPositionTransform();
    }

    const previousPosition = position;
    track.classList.add("is-measuring");

    position = nextPosition;
    setActiveCard();
    track.offsetWidth;
    const transform = getPositionTransform();

    position = previousPosition;
    setActiveCard();
    track.offsetWidth;
    track.classList.remove("is-measuring");

    position = nextPosition;
    setActiveCard();

    return transform;
  };

  const normalizePosition = () => {
    let wrapped = false;

    if (position >= cloneCount + cards.length) {
      position -= cards.length;
      wrapped = true;
    }

    if (position < cloneCount) {
      position += cards.length;
      wrapped = true;
    }

    if (wrapped) {
      setActiveCard();
      setPosition(false);
    }
  };

  const goTo = (nextPosition) => {
    if (moving || nextPosition < 0 || nextPosition >= track.children.length) return;

    moving = true;
    const transform = getTransitionTarget(nextPosition);
    setPosition(true, transform);

    if (reducedMotion) {
      moving = false;
      normalizePosition();
      resetTimer();
    }
  };

  const resetTimer = () => {
    if (timer) window.clearInterval(timer);
    timer = null;

    if (!reducedMotion && !paused) {
      timer = window.setInterval(() => move(1), 4800);
    }
  };

  const move = (direction) => {
    if (moving) {
      pendingMoves.push(direction);
      return;
    }

    goTo(position + direction);
  };

  track.addEventListener("transitionend", (event) => {
    if (event.target !== track) return;

    normalizePosition();
    moving = false;

    if (pendingMoves.length) {
      move(pendingMoves.shift());
    } else {
      resetTimer();
    }
  });

  previous.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));

  track.addEventListener("click", (event) => {
    const card = event.target.closest(".home-folder-card");
    if (!card || !track.contains(card)) return;

    const clickedPosition = Array.from(track.children).indexOf(card);
    if (clickedPosition === -1) return;

    if (clickedPosition === position) {
      if (!event.target.closest("a")) {
        const link = card.querySelector(".home-folder-card-site");
        if (link) link.click();
      }
      return;
    }

    event.preventDefault();
    goTo(clickedPosition);
  });

  carousel.addEventListener("mouseenter", () => {
    paused = true;
    resetTimer();
  });

  carousel.addEventListener("mouseleave", () => {
    paused = false;
    resetTimer();
  });

  carousel.addEventListener("focusin", () => {
    paused = true;
    resetTimer();
  });

  carousel.addEventListener("focusout", (event) => {
    if (!carousel.contains(event.relatedTarget)) {
      paused = false;
      resetTimer();
    }
  });

  window.addEventListener("resize", () => {
    if (moving) return;
    setPosition(false);
  });

  setActiveCard();
  setPosition(false);
  resetTimer();
  carousel.classList.remove("is-initializing");
};

document.querySelectorAll("[data-home-folder-carousel]").forEach(initHomeFolderCarousel);
