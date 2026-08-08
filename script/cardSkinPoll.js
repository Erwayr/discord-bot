"use strict";

const crypto = require("crypto");
const { getFirestore } = require("firebase-admin/firestore");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const CARD_SKIN_POLL_COMMAND_NAME = "skinsondage";
const POLLS_COLLECTION = "discord_card_skin_polls";
const STATE_COLLECTION = "discord_card_skin_poll_state";
const MAX_PROPOSALS_PER_USER = 3;
const MAIN_RANKING_LIMIT = 10;

const PROPOSE_PREFIX = "card_skin_poll:propose:";
const VOTE_PREFIX = "card_skin_poll:vote:";
const MODAL_PREFIX = "card_skin_poll:modal:";

function normalizeProposalName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function proposalIdFromName(name) {
  return crypto
    .createHash("sha1")
    .update(normalizeProposalName(name))
    .digest("hex")
    .slice(0, 24);
}

function stateRef(db, guildId) {
  return db.collection(STATE_COLLECTION).doc(String(guildId));
}

function pollRef(db, pollId) {
  return db.collection(POLLS_COLLECTION).doc(String(pollId));
}

function proposalsRef(db, pollId) {
  return pollRef(db, pollId).collection("proposals");
}

function votesRef(db, pollId) {
  return pollRef(db, pollId).collection("votes");
}

function buildMainComponents(pollId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PROPOSE_PREFIX}${pollId}`)
        .setLabel("Proposer un skin")
        .setEmoji("➕")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  ];
}

function buildVoteComponents(pollId, proposalId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${VOTE_PREFIX}${pollId}:${proposalId}`)
        .setLabel(disabled ? "Vote terminé" : "Voter")
        .setEmoji("🗳️")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    ),
  ];
}

function sortProposals(docs) {
  return docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => {
      const voteDiff = Number(b.voteCount || 0) - Number(a.voteCount || 0);
      if (voteDiff !== 0) return voteDiff;
      const aCreated =
        a.createdAt?.toMillis?.() || new Date(a.createdAt || 0).getTime() || 0;
      const bCreated =
        b.createdAt?.toMillis?.() || new Date(b.createdAt || 0).getTime() || 0;
      return aCreated - bCreated;
    });
}

function rankingText(proposals, limit = MAIN_RANKING_LIMIT) {
  if (!proposals.length) {
    return "Aucune proposition pour le moment. Sois le premier à proposer un skin !";
  }

  const medals = ["🥇", "🥈", "🥉"];
  return proposals
    .slice(0, limit)
    .map((proposal, index) => {
      const prefix = medals[index] || `${index + 1}.`;
      const votes = Number(proposal.voteCount || 0);
      return `${prefix} **${proposal.name}** — ${votes} vote${votes > 1 ? "s" : ""}`;
    })
    .join("\n");
}

function buildMainEmbed(poll, proposals, { closed = false } = {}) {
  const title = poll?.title || "Quel sera le prochain skin de carte ?";
  const sorted = sortProposals(proposals);

  return new EmbedBuilder()
    .setTitle(`${closed ? "🏆" : "🎨"} ${title}`)
    .setDescription(
      closed
        ? "Le sondage est terminé. Voici le classement final de la communauté."
        : [
            "Clique sur **➕ Proposer un skin** pour ajouter ton idée.",
            "Chaque membre possède **un seul vote actif** et peut le changer à tout moment.",
          ].join("\n"),
    )
    .addFields({
      name: closed ? "Classement final" : "Classement actuel",
      value: rankingText(sorted),
    })
    .setFooter({
      text: closed
        ? `${sorted.length} proposition${sorted.length > 1 ? "s" : ""}`
        : `Maximum ${MAX_PROPOSALS_PER_USER} propositions par membre`,
    });
}

