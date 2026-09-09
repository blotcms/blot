const _ = require("lodash");
const async = require("async");
const getByUrl = require("./getByUrl");
const debug = require("debug")("blot:entry:set:backlinksToUpdate");

// This function takes an entry currently being updated
// and returns a list of other entries whose backlinks
// property needs to change. This can happen because:
// - this entry has been removed and it should
//	 no longer appear on the backlinks lists of other entries
// - this entry now links to another post and
//   it should appear on that post's backlinks list
// - this entry's permalink has changed and the URL that
//   appears on other post's backlinks list needs to change
function backlinksToUpdate(
	blogID,
	entry,
	previousInternalLinks,
	previousPermalink,
	previousUrl,
	callback
) {
	if (typeof previousUrl === "function") {
		callback = previousUrl;
		previousUrl = undefined;
	}

	// The value we record on other entries' backlinks lists to point back
	// at this entry. Pages (and any entry without an explicit Permalink/
	// Link/Url in their metadata) have an empty entry.permalink, so fall
	// back to entry.url - the URL the entry is actually served from - or
	// they can never appear as the *source* of a backlink.
	const permalink = entry.permalink || entry.url;
	const formerPermalink = previousPermalink || previousUrl;
	// Since this post is no longer available, none of its current or former
	// links are present. Remove everything.
	// Since this post exists, we need to work out which dependencies were
	// added since the last time this post was saved. We also need to work
	// out which dependencies were removed.
	const allInternalLinks = _.union(entry.internalLinks, previousInternalLinks);
	const currentInternalLinks = entry.deleted ? [] : entry.internalLinks;
	const formerInternalLinks = entry.deleted
		? allInternalLinks
		: _.difference(previousInternalLinks, currentInternalLinks);

	debug(entry.path, ":currentInternalLinks", currentInternalLinks);
	debug(entry.path, ":previousInternalLinks", previousInternalLinks);
	debug(entry.path, ":formerInternalLinks", formerInternalLinks);
	debug(entry.path, ":allInternalLinks", allInternalLinks);

	let changes = {};

	async.filter(
		allInternalLinks,
		function (urlPath, next) {
			debug("getting", blogID, urlPath);
			getByUrl(blogID, urlPath, function (backLinkedEntry) {
				if (!backLinkedEntry) {
					debug("no backlinked entry for", urlPath);
					return next(null, false);
				}

				debug("found backlinked entry", backLinkedEntry.path, "for", urlPath);
				changes[urlPath] = {
					path: backLinkedEntry.path,
					backlinks: backLinkedEntry.backlinks,
					previousBacklinks: backLinkedEntry.backlinks.slice(),
				};
				next(null, true);
			});
		},
		function (err, validInternalLinks) {
			debug(entry.path, ":validInternalLinks", validInternalLinks);
			// Remove this entry from the backlinks list
			// of the entries which contain it.
			formerInternalLinks
				.filter((link) => validInternalLinks.indexOf(link) > -1)
				.forEach((link) => {
					changes[link].backlinks = changes[link].backlinks.filter(
						(link) => link !== permalink && link !== formerPermalink
					);
				});

			currentInternalLinks
				.filter((link) => validInternalLinks.indexOf(link) > -1)
				.forEach((link) => {
					if (permalink) changes[link].backlinks.push(permalink);
					if (permalink !== formerPermalink) {
						changes[link].backlinks = changes[link].backlinks.filter(
							(link) => link !== formerPermalink
						);
					}
				});

			let result = {};

			for (const url in changes) {
				const previousBacklinks = changes[url].previousBacklinks;
				const updatedBacklinks = _.uniq(changes[url].backlinks);

				if (_.isEqual(previousBacklinks, updatedBacklinks)) continue;

				result[changes[url].path] = updatedBacklinks;
			}

			debug(entry.path, "result", result);
			debug(entry.path, "[backlinks]", entry.backlinks);
			callback(null, result);
		}
	);
}

module.exports = backlinksToUpdate;
