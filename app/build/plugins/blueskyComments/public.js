const convertToAtUri = (value) => {
  const trimmed = (value || "").trim();

  // Already an AT URI (e.g. at://did:plc:abc/app.bsky.feed.post/123)
  if (trimmed.indexOf("at://") === 0) return trimmed;

  // Otherwise expect a bsky.app post URL
  const match = trimmed.match(
    /https?:\/\/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/
  );
  if (!match) throw new Error("Invalid Bluesky post URL or AT URI.");
  return `at://${match[1]}/app.bsky.feed.post/${match[2]}`;
};

const extractHandleFromProfileUrl = (profileUrl) => {
  const match = (profileUrl || "")
    .trim()
    .match(/https?:\/\/bsky\.app\/profile\/([^/?#]+)/);
  if (match) return match[1];
  throw new Error("Invalid Bluesky profile URL format.");
};

const getRkeyFromUri = (uri) => {
  return uri.split("/").pop();
};

const getPostUrl = (authorDid, rkey) => {
  return `https://bsky.app/profile/${authorDid}/post/${rkey}`;
};

const sortByLikeCount = (a, b) => (b.post.likeCount || 0) - (a.post.likeCount || 0);

const getTemplate = (id) => {
  const template = document.getElementById(id);
  if (!template) throw new Error(`Template ${id} not found`);
  return template.content.cloneNode(true);
};

const renderPostActions = (post) => {
  const fragment = getTemplate("template-post-actions");
  fragment.querySelector("[data-like-count]").textContent = post.likeCount || 0;
  fragment.querySelector("[data-repost-count]").textContent = post.repostCount || 0;
  fragment.querySelector("[data-reply-count]").textContent = post.replyCount || 0;
  return fragment;
};

const renderCommentContainer = (post) => {
  const author = post.author;
  const rkey = getRkeyFromUri(post.uri);
  const postUrl = getPostUrl(author.did, rkey);

  const fragment = getTemplate("template-comment-container");
  const links = fragment.querySelectorAll("[data-post-url]");
  links.forEach((link) => {
    link.href = postUrl;
  });
  const avatar = fragment.querySelector("[data-avatar]");
  if (author.avatar) avatar.src = author.avatar;
  avatar.alt = `${author.displayName || author.handle || "User"}'s avatar`;
  fragment.querySelector("[data-display-name]").textContent =
    author.displayName || author.handle || "";
  fragment.querySelector("[data-text]").textContent = post.record?.text || "";

  // Add post actions
  const actionsContainer = fragment.querySelector(".comment-container > div");
  actionsContainer.appendChild(renderPostActions(post));

  return fragment;
};

const renderComment = (post) => {
  const fragment = getTemplate("template-comment");
  const containerPlaceholder = fragment.querySelector("[data-comment-container]");
  const commentContainer = renderCommentContainer(post);
  containerPlaceholder.replaceWith(commentContainer.querySelector(".comment-container"));
  return fragment;
};

const renderThread = (thread) => {
  const fragment = renderComment(thread.post);
  const repliesContainer = fragment.querySelector("[data-replies]");

  const replies = (thread.replies || [])
    .filter((reply) => reply && reply.post)
    .sort(sortByLikeCount)
    .slice(0, 3)
    .map((reply) => renderComment(reply.post));

  if (replies.length > 0) {
    replies.forEach((reply) => {
      repliesContainer.appendChild(reply);
    });
  } else {
    repliesContainer.remove();
  }

  return fragment;
};

const renderCommentsHeader = (postUrl) => {
  const fragment = getTemplate("template-comments-header");
  fragment.querySelector("[data-post-url]").href = postUrl;
  return fragment;
};

const renderErrorMessage = (message) => {
  const fragment = getTemplate("template-error-message");
  fragment.querySelector("[data-message]").textContent = message;
  return fragment;
};

const renderReplyLink = (postUrl) => {
  const fragment = getTemplate("template-reply-link");
  fragment.querySelector("[data-post-url]").href = postUrl;
  return fragment;
};

const loadThread = (uri, container, originalUrl) => {
  fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(
      uri
    )}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    }
  )
    .then(async (response) => {
      if (!response.ok) throw new Error(await response.text());

      const { thread } = await response.json();

      // The thread may be missing, blocked or not found — in which case
      // there is no post and no replies to render.
      if (!thread || !thread.post) {
        container.appendChild(
          renderErrorMessage("The Bluesky thread could not be loaded.")
        );
        return;
      }

      const replies = (thread.replies || [])
        .filter((reply) => reply && reply.post)
        .sort(sortByLikeCount);

      // Add main post actions if element exists
      const mainPostActions = document.getElementById("main-post-actions");
      if (mainPostActions) {
        mainPostActions.innerHTML = "";
        mainPostActions.appendChild(renderPostActions(thread.post));
      }

      // Append top 25 comments
      replies.slice(0, 25).forEach((reply) => {
        container.appendChild(renderThread(reply));
      });

      // Add "Show More" link if there are more comments
      if (replies.length > 25 && !container.querySelector("#see-more")) {
        const postUrl =
          originalUrl || getPostUrl(thread.post.author.did, getRkeyFromUri(uri));
        container.appendChild(renderReplyLink(postUrl));
      }
    })
    .catch((error) => {
      console.error("Error loading Bluesky thread:", error);
      container.innerHTML = "";
      container.appendChild(renderErrorMessage("Error loading comments."));
    });
};

const init = () => {
  const container = document.getElementById("comments");

  if (!container) return;

  const dataUri = container.dataset.uri?.trim();
  const dataAuthor = container.dataset.author?.trim();

  // Priority 1: an explicit Bluesky post is set in the entry's metadata
  if (dataUri) {
    const uri = convertToAtUri(dataUri);
    container.appendChild(renderCommentsHeader(dataUri));
    loadThread(uri, container, dataUri);
    return;
  }

  // Priority 2: auto-discover the Bluesky post that links to this page,
  // authored by the configured account.
  if (dataAuthor) {
    const author = extractHandleFromProfileUrl(dataAuthor);
    const currentUrl = window.location.href.split("#")[0];
    const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=*&url=${encodeURIComponent(
      currentUrl
    )}&author=${encodeURIComponent(author)}&sort=top`;

    fetch(apiUrl)
      .then((response) => response.json())
      .then((data) => {
        const post = data.posts && data.posts[0];

        // No post links to this page yet — show nothing rather than a
        // placeholder on every entry.
        if (!post) return;

        const rkey = getRkeyFromUri(post.uri);
        const postUrl = getPostUrl(post.author.did, rkey);

        container.appendChild(renderCommentsHeader(postUrl));

        const mainPostActions = document.createElement("a");
        mainPostActions.id = "main-post-actions";
        mainPostActions.target = "_blank";
        mainPostActions.rel = "noopener";
        mainPostActions.href = postUrl;
        container.appendChild(mainPostActions);

        loadThread(post.uri, container, postUrl);
      })
      .catch((err) => {
        console.error("Error searching for Bluesky post:", err);
      });

    return;
  }

  // Priority 3: nothing configured — render nothing.
};

try {
  init();
} catch (e) {
  console.error("Bluesky comments plugin failed to initialise:", e);
}
