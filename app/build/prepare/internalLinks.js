var debug = require("debug")("blot:build:prepare:internalLinks");

// The purpose of this module is to take the HTML for
// a given blog post and work out if any of the links
// inside refer to other pages on the site.
//
// KNOWN EDGE CASE (accepted, not solved): dependencies/index.js
// resolves a relative <a href> (e.g. a link to a sibling file) to an
// absolute path. If that resolved path happens to be identical to
// some other entry's custom permalink, it's indistinguishable here
// from a real link to that entry, and produces a spurious backlink.
// This requires an exact, coincidental collision between a resolved
// file path and someone's custom permalink - extraordinarily
// unlikely - and the worst case is one wrong entry in a backlinks
// list, not a broken link or lost data. See the matching comment in
// dependencies/index.js for more.
function internalLinks($) {
	var result = [];

	$("[href]").each(function () {
		let value = $(this).attr("href");
		let normalizedValue = value;

		if (value.indexOf("/") !== 0) return;

		normalizedValue = normalizedValue.split("#")[0].split("?")[0];

		if (!normalizedValue || result.indexOf(normalizedValue) > -1) return;

		result.push(normalizedValue);
	});

	debug(result);
	return result;
}

module.exports = internalLinks;
