const retry = async (fn, retries = 3, delay = 1000) => {
  let lastError;
  let attempts = 0;

  for (let attempt = 1; attempt <= retries; attempt++) {
    attempts = attempt;

    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt} failed:`, error.message);

      // The caller knows trying again cannot change the outcome (e.g. the
      // site never loads, or its hostname does not resolve).
      if (error.retryable === false) {
        console.log("Error is not retryable.");
        break;
      }

      if (attempt < retries) {
        console.log(`Waiting ${delay}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        console.log("Retrying...");
      } else {
        console.log("No more retries left.");
      }
    }
  }

  throw new Error(
    `Failed after ${attempts} attempts. Last error: ${lastError.message}`
  );
};

module.exports = retry;
