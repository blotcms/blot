const SHAPES = new Set(["square", "circle", "rounded-square", "squircle", "hexagon", "arch"]);

function normalizeShape(shape) {
  const normalized = shape || "square";
  if (!SHAPES.has(normalized)) {
    const error = new Error("Please choose a supported photo shape");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function squirclePath() {
  const points = [];
  const steps = 512;
  for (let i = 0; i < steps; i += 1) {
    const angle = (Math.PI * 2 * i) / steps;
    const x = 500 + 500 * Math.sign(Math.cos(angle)) * Math.sqrt(Math.abs(Math.cos(angle)));
    const y = 500 + 500 * Math.sign(Math.sin(angle)) * Math.sqrt(Math.abs(Math.sin(angle)));
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `${points.join(" ")} Z`;
}

const SQUIRCLE_PATH = squirclePath();

function shapeMask(width, height, shape) {
  const geometry = {
    circle: '<circle cx="500" cy="500" r="500"/>',
    "rounded-square": '<rect x="0" y="0" width="1000" height="1000" rx="200"/>',
    squircle: `<path d="${SQUIRCLE_PATH}"/>`,
    hexagon: '<path d="M500 0 933 250 933 750 500 1000 67 750 67 250Z"/>',
    arch: '<path d="M0 1000V500A500 500 0 0 1 1000 500V1000Z"/>',
  }[normalizeShape(shape)];
  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><g fill="white">${geometry}</g></svg>`
  );
}

module.exports = { normalizeShape, shapeMask };
