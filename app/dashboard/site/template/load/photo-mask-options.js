const { SHAPES, normalizeShape, shapeIcon } = require("../../../../build/thumbnail/image-mask");

module.exports = function photoMaskOptions(mask) {
  let selectedMask;
  try { selectedMask = normalizeShape(mask); } catch (_) { selectedMask = "square"; }
  return SHAPES.map(({ value, label }) => ({ value, label, icon: shapeIcon(value), selected: value === selectedMask }));
};