function buildProposalEmbed(proposal, { closed = false } = {}) {
  const votes = Number(proposal.voteCount || 0);
  const embed = new EmbedBuilder()
    .setTitle(`🎨 ${proposal.name}`)
    .addFields(
      {
        name: "Proposé par",
        value: `<@${proposal.authorId}>`,
        inline: true,
      },
      {
        name: "Votes",
        value: String(votes),
        inline: true,
      },
    )
    .setFooter({
      text: closed
        ? "Vote terminé"
        : "1 vote actif par membre • Reclique pour retirer ton vote",
    });

  if (proposal.description) {
    embed.setDescription(proposal.description);
  }

  return embed;
}

async function getPollSnapshotFromState(
  db,
  guildId,
  { allowLast = false } = {},
) {
  const stateSnap = await stateRef(db, guildId).get();
  if (!stateSnap.exists) return null;

  const state = stateSnap.data() || {};
  const pollId = state.activePollId || (allowLast ? state.lastPollId : null);
  if (!pollId) return null;

  const snapshot = await pollRef(db, pollId).get();
  if (!snapshot.exists) return null;
  return snapshot;
}

async function fetchChannel(interaction, channelId) {
  if (
    interaction.channelId === channelId &&
    interaction.channel?.isTextBased?.()
  ) {
    return interaction.channel;
  }
  const channel = await interaction.client.channels
    .fetch(channelId)
    .catch(() => null);
  return channel?.isTextBased?.() ? channel : null;
}

async function refreshMainMessage(
  interaction,
  db,
  pollId,
  { closed = false } = {},
) {
  const pollSnap = await pollRef(db, pollId).get();
  if (!pollSnap.exists) return;

  const poll = pollSnap.data() || {};
  if (!poll.channelId || !poll.messageId) return;

  const proposalSnap = await proposalsRef(db, pollId).get();
  const channel = await fetchChannel(interaction, poll.channelId);
  if (!channel) return;

  const message = await channel.messages.fetch(poll.messageId).catch(() => null);
  if (!message) return;

  await message.edit({
    embeds: [buildMainEmbed(poll, proposalSnap.docs, { closed })],
    components: buildMainComponents(pollId, closed),
  });
}

async function refreshProposalMessage(
  interaction,
  db,
  pollId,
  proposalId,
  { closed = false } = {},
) {
  const proposalSnap = await proposalsRef(db, pollId).doc(proposalId).get();
  if (!proposalSnap.exists) return;

  const proposal = proposalSnap.data() || {};
  if (!proposal.channelId || !proposal.messageId) return;

  const channel = await fetchChannel(interaction, proposal.channelId);
  if (!channel) return;

  const message = await channel.messages
    .fetch(proposal.messageId)
    .catch(() => null);
  if (!message) return;

  await message.edit({
    embeds: [
      buildProposalEmbed({ id: proposalSnap.id, ...proposal }, { closed }),
    ],
    components: buildVoteComponents(pollId, proposalId, closed),
  });
}

async function createPoll(interaction, db) {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "❌ Cette commande doit être utilisée sur un serveur.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const currentPoll = await getPollSnapshotFromState(db, interaction.guildId);
  if (currentPoll?.data()?.active) {
    await interaction.editReply(
      "❌ Un sondage de skin est déjà actif. Clôture-le avant d'en créer un nouveau.",
    );
    return;
  }

  const requestedChannel = interaction.options.getChannel("canal");
  const channel = requestedChannel || interaction.channel;
  if (!channel?.isTextBased?.() || !channel?.send) {
    await interaction.editReply(
      "❌ Le canal choisi ne permet pas au bot d'envoyer des messages.",
    );
    return;
  }

  const title = String(
    interaction.options.getString("titre") ||
      "Quel sera le prochain skin de carte ?",
  ).trim();

  const ref = db.collection(POLLS_COLLECTION).doc();
  const poll = {
    guildId: interaction.guildId,
    channelId: channel.id,
    messageId: null,
    title,
    active: true,
    createdBy: interaction.user.id,
    createdAt: new Date(),
  };

  const message = await channel.send({
    embeds: [buildMainEmbed(poll, [])],
    components: buildMainComponents(ref.id),
  });

  try {
    const batch = db.batch();
    batch.set(ref, { ...poll, messageId: message.id });
    batch.set(
      stateRef(db, interaction.guildId),
      {
        activePollId: ref.id,
        lastPollId: ref.id,
        updatedAt: new Date(),
      },
      { merge: true },
    );
    await batch.commit();
  } catch (error) {
    await message.delete().catch(() => {});
    throw error;
  }

  await interaction.editReply(
    `✅ Sondage créé dans ${channel}. Les membres peuvent maintenant proposer leurs skins.`,
  );
}

