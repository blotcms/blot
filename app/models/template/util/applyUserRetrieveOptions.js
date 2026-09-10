var extend = require("helper/extend");
var type = require("helper/type");
var parseTemplate = require("../parseTemplate");

// The parser is the source of truth for retrieve locals it can see in a view's
// content. This folds back the two things the parser can't derive from content
// alone:
//
//   1. Real retrieve locals (ones blot knows how to fetch) that the caller or
//      the previously stored view asked for - e.g. a dependency reached only
//      through a string local. Non-local keys (stale output from an older
//      parser, internal __sentinels) are dropped: they fetch nothing.
//   2. User-set options on the retrieve object (includeDraft, filters).
//
// setView persists exactly what this returns, so scripts that recalculate
// retrieve metadata in bulk compare a view's stored retrieve against a fresh
// run of this to decide whether a rewrite is needed.

var USER_RETRIEVE_KEYS = ["includeDraft", "filters"];

module.exports = function applyUserRetrieveOptions(
	parsedRetrieve,
	requestedRetrieve,
	existingRetrieve
) {
	var result = {};

	extend(result).and(parsedRetrieve || {});

	[requestedRetrieve, existingRetrieve].forEach(function (source) {
		if (!source) return;
		Object.keys(source).forEach(function (key) {
			if (key.indexOf("__") === 0) return;
			if (!parseTemplate.isSystemRetrieveLocal(key)) return;

			var sourceVal = source[key];

			if (result[key] === undefined) {
				result[key] = sourceVal;
			} else if (type(result[key], "array") && type(sourceVal, "array")) {
				// `cdn` is an array dependency - union the targets so an
				// explicit/stored entry (e.g. a target reached indirectly)
				// survives alongside the parser's. updateCdnManifest builds
				// the manifest purely from this persisted array.
				result[key] = [...new Set(result[key].concat(sourceVal))].sort();
			} else if (type(result[key], "object") && type(sourceVal, "object")) {
				// Both structured (e.g. plugin.katex.css from content plus an
				// explicit plugin.zoom.js needed by a local): keep the parser's
				// leaves, fold in the extra nested requests.
				extend(result[key]).and(sourceVal);
			}
			// else: parser produced a value and the explicit one is a bare
			// boolean (or vice versa) - the parser wins (see the setView
			// stale-boolean tests).
		});
	});

	USER_RETRIEVE_KEYS.forEach(function (key) {
		var value;

		if (requestedRetrieve && requestedRetrieve[key] !== undefined) {
			value = requestedRetrieve[key];
		} else if (existingRetrieve && existingRetrieve[key] !== undefined) {
			value = existingRetrieve[key];
		}

		if (value !== undefined) {
			result[key] = value;
		}
	});

	return result;
};
