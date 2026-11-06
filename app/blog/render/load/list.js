module.exports = function (list) {
  if (!Array.isArray(list)) return [];

  const len = list.length;

  if (len > 0 && list[0] && typeof list[0] === "object") {
    list[0].first = true;
  }
  if (len > 0 && list[len - 1] && typeof list[len - 1] === "object") {
    list[len - 1].last = true;
  }
  if (len > 2 && list[len - 2] && typeof list[len - 2] === "object") {
    list[len - 2].penultimate = true;
  }

  for (let i = 0; i < len; i++) {
    if (list[i] && typeof list[i] === "object") {
      list[i].position = i + 1; // 1-based index
    }
  }

  return list;
};
