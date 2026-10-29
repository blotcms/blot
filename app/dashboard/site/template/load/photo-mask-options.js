const { SHAPES, ORGANIC_SHAPES, normalizeShape, shapeIcon } = require("../../../../build/thumbnail/image-mask");

module.exports = function photoMaskOptions(mask) {
  let selectedMask = "circle";
  if (mask) {
    try { selectedMask = normalizeShape(mask); } catch (_) { selectedMask = "circle"; }
  }
  const selectedOrganic = ORGANIC_SHAPES.includes(selectedMask);
  const organicMask = selectedOrganic ? selectedMask : ORGANIC_SHAPES[0];
  const options = [];

  for (const { value, label } of SHAPES) {
    if (["rounded-square", "wavy-star", "sunburst", "amoeba", "flower", "spiky", "splash"].includes(value) || ORGANIC_SHAPES.includes(value)) continue;
    options.push({ value, label, icon: shapeIcon(value), selected: value === selectedMask });
  }

  if (!options.some(({ value }) => value === selectedMask)) selectedMask = "square";
  for (const option of options) option.selected = option.value === selectedMask;

  options.push({
    value: organicMask,
    label: "Organic",
    icon: shapeIcon(organicMask),
    selected: selectedOrganic,
    organic: true,
    variants: ORGANIC_SHAPES.map((variant) => ({
      value: variant,
      label: SHAPES.find((shape) => shape.value === variant).label,
          name: SHAPES.find((shape) => shape.value === variant).name,
      icon: shapeIcon(variant),
          clip: SHAPES.find((shape) => shape.value === variant).clip,
    })),
  });

  return options;
};
