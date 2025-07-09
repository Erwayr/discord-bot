const { FieldValue } = require("firebase-admin").firestore;

module.exports = async function handleVoteChange(reaction, user, added,db) {
  if (user.bot || reaction.emoji.name !== "👍") return;
  // Assure-toi que le message est bien fetché
  if (reaction.partial) await reaction.fetch();

  // Cherche l'élection en cours qui utilise ce message
  const coll = db.collection("elections");
  const snap = await coll
    .where("pollMessageId", "==", reaction.message.id)
    .where("endedAt", "==", null)
    .limit(1)
    .get();
  if (snap.empty) return;

  const electionRef = snap.docs[0].ref;
  const op = added
    ? { voters: FieldValue.arrayUnion(user.id) }
    : { voters: FieldValue.arrayRemove(user.id) };

  await electionRef.update(op);
}