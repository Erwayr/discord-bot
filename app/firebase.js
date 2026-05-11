"use strict";

const admin = require("firebase-admin");
const { initializeFirestore } = require("firebase-admin/firestore");

function createFirebase({ preferRest = true } = {}) {
  let key;
  try {
    key = JSON.parse(process.env.FIREBASE_KEY_JSON);
    console.log("✅ Clé Firebase parsée !");
  } catch (e) {
    console.error("❌ Erreur de parsing FIREBASE_KEY_JSON :", e);
  }

  const firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(key),
  });
  const db = initializeFirestore(firebaseApp, {
    ignoreUndefinedProperties: true,
    preferRest,
  });

  console.log(
    `[firestore] transport prefere: ${preferRest ? "REST" : "gRPC"}`,
  );

  return { admin, firebaseApp, db };
}

module.exports = { createFirebase };
