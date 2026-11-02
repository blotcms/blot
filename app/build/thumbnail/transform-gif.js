// Like ./transform, for animated images: sharp is asked for every frame, the
// crop is not entropy-weighted and the ICC profile is not kept, as before.
module.exports = require("./transform").animated;
