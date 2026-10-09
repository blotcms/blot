// Add copy-link anchors to .entry headings and wire behavior
function renderHeadingAnchors () {
  const headings = document.querySelectorAll(
    '.entry h1, .entry h2, .entry h3, .entry h4, .entry h5, .entry h6'
  );

  // Ensure a single toast container
  let toastRoot = document.querySelector('#toast-root');
  if (!toastRoot) {
    toastRoot = document.createElement('div');
    toastRoot.id = 'toast-root';
    document.body.appendChild(toastRoot);
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastRoot.appendChild(t);
    // force reflow to enable transition
    void t.offsetWidth;
    t.classList.add('toast--in');

    const hide = () => {
      t.classList.remove('toast--in');
      t.classList.add('toast--out');
      t.addEventListener('transitionend', () => t.remove(), { once: true });
    };
    setTimeout(hide, 1800);
  }

  function fullUrlWithHash(id) {
    const u = new URL(window.location.href);
    u.hash = id;
    return u.toString();
  }

  headings.forEach(h => {
    const entry = h.closest('.entry[data-permalink]');
    const permalink = entry?.dataset.permalink;

    // In the Full posts index, the first heading is the post title. Link it
    // to the permalink while keeping the copy-link anchor as its own control.
    if (
      permalink &&
      h.tagName === 'H1' &&
      h.parentElement === entry &&
      h.textContent.trim() === entry.dataset.entryTitle?.trim() &&
      !h.querySelector('.entry-title-link')
    ) {
      const existingLink = h.querySelector('a');
      if (
        existingLink &&
        existingLink.textContent.trim() === entry.dataset.entryTitle?.trim()
      ) {
        existingLink.href = permalink;
        existingLink.classList.add('entry-title-link');
      } else if (!existingLink) {
        const titleLink = document.createElement('a');
        titleLink.href = permalink;
        titleLink.className = 'entry-title-link';
        while (h.firstChild) titleLink.appendChild(h.firstChild);
        h.appendChild(titleLink);
      }
    }

    if (!h.id) return;

    const a = document.createElement('a');
    const target = permalink ? new URL(permalink, window.location.href) : null;
    if (target) target.hash = h.id;
    a.href = target ? target.href : `#${h.id}`;
    a.className = 'heading-anchor';
    a.setAttribute('aria-label', 'Copy link to this section');
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!permalink) {
        // Update URL and scroll to the heading on permalink pages.
        if (h.id !== window.location.hash.slice(1)) {
          // pushState preserves scroll; setting hash may jump. Do both for robustness.
          history.pushState(null, '', `#${h.id}`);
        } else {
          // Force focus/scroll if already on the same hash
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }

      // Copy the section URL, which points to the post when used in a listing.
      const url = target ? target.href : fullUrlWithHash(h.id);
      try { await navigator.clipboard.writeText(url); } catch {}

      showToast('Link copied to your clipboard');
    });

    h.appendChild(a);
  });
}

renderHeadingAnchors();
