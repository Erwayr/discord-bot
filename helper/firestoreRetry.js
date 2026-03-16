"use strict";

const TRANSIENT_FIRESTORE_CODES = new Set([4, 8, 10, 13, 14]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFirestoreError(error) {
  const code = Number(error?.code);
  if (TRANSIENT_FIRESTORE_CODES.has(code)) return true;

  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("deadline exceeded") ||
    message.includes("waiting for lb pick") ||
    message.includes("unavailable")
  );
}

async function commitBatchWithRetry(batch, options = {}) {
  const maxAttempts = Math.max(
    1,
    Number(options.maxAttempts || process.env.FIRESTORE_COMMIT_MAX_ATTEMPTS || 5),
  );
  const baseDelayMs = Math.max(
    50,
    Number(options.baseDelayMs || process.env.FIRESTORE_COMMIT_BASE_DELAY_MS || 500),
  );
  const label = options.label || "firestore-batch";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await batch.commit();
    } catch (error) {
      const transient = isTransientFirestoreError(error);
      if (!transient || attempt === maxAttempts) {
        throw error;
      }

      const jitter = Math.floor(Math.random() * 250);
      const delayMs = baseDelayMs * 2 ** (attempt - 1) + jitter;
      console.warn(
        `[firestore] ${label} commit retry ${attempt}/${maxAttempts} in ${delayMs}ms (code=${error?.code ?? "n/a"})`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error("unreachable");
}

module.exports = {
  commitBatchWithRetry,
  isTransientFirestoreError,
};
