"use strict";

const admin = require("firebase-admin");

const TWITCH_ID_FIELDS = Object.freeze([
  "twitch_id",
  "twitchId",
  "twitchUserId",
  "user_id",
]);

class TwitchIdentityConflictError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "TwitchIdentityConflictError";
    this.code = code;
    this.details = details;
  }
}

const normalizeLogin = (value) => String(value || "").trim().toLowerCase();
const normalizeId = (value) => String(value || "").trim();

function uniqueLogins(values = []) {
  return Array.from(new Set(values.map(normalizeLogin).filter(Boolean)));
}

function createTwitchIdentityResolver(db, { logger = console } = {}) {
  const followers = db.collection("followers_all_time");
  const identities = db.collection("twitch_identities");

  async function candidatesForId(twitchUserId) {
    const candidates = new Map();
    const snapshots = await Promise.all(
      TWITCH_ID_FIELDS.map((field) => followers.where(field, "==", twitchUserId).get()),
    );
    snapshots.forEach((snapshot) => {
      snapshot.docs.forEach((doc) => candidates.set(normalizeLogin(doc.id), doc));
    });
    return candidates;
  }

  async function writeIdentity(ref, existing, {
    twitchUserId,
    currentLogin,
    observedLogin,
    previousLogins = [],
    status,
    conflictReason = null,
  }) {
    const now = admin.firestore.FieldValue.serverTimestamp();
    const current = normalizeLogin(currentLogin);
    const observed = normalizeLogin(observedLogin || current);
    const previous = uniqueLogins([
      ...(existing?.previousLogins || []),
      ...previousLogins,
    ]).filter((login) => login !== current);
    const payload = {
      twitchUserId,
      currentLogin: current,
      observedLogin: observed,
      previousLogins: previous,
      status,
      updatedAt: now,
      ...(existing?.createdAt ? {} : { createdAt: now }),
    };
    if (status === "rename_pending") payload.renameDetectedAt = now;
    if (status === "conflict") {
      payload.conflictDetectedAt = now;
      payload.conflictReason = conflictReason || "ambiguous_twitch_identity";
    }
    await ref.set(payload, { merge: true });
    return payload;
  }

  return async function resolveTwitchIdentity({
    login,
    twitchUserId,
    allowCreate = false,
  } = {}) {
    const observedLogin = normalizeLogin(login);
    const userId = normalizeId(twitchUserId);
    if (!observedLogin) return { login: "", status: "missing_login", canCreate: false };

    if (!userId) {
      const direct = await followers.doc(observedLogin).get();
      return {
        login: observedLogin,
        twitchUserId: "",
        status: direct.exists ? "legacy_login" : "missing_twitch_id",
        canCreate: allowCreate && !direct.exists,
      };
    }

    const ref = identities.doc(userId);
    const identitySnap = await ref.get();
    const identity = identitySnap.exists ? identitySnap.data() || {} : {};
    const registeredLogin = normalizeLogin(identity.currentLogin);
    if (identity.status === "conflict") {
      throw new TwitchIdentityConflictError("identity_marked_conflict", {
        twitchUserId: userId,
        observedLogin,
      });
    }

    if (registeredLogin) {
      const registeredSnap = await followers.doc(registeredLogin).get();
      if (registeredSnap.exists) {
        if (registeredLogin !== observedLogin) {
          await writeIdentity(ref, identity, {
            twitchUserId: userId,
            currentLogin: registeredLogin,
            observedLogin,
            previousLogins: identity.previousLogins,
            status: identity.status === "migrating" ? "migrating" : "rename_pending",
          });
          logger.warn?.(
            `[twitch-identity] rename pending ${registeredLogin} -> ${observedLogin} (${userId})`,
          );
        }
        return {
          login: registeredLogin,
          twitchUserId: userId,
          status: registeredLogin === observedLogin ? identity.status || "active" : "rename_pending",
          canCreate: false,
        };
      }
    }

    const candidates = await candidatesForId(userId);
    const candidateLogins = Array.from(candidates.keys());
    if (candidateLogins.length > 2 ||
        (candidateLogins.length === 2 && !candidateLogins.includes(observedLogin))) {
      const canonical = candidateLogins[0] || observedLogin;
      await writeIdentity(ref, identity, {
        twitchUserId: userId,
        currentLogin: canonical,
        observedLogin,
        previousLogins: candidateLogins,
        status: "conflict",
        conflictReason: "ambiguous_twitch_identity",
      });
      throw new TwitchIdentityConflictError("ambiguous_twitch_identity", {
        twitchUserId: userId,
        candidateLogins,
      });
    }

    if (candidateLogins.length) {
      const canonical =
        candidateLogins.find((candidate) => candidate !== observedLogin) || candidateLogins[0];
      const renamed = canonical !== observedLogin;
      await writeIdentity(ref, identity, {
        twitchUserId: userId,
        currentLogin: canonical,
        observedLogin,
        previousLogins: identity.previousLogins,
        status: renamed || candidateLogins.length > 1 ? "rename_pending" : "active",
      });
      return {
        login: canonical,
        twitchUserId: userId,
        status: renamed || candidateLogins.length > 1 ? "rename_pending" : "active",
        canCreate: false,
      };
    }

    const direct = await followers.doc(observedLogin).get();
    if (direct.exists) {
      const directId = TWITCH_ID_FIELDS
        .map((field) => normalizeId(direct.data()?.[field]))
        .find(Boolean);
      if (directId && directId !== userId) {
        await writeIdentity(ref, identity, {
          twitchUserId: userId,
          currentLogin: observedLogin,
          observedLogin,
          status: "conflict",
          conflictReason: "login_owned_by_another_twitch_id",
        });
        throw new TwitchIdentityConflictError("login_owned_by_another_twitch_id", {
          login: observedLogin,
          expectedTwitchUserId: userId,
          actualTwitchUserId: directId,
        });
      }
    }

    await writeIdentity(ref, identity, {
      twitchUserId: userId,
      currentLogin: observedLogin,
      observedLogin,
      previousLogins: identity.previousLogins,
      status: "active",
    });
    return {
      login: observedLogin,
      twitchUserId: userId,
      status: "active",
      canCreate: allowCreate && !direct.exists,
    };
  };
}

module.exports = {
  TWITCH_ID_FIELDS,
  TwitchIdentityConflictError,
  createTwitchIdentityResolver,
};
