import { remoteServer, Authorization } from "../config.js";
import fetch from "./rateLimitedFetchWithRetriesAndTimeout.js";
import clfdate from "../util/clfdate.js";

export default async (...args) => {
  const [blogID, status] = args;

  if (!blogID || typeof blogID !== "string") {
    console.error(clfdate(), "Invalid blogID for status client request", {
      blogID,
    });
    throw new Error("Invalid blogID");
  }

  if (!status || typeof status !== "object") {
    console.error(
      clfdate(),
      "Invalid status payload for status client request",
      {
        blogID,
        status,
      }
    );
    throw new Error("Invalid status");
  }

  if (args.length !== 2) {
    console.error(
      clfdate(),
      "Invalid argument count for status client request",
      {
        argsLength: args.length,
      }
    );
    throw new Error("Invalid number of arguments: expected 2");
  }

  console.log(clfdate(), `Sending status for blogID: ${blogID}`, status);

  try {
    await fetch(`${remoteServer}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization, // Use the Authorization header
        blogID,
      },
      body: JSON.stringify(status),
    });
  } catch (error) {
    console.error(clfdate(), `Failed to send status for blogID ${blogID}`, {
      status,
      error,
    });
    throw error;
  }

  console.log(clfdate(), `Status sent for blogID: ${blogID}`);
};
