const PHOTO_MASKS = [
  { value: "square", label: "Square", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="1" /></svg>' },
  { value: "circle", label: "Circle", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>' },
  { value: "rounded-square", label: "Rounded square", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /></svg>' },
  { value: "squircle", label: "Squircle", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c5.7 0 9.5 3.8 9.5 9.5s-3.8 9.5-9.5 9.5S2.5 17.7 2.5 12 6.3 2.5 12 2.5Z" /></svg>' },
  { value: "hexagon", label: "Hexagon", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 21 7v10l-9 5-9-5V7l9-5Z" /></svg>' },
  { value: "arch", label: "Arch", icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21V12a9 9 0 0 1 18 0v9H3Z" /></svg>' },
];

module.exports = function photoMaskOptions(mask) {
  const selectedMask = PHOTO_MASKS.some((option) => option.value === mask) ? mask : "square";
  return PHOTO_MASKS.map((option) => ({ ...option, selected: option.value === selectedMask }));
};
