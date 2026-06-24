"use strict";

const BOOTY_RESPONSES = [
  "Oui ? On m'appelle, ou c'est juste mon nom qui traine dans le chat ?",
  "J'ai entendu booty. Je reponds, mais je nie toute responsabilite.",
  "Present. Booty au rapport, avec zero contexte et beaucoup trop de confiance.",
  "Tu as dit booty ? Je prends ca comme une invitation a etre inutilement drole.",
  "Je suis la. Pas besoin de crier booty, mon ego capte tres bien le signal.",
  "Message recu. Analyse terminee: tu voulais clairement attirer mon attention.",
  "Booty confirme reception. Je ne sais pas pourquoi, mais je suis implique.",
  "On parle de moi ? Je pose juste la question avant de faire une betise.",
  "Je reponds parce que j'ai vu booty, pas parce que j'ai compris le message.",
  "Me voila. Mon seul talent: apparaitre quand quelqu'un dit booty.",
];

function containsBooty(content) {
  return /booty/i.test(String(content || ""));
}

function shouldReplyToBooty({ rng = Math.random } = {}) {
  return rng() < 0.5;
}

function pickBootyResponse({ rng = Math.random } = {}) {
  const index = Math.min(
    BOOTY_RESPONSES.length - 1,
    Math.floor(rng() * BOOTY_RESPONSES.length),
  );
  return BOOTY_RESPONSES[index];
}

async function maybeReplyToBooty(message, { rng = Math.random } = {}) {
  if (!containsBooty(message?.content)) return false;
  if (!shouldReplyToBooty({ rng })) return false;

  await message.reply({
    content: pickBootyResponse({ rng }),
    allowedMentions: { repliedUser: false },
  });
  return true;
}

module.exports = {
  BOOTY_RESPONSES,
  containsBooty,
  shouldReplyToBooty,
  pickBootyResponse,
  maybeReplyToBooty,
};
