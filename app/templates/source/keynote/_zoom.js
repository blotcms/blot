// Copied from the pattern library's assets/motion/zoom.js with its imports removed: the modules are inlined into script.js.

// Zoom a photo between two states, such as a cropped thumbnail and the photo fitted on screen.
// A state is the photo's content rect and the clip rect it shows through; both are blended by
// `progress` (0 = from, 1 = to). The photo element is placed once at `base` and moved with a
// transform and clip-path, so nothing reflows. Rects are { x, y, w, h } in viewport pixels.
//
// const zoom = createZoom(photo);
// zoom.place(base); zoom.from = fullState(thumb); zoom.to = fullState(base);
// zoom.progress.set(0); zoom.animate(1, presets.zoomOpen, done);
export function createZoom(photo) {
  const zoom = {
    base: null,
    from: null,
    to: null,
    progress: createValue({ onUpdate: () => zoom.render() }),
    place(rect) {
      zoom.base = rect;
      Object.assign(photo.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    },
    render() {
      const { base, from, to } = zoom;
      if (!base || !from || !to) return;
      const p = zoom.progress.value;
      const blend = (key, prop) => lerp(from[key][prop], to[key][prop], p);
      const x = blend("content", "x");
      const y = blend("content", "y");
      const k = blend("content", "w") / base.w;
      const cx = blend("clip", "x");
      const cy = blend("clip", "y");
      const cr = cx + blend("clip", "w");
      const cb = cy + blend("clip", "h");
      // The inset is in the photo's own, unscaled pixels.
      const inset = [cy - y, x + base.w * k - cr, y + base.h * k - cb, cx - x].map((v) => `${Math.max(0, v / k)}px`);
      photo.style.transform = `translate(${x - base.x}px, ${y - base.y}px) scale(${k})`;
      photo.style.clipPath = `inset(${inset.join(" ")})`;
    },
    // Spring progress to `target`, keeping its current velocity; settles within a quarter pixel.
    animate(target, params, done) {
      const { from, to } = zoom;
      const travel = Math.max(Math.abs(to.content.w - from.clip.w), Math.abs(to.content.y - from.clip.y), 1);
      zoom.progress.precision = 0.25 / travel;
      zoom.progress.to(target, params, done);
    },
  };
  return zoom;
}

// An uncropped photo filling `rect`.
export const fullState = (rect) => ({ content: { ...rect }, clip: { ...rect } });

// An element's rect in viewport pixels.
export function rectOf(element) {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height };
}

const asState = (value) => ("content" in value ? value : fullState(value));

// A copy of an image that flies between a thumbnail and a full view, for open and close
// transitions where the real images live in separate layouts. The copy is fixed-position inside
// `container` (put it in the dialog so it shares the top layer). While it flies, `hide` (the real
// image at either end) is hidden. Closing mid-open, or opening mid-close, reverses from wherever
// the copy is, keeping its speed; the interrupted flight's `done` never runs. With reduced
// motion there is no flight and `done` runs at once.
//
// const flyer = createFlyer(dialog);
// flyer.open({ src, from: thumbRect, to: viewerRect, hide: viewerImage, done });
// flyer.close({ src, from: thumbRect, to: viewerRect, hide: [viewerImage, thumbnail], done });
// States are rects or { content, clip } (a { content, clip } state is for cropped thumbnails); `hide` is an element
// or a list. Also { zoom, active, show(options), stop() }; see show() for drag-to-dismiss.
// To keep a flight on target while the page scrolls under it, shift zoom.from and zoom.to by
// the scroll delta and call zoom.render() (patterns/text-pages/image-zoom/ does this).
export function createFlyer(container, { open = presets.zoomOpen, close = presets.zoomClose } = {}) {
  const image = document.createElement("img");
  image.alt = "";
  image.hidden = true;
  image.draggable = false;
  Object.assign(image.style, { position: "fixed", margin: "0", maxWidth: "none", maxHeight: "none", transformOrigin: "0 0", pointerEvents: "none", zIndex: "10" });
  container.append(image);
  const zoom = createZoom(image);
  let hidden = [];

  function begin({ src, from, to, hide }) {
    if (!image.hidden) return;
    image.src = src;
    image.hidden = false;
    hidden = [hide ?? []].flat().filter(Boolean);
    for (const element of hidden) element.style.visibility = "hidden";
    zoom.place(asState(to).content);
  }

  function end(done) {
    return () => {
      image.hidden = true;
      for (const element of hidden) element.style.visibility = "";
      hidden = [];
      done?.();
    };
  }

  function fly(target, params, options) {
    if (reduceMotion.matches) {
      options.done?.();
      return;
    }
    const starting = image.hidden;
    begin(options);
    // Retargeting mid-flight (say to a different photo) hides the new ends instead.
    if (!starting && options.hide !== undefined) {
      for (const element of hidden) element.style.visibility = "";
      hidden = [options.hide].flat().filter(Boolean);
      for (const element of hidden) element.style.visibility = "hidden";
    }
    zoom.from = asState(options.from);
    if (starting) {
      zoom.to = asState(options.to);
      zoom.progress.set(1 - target);
    }
    zoom.animate(target, params, end(options.done));
  }

  return {
    // The copy's zoom (zoom.js), for handing it to a drag such as createDismiss.
    zoom,
    get active() {
      return !image.hidden;
    },
    open: (options) => fly(1, open, options),
    close: (options) => fly(0, close, options),
    // Show the copy at rest at `to` (the full view), hiding `hide`, so a drag can take it over;
    // close() then flies it home from wherever the drag left it, at the drag's speed.
    show({ src, from, to, hide }) {
      zoom.progress.stop();
      if (image.hidden) begin({ src, from, to, hide });
      zoom.from = asState(from);
      zoom.to = asState(to);
      zoom.progress.set(1);
    },
    stop() {
      zoom.progress.stop();
      end()();
    },
  };
}