async function showProposalModal(interaction, db, pollId) {
  const snap = await pollRef(db, pollId).get();
  if (!snap.exists || !snap.data()?.active) {
    await interaction.reply({
      content: "❌ Ce sondage est terminé ou n'existe plus.",
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${pollId}`)
    .setTitle("Proposer un skin de carte");

  const nameInput = new TextInputBuilder()
    .setCustomId("skin_name")
    .setLabel("Nom du skin")
    .setPlaceholder("Ex. Cyberpunk, Viking, Espace...")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(80);

  const descriptionInput = new TextInputBuilder()
    .setCustomId("skin_description")
    .setLabel("Description (facultatif)")
    .setPlaceholder("Décris rapidement le style que tu imagines...")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(descriptionInput),
  );

  await interaction.showModal(modal);
}

async function submitProposal(interaction, db, pollId) {
  await interaction.deferReply({ ephemeral: true });

  const pollSnap = await pollRef(db, pollId).get();
  if (!pollSnap.exists || !pollSnap.data()?.active) {
    await interaction.editReply("❌ Ce sondage est terminé ou n'existe plus.");
    return;
  }

  const poll = pollSnap.data() || {};
  const name = interaction.fields.getTextInputValue("skin_name").trim();
  const description = interaction.fields
    .getTextInputValue("skin_description")
    .trim();
  const normalizedName = normalizeProposalName(name);
  const proposalId = proposalIdFromName(name);
  const ref = proposalsRef(db, pollId).doc(proposalId);

  const ownProposals = await proposalsRef(db, pollId)
    .where("authorId", "==", interaction.user.id)
    .get();
  if (ownProposals.size >= MAX_PROPOSALS_PER_USER) {
    await interaction.editReply(
      `❌ Tu as déjà atteint la limite de ${MAX_PROPOSALS_PER_USER} propositions pour ce sondage.`,
    );
    return;
  }

  let created = false;
  await db.runTransaction(async (transaction) => {
    const latestPoll = await transaction.get(pollRef(db, pollId));
    const existing = await transaction.get(ref);

    if (!latestPoll.exists || !latestPoll.data()?.active) {
      throw new Error("POLL_CLOSED");
    }
    if (existing.exists) {
      throw new Error("DUPLICATE_PROPOSAL");
    }

    transaction.set(ref, {
      name,
      normalizedName,
      description,
      authorId: interaction.user.id,
      authorName: interaction.user.globalName || interaction.user.username,
      voteCount: 0,
      channelId: poll.channelId,
      messageId: null,
      createdAt: new Date(),
    });
    created = true;
  });

  if (!created) return;

  const channel = await fetchChannel(interaction, poll.channelId);
  if (!channel) {
    await ref.delete().catch(() => {});
    await interaction.editReply(
      "❌ Impossible de retrouver le canal du sondage.",
    );
    return;
  }

  let message;
  try {
    message = await channel.send({
      embeds: [
        buildProposalEmbed({
          name,
          description,
          authorId: interaction.user.id,
          voteCount: 0,
        }),
      ],
      components: buildVoteComponents(pollId, proposalId),
    });
    await ref.update({ messageId: message.id, channelId: channel.id });
  } catch (error) {
    await ref.delete().catch(() => {});
    throw error;
  }

  await refreshMainMessage(interaction, db, pollId).catch((error) =>
    console.warn(
      "[card-skin-poll] refresh main after proposal failed:",
      error?.message || error,
    ),
  );

  await interaction.editReply(`✅ **${name}** a été ajouté au sondage.`);
}

async function vote(interaction, db, pollId, proposalId) {
  await interaction.deferReply({ ephemeral: true });

  const pollReference = pollRef(db, pollId);
  const proposalReference = proposalsRef(db, pollId).doc(proposalId);
  const userVoteReference = votesRef(db, pollId).doc(interaction.user.id);

  const result = await db.runTransaction(async (transaction) => {
    const currentPoll = await transaction.get(pollReference);
    const currentVote = await transaction.get(userVoteReference);
    const targetProposal = await transaction.get(proposalReference);

    if (!currentPoll.exists || !currentPoll.data()?.active) {
      throw new Error("POLL_CLOSED");
    }
    if (!targetProposal.exists) {
      throw new Error("PROPOSAL_NOT_FOUND");
    }

    const previousProposalId = currentVote.exists
      ? currentVote.data()?.proposalId
      : null;
    let previousProposal = null;
    let previousProposalReference = null;

    if (previousProposalId && previousProposalId !== proposalId) {
      previousProposalReference = proposalsRef(db, pollId).doc(
        previousProposalId,
      );
      previousProposal = await transaction.get(previousProposalReference);
    }

    const targetCount = Math.max(
      0,
      Number(targetProposal.data()?.voteCount || 0),
    );

    if (previousProposalId === proposalId) {
      transaction.delete(userVoteReference);
      transaction.update(proposalReference, {
        voteCount: Math.max(0, targetCount - 1),
      });
      return {
        action: "removed",
        changedProposalIds: [proposalId],
      };
    }

    transaction.set(userVoteReference, {
      proposalId,
      userId: interaction.user.id,
      updatedAt: new Date(),
    });
    transaction.update(proposalReference, { voteCount: targetCount + 1 });

    const changedProposalIds = [proposalId];
    if (previousProposal && previousProposal.exists) {
      const oldCount = Math.max(
        0,
        Number(previousProposal.data()?.voteCount || 0),
      );
      transaction.update(previousProposalReference, {
        voteCount: Math.max(0, oldCount - 1),
      });
      changedProposalIds.push(previousProposalId);
    }

    return {
      action: previousProposalId ? "changed" : "added",
      changedProposalIds,
    };
  });

  await Promise.all(
    result.changedProposalIds.map((id) =>
      refreshProposalMessage(interaction, db, pollId, id).catch((error) =>
        console.warn(
          "[card-skin-poll] refresh proposal failed:",
          error?.message || error,
        ),
      ),
    ),
  );
  await refreshMainMessage(interaction, db, pollId).catch((error) =>
    console.warn(
      "[card-skin-poll] refresh main after vote failed:",
      error?.message || error,
    ),
  );

  const feedback = {
    added: "✅ Ton vote a été enregistré.",
    changed: "✅ Ton vote a été déplacé vers ce skin.",
    removed: "✅ Ton vote a été retiré.",
  };
  await interaction.editReply(
    feedback[result.action] || "✅ Vote mis à jour.",
  );
}

async function showResults(interaction, db) {
  await interaction.deferReply({ ephemeral: true });

  const pollSnap = await getPollSnapshotFromState(db, interaction.guildId, {
    allowLast: true,
  });
  if (!pollSnap) {
    await interaction.editReply(
      "ℹ️ Aucun sondage de skin n'a encore été créé.",
    );
    return;
  }

  const poll = pollSnap.data() || {};
  const proposals = await proposalsRef(db, pollSnap.id).get();
  const sorted = sortProposals(proposals.docs);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${poll.title || "Résultats du sondage de skins"}`)
    .setDescription(rankingText(sorted, 20))
    .setFooter({ text: poll.active ? "Sondage en cours" : "Sondage terminé" });

  await interaction.editReply({ embeds: [embed] });
}

async function closePoll(interaction, db) {
  await interaction.deferReply({ ephemeral: true });

  const pollSnap = await getPollSnapshotFromState(db, interaction.guildId);
  if (!pollSnap || !pollSnap.data()?.active) {
    await interaction.editReply(
      "ℹ️ Aucun sondage de skin n'est actuellement actif.",
    );
    return;
  }

  const pollId = pollSnap.id;
  const pollReference = pollRef(db, pollId);

  await db.runTransaction(async (transaction) => {
    const latestPoll = await transaction.get(pollReference);
    if (!latestPoll.exists || !latestPoll.data()?.active) {
      throw new Error("POLL_CLOSED");
    }

    transaction.update(pollReference, {
      active: false,
      closedAt: new Date(),
      closedBy: interaction.user.id,
    });
    transaction.set(
      stateRef(db, interaction.guildId),
      {
        activePollId: null,
        lastPollId: pollId,
        updatedAt: new Date(),
      },
      { merge: true },
    );
  });

  const proposals = await proposalsRef(db, pollId).get();
  await refreshMainMessage(interaction, db, pollId, { closed: true }).catch(
    (error) =>
      console.warn(
        "[card-skin-poll] close main refresh failed:",
        error?.message || error,
      ),
  );

  for (const doc of proposals.docs) {
    await refreshProposalMessage(interaction, db, pollId, doc.id, {
      closed: true,
    }).catch((error) =>
      console.warn(
        "[card-skin-poll] close proposal refresh failed:",
        error?.message || error,
      ),
    );
  }

  const sorted = sortProposals(proposals.docs);
  const winner = sorted[0];
  const winnerVotes = Number(winner?.voteCount || 0);
  await interaction.editReply(
    winner
      ? `🏆 Sondage clôturé. Le skin gagnant est **${winner.name}** avec **${winnerVotes} vote${winnerVotes > 1 ? "s" : ""}**.`
      : "✅ Sondage clôturé. Aucune proposition n'avait été ajoutée.",
  );
}

async function handleSlashCommand(interaction, db) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "creer") {
    await createPoll(interaction, db);
    return;
  }
  if (subcommand === "resultats") {
    await showResults(interaction, db);
    return;
  }
  if (subcommand === "cloturer") {
    await closePoll(interaction, db);
  }
}

