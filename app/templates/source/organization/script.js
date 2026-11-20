// Plugins' scripts. The comment keeps code formatters from rewriting the tag.
// prettier-ignore
{{{app_js}}}

// The Organization template's own script: the site title sized to the page,
// runs of images as carousels, and questions (<details>) that spring open.
// Everything works without it: the title has a size relative to the page,
// carousels scroll sideways and snap, and questions open instantly. The
// springs are the motion library's (template-patterns assets/motion), trimmed.
(function () {
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // A damped spring (mass 1, stiffness ω², damping 2ζω) from (x0, v0) toward
  // target after t seconds. Returns [position, velocity].
  function spring(x0, v0, target, p, t) {
    var a = x0 - target;
    var decay = Math.exp(-p.zeta * p.omega * t);
    if (p.zeta === 1) {
      var b1 = v0 + p.omega * a;
      return [target + (a + b1 * t) * decay, (v0 - p.omega * b1 * t) * decay];
    }
    if (p.zeta > 1) {
      var r = p.omega * Math.sqrt(p.zeta * p.zeta - 1);
      var r1 = -p.zeta * p.omega + r;
      var r2 = -p.zeta * p.omega - r;
      var c2 = (v0 - r1 * a) / (r2 - r1);
      var c1 = a - c2;
      var e1 = Math.exp(r1 * t);
      var e2 = Math.exp(r2 * t);
      return [target + c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2];
    }
    var wd = p.omega * Math.sqrt(1 - p.zeta * p.zeta);
    var b = (v0 + p.zeta * p.omega * a) / wd;
    var cos = Math.cos(wd * t);
    var sin = Math.sin(wd * t);
    return [
      target + decay * (a * cos + b * sin),
      decay *
        ((b * wd - p.zeta * p.omega * a) * cos -
          (a * wd + p.zeta * p.omega * b) * sin),
    ];
  }

  // A value that animates on springs, keeping its velocity when retargeted.
  // With reduced motion it jumps straight to its target.
  function createValue(onUpdate, precision) {
    var frame = null;
    var state = {
      value: 0,
      velocity: 0,
      running: false,
      stop: function () {
        if (frame) cancelAnimationFrame(frame);
        frame = null;
        state.running = false;
      },
      set: function (value) {
        state.stop();
        state.value = value;
        state.velocity = 0;
        onUpdate(value);
      },
      to: function (target, params, done) {
        state.stop();
        if (reduceMotion.matches) {
          state.set(target);
          if (done) done();
          return;
        }
        var from = state.value;
        var velocity = state.velocity;
        var start = performance.now();
        var eps = precision || 0.01;
        state.running = true;
        var tick = function () {
          var next = spring(
            from,
            velocity,
            target,
            params,
            (performance.now() - start) / 1000
          );
          var settled =
            Math.abs(next[0] - target) < eps && Math.abs(next[1]) < eps * 20;
          state.value = settled ? target : next[0];
          state.velocity = settled ? 0 : next[1];
          onUpdate(state.value);
          if (settled) {
            frame = null;
            state.running = false;
            if (done) done();
          } else frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
    };
    return state;
  }

  var presets = {
    page: { omega: 13.27, zeta: 1 },
    stripTap: { omega: 33.1, zeta: 1.132 },
    // The animated-expansion pattern's springs, from its mass, damping and stiffness
    height: {
      omega: Math.sqrt(280 / 0.2),
      zeta: 18 / (2 * Math.sqrt(280 * 0.2)),
    },
    text: {
      omega: Math.sqrt(200 / 0.5),
      zeta: 18 / (2 * Math.sqrt(200 * 0.5)),
    },
  };

  // The site title: as wide as the page, whatever the font.
  document.querySelectorAll(".fit").forEach(function (fit) {
    var resize = function () {
      // Width isn't quite proportional to size at small sizes (hinting), so
      // measure again at the first estimate and correct once.
      var target = fit.parentElement.clientWidth;
      var size = 100;
      for (var pass = 0; pass < 2; pass++) {
        fit.style.fontSize = size + "px";
        size = size * (target / fit.getBoundingClientRect().width);
      }
      fit.style.fontSize = Math.floor(size * 100) / 100 + "px";
    };
    if (window.ResizeObserver)
      new ResizeObserver(resize).observe(fit.parentElement);
    if (document.fonts) document.fonts.ready.then(resize);
    resize();
  });

  // The tags in the menu: one the menu already links to goes, and the one
  // whose page you're on gets the dot. (The menu's own links are marked by
  // Blot.)
  var menuPaths = {};
  document.querySelectorAll(".bar .is-menu a").forEach(function (link) {
    menuPaths[link.pathname.replace(/\/$/, "")] = true;
  });
  var here = window.location.pathname.replace(/\/page\/\d+\/?$/, "");
  document.querySelectorAll(".bar .is-tag a").forEach(function (link) {
    var path = link.pathname.replace(/\/$/, "");
    if (menuPaths[path]) return link.parentNode.remove();
    if (decodeURI(here) === decodeURI(path)) link.classList.add("is-current");
  });

  // More in the menu closes when you click elsewhere or press Escape.
  document.querySelectorAll(".bar-more details").forEach(function (more) {
    document.addEventListener("click", function (event) {
      if (more.open && !more.contains(event.target)) more.open = false;
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && more.open) {
        more.open = false;
        more.querySelector("summary").focus();
      }
    });
  });

  // Carousels: a paragraph holding two or more images (a run of images on
  // consecutive lines in a post) becomes a strip with a counter, the
  // image's caption, and previous and next buttons. Drag, flick, scroll or
  // use the arrow keys; it always comes to rest on an image.
  document.querySelectorAll(".text p").forEach(function (p) {
    var images = Array.prototype.filter.call(p.children, function (el) {
      return el.tagName === "IMG";
    });
    var others = Array.prototype.filter.call(p.children, function (el) {
      return (
        el.tagName !== "IMG" &&
        !el.classList.contains("caption") &&
        el.tagName !== "BR"
      );
    });
    // Writing in the paragraph itself (not in a caption) means it isn't a
    // run of images: converting it would drop the words
    var words = Array.prototype.some.call(p.childNodes, function (node) {
      return node.nodeType === 3 && node.nodeValue.trim();
    });
    if (images.length < 2 || others.length || words) return;

    var figure = document.createElement("figure");
    figure.className = "carousel";
    var track = document.createElement("div");
    track.className = "carousel-track";
    track.tabIndex = 0;
    track.setAttribute("role", "group");
    track.setAttribute("aria-roledescription", "carousel");
    track.setAttribute("aria-label", images.length + " images");

    var captions = images.map(function (img) {
      var slide = document.createElement("figure");
      slide.className = "carousel-slide";
      var next = img.nextElementSibling;
      var caption =
        next && next.classList.contains("caption") ? next.textContent : img.alt;
      img.loading = "lazy";
      img.draggable = false;
      slide.appendChild(img);
      track.appendChild(slide);
      return caption || "";
    });

    var figcaption = document.createElement("figcaption");
    var count = document.createElement("span");
    count.className = "carousel-count";
    var text = document.createElement("span");
    text.className = "carousel-caption";
    var buttons = document.createElement("span");
    buttons.className = "carousel-buttons";
    var previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "←";
    previous.setAttribute("aria-label", "Previous image");
    var next = document.createElement("button");
    next.type = "button";
    next.textContent = "→";
    next.setAttribute("aria-label", "Next image");
    buttons.appendChild(previous);
    buttons.appendChild(next);
    figcaption.appendChild(count);
    figcaption.appendChild(text);
    figcaption.appendChild(buttons);
    figure.appendChild(track);
    figure.appendChild(figcaption);
    p.replaceWith(figure);

    // The script takes over snapping from CSS, so a spring can glide between images.
    track.style.scrollSnapType = "none";
    var slides = Array.prototype.slice.call(track.children);
    var current = -1;
    var position = createValue(function (x) {
      track.scrollLeft = x;
    }, 0.5);

    var maxScroll = function () {
      return track.scrollWidth - track.clientWidth;
    };
    var offset = function (i) {
      return Math.min(slides[i].offsetLeft - track.offsetLeft, maxScroll());
    };
    var nearest = function (x) {
      var best = 0;
      slides.forEach(function (slide, i) {
        if (Math.abs(offset(i) - x) < Math.abs(offset(best) - x)) best = i;
      });
      return best;
    };
    var show = function (i) {
      if (i === current) return;
      current = i;
      count.textContent = i + 1 + " / " + slides.length;
      text.textContent = captions[i];
      previous.disabled = i === 0;
      next.disabled = i === slides.length - 1;
    };
    var goTo = function (i, params) {
      i = Math.max(0, Math.min(slides.length - 1, i));
      show(i);
      if (!position.running) position.value = track.scrollLeft;
      position.to(offset(i), params || presets.page);
    };

    show(0);
    previous.addEventListener("click", function () {
      goTo(current - 1);
    });
    next.addEventListener("click", function () {
      goTo(current + 1);
    });
    track.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft") goTo(current - 1);
      else if (event.key === "ArrowRight") goTo(current + 1);
      else return;
      event.preventDefault();
    });

    // Wheel, trackpad and touch scroll natively; once they stop, spring to the nearest image.
    var settleTimer;
    track.addEventListener("scroll", function () {
      if (position.running || dragging) return;
      show(nearest(track.scrollLeft));
      clearTimeout(settleTimer);
      settleTimer = setTimeout(function () {
        if (!dragging && !position.running)
          goTo(nearest(track.scrollLeft), presets.stripTap);
      }, 120);
    });

    // A mouse drag moves the strip; a flick carries on as far as its speed would
    // take it (UIScrollView's deceleration), then springs to that image.
    var dragging = false;
    var startX = 0;
    var startScroll = 0;
    var samples = [];
    track.addEventListener("pointerdown", function (event) {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      dragging = true;
      position.stop();
      startX = event.clientX;
      startScroll = track.scrollLeft;
      samples = [{ t: event.timeStamp, x: event.clientX }];
      track.setPointerCapture(event.pointerId);
      track.classList.add("is-dragging");
    });
    track.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      track.scrollLeft = startScroll - (event.clientX - startX);
      samples.push({ t: event.timeStamp, x: event.clientX });
      samples = samples.filter(function (s) {
        return event.timeStamp - s.t < 100;
      });
      show(nearest(track.scrollLeft));
    });
    var release = function (event) {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("is-dragging");
      var first = samples[0];
      var last = samples[samples.length - 1];
      var vx =
        first && last && last.t > first.t
          ? ((last.x - first.x) / (last.t - first.t)) * 1000
          : 0;
      if (event.timeStamp - (last ? last.t : 0) > 100) vx = 0;
      var projected = track.scrollLeft - ((vx / 1000) * 0.998) / (1 - 0.998);
      position.value = track.scrollLeft;
      position.velocity = -vx;
      goTo(nearest(projected), presets.page);
    };
    track.addEventListener("pointerup", release);
    track.addEventListener("pointercancel", release);
    window.addEventListener("resize", function () {
      position.set(offset(current));
    });
  });

  // Questions: <details> in a post spring open and closed, and the answer fades in.
  document.querySelectorAll(".text details").forEach(function (details) {
    var summary = details.querySelector("summary");
    if (!summary) return;
    var height = createValue(function (h) {
      details.style.height = h + "px";
    }, 0.2);
    // Everything after the question, wrapped in one element so it can be
    // measured and faded, whether it is bare text or paragraphs.
    var wrapper = document.createElement("div");
    wrapper.className = "answer";
    while (summary.nextSibling) wrapper.appendChild(summary.nextSibling);
    details.appendChild(wrapper);
    var answer = [wrapper];
    details.style.overflow = "hidden";

    summary.addEventListener("click", function (event) {
      event.preventDefault();
      var opening = !details.open || details.classList.contains("is-closing");
      var from = details.getBoundingClientRect().height;
      details.classList.remove("is-closing");
      if (opening) {
        details.open = true;
        var to =
          summary.offsetHeight +
          answer.reduce(function (sum, el) {
            var style = getComputedStyle(el);
            return (
              sum +
              el.offsetHeight +
              parseFloat(style.marginTop) +
              parseFloat(style.marginBottom)
            );
          }, 0);
        answer.forEach(function (el) {
          el.style.opacity = "0";
          el.style.transition = reduceMotion.matches
            ? "opacity 160ms ease"
            : "opacity 300ms ease 100ms";
          requestAnimationFrame(function () {
            el.style.opacity = "1";
          });
        });
        if (!height.running) height.value = from;
        height.to(to, presets.height, function () {
          details.style.height = "";
        });
      } else {
        details.classList.add("is-closing");
        answer.forEach(function (el) {
          el.style.transition = "opacity 120ms ease";
          el.style.opacity = "0";
        });
        if (!height.running) height.value = from;
        height.to(summary.offsetHeight, presets.height, function () {
          if (details.classList.contains("is-closing")) {
            details.open = false;
            details.classList.remove("is-closing");
            details.style.height = "";
          }
        });
      }
    });
  });

  // Contents (Contents: yes on a page): a numbered list of the page's
  // sections in its margin, which marks the section you're reading.
  document.querySelectorAll("[data-contents] .text").forEach(function (text) {
    var headings = Array.prototype.filter.call(text.children, function (el) {
      return el.tagName === "H2" && el.id;
    });
    if (headings.length < 2) return;

    var nav = document.createElement("nav");
    nav.className = "contents";
    nav.setAttribute("aria-label", "Contents");
    var label = document.createElement("span");
    label.className = "quiet";
    label.textContent = "Contents";
    var list = document.createElement("ol");
    var links = headings.map(function (heading) {
      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = "#" + heading.id;
      link.textContent = heading.textContent;
      item.appendChild(link);
      list.appendChild(item);
      return link;
    });
    nav.appendChild(label);
    nav.appendChild(list);
    text.insertBefore(nav, text.firstChild);

    if (!window.IntersectionObserver) return;
    var visible = new Set();
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        });
        var current = headings.filter(function (h) {
          return visible.has(h);
        })[0];
        if (!current) return;
        links.forEach(function (link, i) {
          link.classList.toggle("is-current", headings[i] === current);
        });
      },
      { rootMargin: "0px 0px -70% 0px" }
    );
    headings.forEach(function (heading) {
      observer.observe(heading);
    });
  });

  // Questions: three or more in a row get an "Open all" button above them.
  document.querySelectorAll(".text").forEach(function (text) {
    var children = Array.prototype.slice.call(text.children);
    children.forEach(function (el, i) {
      if (el.tagName !== "DETAILS") return;
      if (i > 0 && children[i - 1].tagName === "DETAILS") return;
      var run = [];
      for (
        var j = i;
        j < children.length && children[j].tagName === "DETAILS";
        j++
      )
        run.push(children[j]);
      if (run.length < 3) return;

      var button = document.createElement("button");
      button.type = "button";
      button.className = "faq-toggle";
      button.textContent = "Open all";
      button.addEventListener("click", function () {
        var open = button.textContent === "Open all";
        run.forEach(function (details) {
          if (details.open !== open) details.querySelector("summary").click();
        });
        button.textContent = open ? "Close all" : "Open all";
      });
      text.insertBefore(button, el);
    });
  });

  // Today, Tomorrow, In 5 days: beside an upcoming event's date, worked out
  // where it's read, so it is right whatever day the page was published.
  var day = 24 * 60 * 60 * 1000;
  var startOf = function (date) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    ).getTime();
  };
  document.querySelectorAll("time.relative[datetime]").forEach(function (time) {
    var when = new Date(time.getAttribute("datetime"));
    if (isNaN(when)) return;
    var days = Math.round((startOf(when) - startOf(new Date())) / day);
    if (days < 0) return;
    time.textContent =
      days === 0
        ? "Today"
        : days === 1
          ? "Tomorrow"
          : days < 14
            ? "In " + days + " days"
            : "";
  });

  // Timeline: each year once, in the margin.
  var lastYear = null;
  // The list is shown oldest first (style.css reverses it), so walk it backwards
  Array.prototype.slice
    .call(document.querySelectorAll(".timeline-item"))
    .reverse()
    .forEach(function (item) {
      var year = item.getAttribute("data-year");
      if (year === lastYear) item.classList.add("is-same-year");
      lastYear = year;
    });
})();