function parseVoteCustomId(customId) {
  if (!customId.startsWith(VOTE_PREFIX)) return null;
  const value = customId.slice(VOTE_PREFIX.length);
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) return null;
  return {
    pollId: value.slice(0, separatorIndex),
    proposalId: value.slice(separatorIndex + 1),
  };
}

const registeredClients = new WeakSet();

function registerCardSkinPollEvents({ client }) {
  if (registeredClients.has(client)) return;
  registeredClients.add(client);
  const db = getFirestore();

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (
        interaction.isChatInputCommand?.() &&
        interaction.commandName === CARD_SKIN_POLL_COMMAND_NAME
      ) {
        await handleSlashCommand(interaction, db);
        return;
      }

      if (interaction.isButton?.()) {
        if (interaction.customId.startsWith(PROPOSE_PREFIX)) {
          const pollId = interaction.customId.slice(PROPOSE_PREFIX.length);
          await showProposalModal(interaction, db, pollId);
          return;
        }

        const parsedVote = parseVoteCustomId(interaction.customId);
        if (parsedVote) {
          await vote(
            interaction,
            db,
            parsedVote.pollId,
            parsedVote.proposalId,
          );
        }
        return;
      }

      if (
        interaction.isModalSubmit?.() &&
        interaction.customId.startsWith(MODAL_PREFIX)
      ) {
        const pollId = interaction.customId.slice(MODAL_PREFIX.length);
        await submitProposal(interaction, db, pollId);
      }
    } catch (error) {
      console.error(
        "[card-skin-poll] interaction failed:",
        error?.message || error,
      );
      const duplicate = error?.message === "DUPLICATE_PROPOSAL";
      const closed = error?.message === "POLL_CLOSED";
      const notFound = error?.message === "PROPOSAL_NOT_FOUND";
      const message = duplicate
        ? "❌ Ce skin a déjà été proposé dans ce sondage."
        : closed
          ? "❌ Ce sondage est déjà terminé."
          : notFound
            ? "❌ Cette proposition n'existe plus."
            : "❌ Une erreur est survenue pendant le traitement du sondage.";

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => {});
      } else {
        await interaction
          .reply({ content: message, ephemeral: true })
          .catch(() => {});
      }
    }
  });
}

module.exports = {
  CARD_SKIN_POLL_COMMAND_NAME,
  registerCardSkinPollEvents,
};