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

const COMMUNITY_POLL_COMMAND_NAME = "sondage";
const CARD_SKIN_POLL_COMMAND_NAME = "skinsondage";

const GENERIC_SOURCE = {
  key: "generic",
  pollsCollection: "discord_community_polls",
  stateCollection: "discord_community_poll_state",
  customIdPrefix: "community_poll",
};

const LEGACY_SOURCE = {
  key: "legacy",
  pollsCollection: "discord_card_skin_polls",
  stateCollection: "discord_card_skin_poll_state",
  customIdPrefix: "card_skin_poll",
};

const SOURCES = [GENERIC_SOURCE, LEGACY_SOURCE];

const DEFAULT_MAX_PROPOSALS_PER_USER = 3;
const DEFAULT_MAX_VOTES_PER_USER = 1;
const MAIN_RANKING_LIMIT = 10;
const RESULTS_RANKING_LIMIT = 20;

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

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

function capitalize(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function pollWithSourceDefaults(poll, source) {
  if (source?.key !== LEGACY_SOURCE.key) return poll || {};
  return {
    proposalLabel: "skin",
    buttonLabel: "Proposer un skin",
    maxProposalsPerUser: DEFAULT_MAX_PROPOSALS_PER_USER,
    maxVotesPerUser: DEFAULT_MAX_VOTES_PER_USER,
    category: "card-skin",
    interactionNamespace: LEGACY_SOURCE.customIdPrefix,
    ...(poll || {}),
  };
}

function stateRef(db, guildId, source = GENERIC_SOURCE) {
  return db.collection(source.stateCollection).doc(String(guildId));
}

function pollRef(db, pollId, source = GENERIC_SOURCE) {
  return db.collection(source.pollsCollection).doc(String(pollId));
}

function proposalsRef(db, pollId, source = GENERIC_SOURCE) {
  return pollRef(db, pollId, source).collection("proposals");
}

function votesRef(db, pollId, source = GENERIC_SOURCE) {
  return pollRef(db, pollId, source).collection("votes");
}

function getProposalLabel(poll) {
  return String(poll?.proposalLabel || "proposition").trim() || "proposition";
}

function getMaxProposals(poll) {
  return clampInteger(
    poll?.maxProposalsPerUser,
    DEFAULT_MAX_PROPOSALS_PER_USER,
    1,
    10,
  );
}

function getMaxVotes(poll) {
  return clampInteger(
    poll?.maxVotesPerUser,
    DEFAULT_MAX_VOTES_PER_USER,
    1,
    5,
  );
}

function getProposeButtonLabel(poll) {
  if (poll?.buttonLabel) return truncate(poll.buttonLabel, 70);
  const label = getProposalLabel(poll);
  if (label.toLowerCase() === "proposition") return "Faire une proposition";
  return truncate(`Proposer : ${capitalize(label)}`, 70);
}

function getNamespaceForPoll(poll, source) {
  if (poll?.interactionNamespace === LEGACY_SOURCE.customIdPrefix) {
    return LEGACY_SOURCE.customIdPrefix;
  }
  if (poll?.interactionNamespace === GENERIC_SOURCE.customIdPrefix) {
    return GENERIC_SOURCE.customIdPrefix;
  }
  return source?.customIdPrefix || GENERIC_SOURCE.customIdPrefix;
}

function buildCustomId(namespace, action, pollId, proposalId = null) {
  const base = `${namespace}:${action}:${pollId}`;
  return proposalId ? `${base}:${proposalId}` : base;
}

function buildMainComponents(pollId, poll, source, disabled = false) {
  const namespace = getNamespaceForPoll(poll, source);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId(namespace, "propose", pollId))
        .setLabel(getProposeButtonLabel(poll))
        .setEmoji("➕")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  ];
}

function buildVoteComponents(
  pollId,
  proposalId,
  poll,
  source,
  disabled = false,
) {
  const namespace = getNamespaceForPoll(poll, source);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildCustomId(namespace, "vote", pollId, proposalId),
        )
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
    return "Aucune proposition pour le moment. Sois le premier à participer !";
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

function votingRuleText(poll) {
  const maxVotes = getMaxVotes(poll);
  if (maxVotes === 1) {
    return "Chaque membre possède **un seul vote actif** et peut le changer à tout moment.";
  }
  return `Chaque membre peut avoir jusqu'à **${maxVotes} votes actifs**. Reclique sur une proposition pour retirer ton vote.`;
}

function buildMainEmbed(poll, proposalDocs, { closed = false } = {}) {
  const title = poll?.title || "Sondage communautaire";
  const sorted = sortProposals(proposalDocs);
  const descriptionLines = [];

  if (closed) {
    descriptionLines.push(
      "Le sondage est terminé. Voici le classement final de la communauté.",
    );
  } else {
    const description = String(poll?.description || "").trim();
    if (description) {
      descriptionLines.push(description, "");
    }
    descriptionLines.push(
      `Clique sur **➕ ${getProposeButtonLabel(poll)}** pour ajouter ton idée.`,
      votingRuleText(poll),
    );
  }

  return new EmbedBuilder()
    .setTitle(`${closed ? "🏆" : "📊"} ${title}`)
    .setDescription(descriptionLines.join("\n"))
    .addFields({
      name: closed ? "Classement final" : "Classement actuel",
      value: rankingText(sorted),
    })
    .setFooter({
      text: closed
        ? `${sorted.length} proposition${sorted.length > 1 ? "s" : ""}`
        : `Maximum ${getMaxProposals(poll)} propositions par membre`,
    });
}

function buildProposalEmbed(proposal, poll, { closed = false } = {}) {
  const votes = Number(proposal.voteCount || 0);
  const maxVotes = getMaxVotes(poll);

  const footerText = closed
    ? "Vote terminé"
    : maxVotes === 1
      ? "1 vote actif par membre • Reclique pour retirer ton vote"
      : `Maximum ${maxVotes} votes actifs • Reclique pour retirer ton vote`;

  const embed = new EmbedBuilder()
    .setTitle(`💡 ${proposal.name}`)
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
    .setFooter({ text: footerText });

  if (proposal.description) {
    embed.setDescription(proposal.description);
  }

  return embed;
}

async function getPollContextById(db, pollId) {
  for (const source of SOURCES) {
    const snapshot = await pollRef(db, pollId, source).get();
    if (snapshot.exists) {
      return { snapshot, source };
    }
  }
  return null;
}

async function getStatePollContext(
  db,
  guildId,
  field,
  source,
) {
  const stateSnapshot = await stateRef(db, guildId, source).get();
  if (!stateSnapshot.exists) return null;

  const pollId = stateSnapshot.data()?.[field];
  if (!pollId) return null;

  const snapshot = await pollRef(db, pollId, source).get();
  if (!snapshot.exists) return null;

  return { snapshot, source };
}

async function getActivePollContext(db, guildId) {
  for (const source of SOURCES) {
    const context = await getStatePollContext(
      db,
      guildId,
      "activePollId",
      source,
    );
    if (context?.snapshot?.data()?.active) return context;
  }
  return null;
}

async function getCurrentOrLastPollContext(db, guildId) {
  const active = await getActivePollContext(db, guildId);
  if (active) return active;

  for (const source of SOURCES) {
    const context = await getStatePollContext(
      db,
      guildId,
      "lastPollId",
      source,
    );
    if (context) return context;
  }
  return null;
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
  source,
  { closed = false } = {},
) {
  const pollSnapshot = await pollRef(db, pollId, source).get();
  if (!pollSnapshot.exists) return;

  const poll = pollWithSourceDefaults(
    pollSnapshot.data() || {},
    source,
  );
  if (!poll.channelId || !poll.messageId) return;

  const proposalSnapshot = await proposalsRef(db, pollId, source).get();
  const channel = await fetchChannel(interaction, poll.channelId);
  if (!channel) return;

  const message = await channel.messages.fetch(poll.messageId).catch(() => null);
  if (!message) return;

  await message.edit({
    embeds: [buildMainEmbed(poll, proposalSnapshot.docs, { closed })],
    components: buildMainComponents(pollId, poll, source, closed),
  });
}

async function refreshProposalMessage(
  interaction,
  db,
  pollId,
  proposalId,
  source,
  { closed = false } = {},
) {
  const pollSnapshot = await pollRef(db, pollId, source).get();
  const proposalSnapshot = await proposalsRef(db, pollId, source)
    .doc(proposalId)
    .get();

  if (!pollSnapshot.exists || !proposalSnapshot.exists) return;

  const poll = pollWithSourceDefaults(
    pollSnapshot.data() || {},
    source,
  );
  const proposal = proposalSnapshot.data() || {};
  if (!proposal.channelId || !proposal.messageId) return;

  const channel = await fetchChannel(interaction, proposal.channelId);
  if (!channel) return;

  const message = await channel.messages
    .fetch(proposal.messageId)
    .catch(() => null);
  if (!message) return;

  await message.edit({
    embeds: [
      buildProposalEmbed(
        { id: proposalSnapshot.id, ...proposal },
        poll,
        { closed },
      ),
    ],
    components: buildVoteComponents(
      pollId,
      proposalId,
      poll,
      source,
      closed,
    ),
  });
}

function creationOptions(interaction, { legacySkinAlias = false } = {}) {
  if (legacySkinAlias) {
    return {
      title: String(
        interaction.options.getString("titre") ||
          "Quel sera le prochain skin de carte ?",
      ).trim(),
      description: "",
      proposalLabel: "skin",
      buttonLabel: "Proposer un skin",
      maxProposalsPerUser: DEFAULT_MAX_PROPOSALS_PER_USER,
      maxVotesPerUser: DEFAULT_MAX_VOTES_PER_USER,
      category: "card-skin",
    };
  }

  return {
    title: String(interaction.options.getString("titre") || "").trim(),
    description: String(
      interaction.options.getString("description") || "",
    ).trim(),
    proposalLabel: String(
      interaction.options.getString("libelle") || "proposition",
    ).trim(),
    buttonLabel: null,
    maxProposalsPerUser: clampInteger(
      interaction.options.getInteger("max_propositions"),
      DEFAULT_MAX_PROPOSALS_PER_USER,
      1,
      10,
    ),
    maxVotesPerUser: clampInteger(
      interaction.options.getInteger("max_votes"),
      DEFAULT_MAX_VOTES_PER_USER,
      1,
      5,
    ),
    category: "generic",
  };
}

async function createPoll(
  interaction,
  db,
  { legacySkinAlias = false } = {},
) {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "❌ Cette commande doit être utilisée sur un serveur.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const activePoll = await getActivePollContext(db, interaction.guildId);
  if (activePoll?.snapshot?.data()?.active) {
    await interaction.editReply(
      "❌ Un sondage communautaire est déjà actif. Clôture-le avant d'en créer un nouveau.",
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

  const options = creationOptions(interaction, { legacySkinAlias });
  if (!options.title) {
    await interaction.editReply("❌ Le titre du sondage est obligatoire.");
    return;
  }

  const reference = db.collection(GENERIC_SOURCE.pollsCollection).doc();
  const poll = {
    guildId: interaction.guildId,
    channelId: channel.id,
    messageId: null,
    title: options.title,
    description: options.description,
    proposalLabel: options.proposalLabel,
    buttonLabel: options.buttonLabel,
    maxProposalsPerUser: options.maxProposalsPerUser,
    maxVotesPerUser: options.maxVotesPerUser,
    category: options.category,
    interactionNamespace: GENERIC_SOURCE.customIdPrefix,
    status: "open",
    active: true,
    createdBy: interaction.user.id,
    createdAt: new Date(),
  };

  const message = await channel.send({
    embeds: [buildMainEmbed(poll, [])],
    components: buildMainComponents(
      reference.id,
      poll,
      GENERIC_SOURCE,
    ),
  });

  try {
    const batch = db.batch();
    batch.set(reference, { ...poll, messageId: message.id });
    batch.set(
      stateRef(db, interaction.guildId, GENERIC_SOURCE),
      {
        activePollId: reference.id,
        lastPollId: reference.id,
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
    `✅ Sondage créé dans ${channel}. Les membres peuvent maintenant proposer leurs idées.`,
  );
}

async function showProposalModal(interaction, db, pollId) {
  const context = await getPollContextById(db, pollId);
  if (!context || !context.snapshot.data()?.active) {
    await interaction.reply({
      content: "❌ Ce sondage est terminé ou n'existe plus.",
      ephemeral: true,
    });
    return;
  }

  const poll = pollWithSourceDefaults(
    context.snapshot.data() || {},
    context.source,
  );
  const label = getProposalLabel(poll);
  const modalTitle =
    label.toLowerCase() === "proposition"
      ? "Nouvelle proposition"
      : truncate(`Proposer : ${capitalize(label)}`, 45);

  const modal = new ModalBuilder()
    .setCustomId(
      buildCustomId(
        getNamespaceForPoll(poll, context.source),
        "modal",
        pollId,
      ),
    )
    .setTitle(modalTitle);

  const nameInput = new TextInputBuilder()
    .setCustomId("proposal_name")
    .setLabel(truncate(`Nom / titre — ${label}`, 45))
    .setPlaceholder("Ex. une idée, un jeu, un thème, une récompense...")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(80);

  const descriptionInput = new TextInputBuilder()
    .setCustomId("proposal_description")
    .setLabel("Description (facultatif)")
    .setPlaceholder("Ajoute quelques détails si nécessaire...")
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

  const context = await getPollContextById(db, pollId);
  if (!context || !context.snapshot.data()?.active) {
    await interaction.editReply("❌ Ce sondage est terminé ou n'existe plus.");
    return;
  }

  const source = context.source;
  const poll = pollWithSourceDefaults(
    context.snapshot.data() || {},
    source,
  );

  function readModalValue(primaryId, legacyId) {
    try {
      return interaction.fields.getTextInputValue(primaryId);
    } catch (_) {
      return interaction.fields.getTextInputValue(legacyId);
    }
  }

  const name = readModalValue("proposal_name", "skin_name").trim();
  const description = readModalValue(
    "proposal_description",
    "skin_description",
  ).trim();

  const normalizedName = normalizeProposalName(name);
  const proposalId = proposalIdFromName(name);
  const reference = proposalsRef(db, pollId, source).doc(proposalId);
  const maxProposals = getMaxProposals(poll);

  const ownProposals = await proposalsRef(db, pollId, source)
    .where("authorId", "==", interaction.user.id)
    .get();

  if (ownProposals.size >= maxProposals) {
    await interaction.editReply(
      `❌ Tu as déjà atteint la limite de ${maxProposals} proposition${maxProposals > 1 ? "s" : ""} pour ce sondage.`,
    );
    return;
  }

  await db.runTransaction(async (transaction) => {
    const latestPoll = await transaction.get(pollRef(db, pollId, source));
    const existing = await transaction.get(reference);

    if (!latestPoll.exists || !latestPoll.data()?.active) {
      throw new Error("POLL_CLOSED");
    }
    if (existing.exists) {
      throw new Error("DUPLICATE_PROPOSAL");
    }

    transaction.set(reference, {
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
  });

  const channel = await fetchChannel(interaction, poll.channelId);
  if (!channel) {
    await reference.delete().catch(() => {});
    await interaction.editReply(
      "❌ Impossible de retrouver le canal du sondage.",
    );
    return;
  }

  let message;
  try {
    message = await channel.send({
      embeds: [
        buildProposalEmbed(
          {
            name,
            description,
            authorId: interaction.user.id,
            voteCount: 0,
          },
          poll,
        ),
      ],
      components: buildVoteComponents(
        pollId,
        proposalId,
        poll,
        source,
      ),
    });
    await reference.update({
      messageId: message.id,
      channelId: channel.id,
    });
  } catch (error) {
    await reference.delete().catch(() => {});
    throw error;
  }

  await refreshMainMessage(interaction, db, pollId, source).catch((error) =>
    console.warn(
      "[community-poll] refresh main after proposal failed:",
      error?.message || error,
    ),
  );

  await interaction.editReply(
    `✅ **${name}** a été ajouté au sondage.`,
  );
}

function voteIdsFromData(data) {
  if (Array.isArray(data?.proposalIds)) {
    return data.proposalIds.filter(Boolean);
  }
  return data?.proposalId ? [data.proposalId] : [];
}

async function vote(interaction, db, pollId, proposalId) {
  await interaction.deferReply({ ephemeral: true });

  const context = await getPollContextById(db, pollId);
  if (!context) {
    await interaction.editReply("❌ Ce sondage n'existe plus.");
    return;
  }

  const source = context.source;
  const pollReference = pollRef(db, pollId, source);
  const proposalReference = proposalsRef(db, pollId, source).doc(proposalId);
  const userVoteReference = votesRef(db, pollId, source).doc(interaction.user.id);

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

    const pollData = currentPoll.data() || {};
    const maxVotes = getMaxVotes(pollData);
    const currentIds = voteIdsFromData(currentVote.data());
    const hasTarget = currentIds.includes(proposalId);

    let previousProposalId = null;
    let previousProposalReference = null;
    let previousProposal = null;

    if (!hasTarget && maxVotes === 1 && currentIds.length) {
      previousProposalId = currentIds[0];
      if (previousProposalId !== proposalId) {
        previousProposalReference = proposalsRef(
          db,
          pollId,
          source,
        ).doc(previousProposalId);
        previousProposal = await transaction.get(previousProposalReference);
      }
    }

    const targetCount = Math.max(
      0,
      Number(targetProposal.data()?.voteCount || 0),
    );

    if (hasTarget) {
      const nextIds = currentIds.filter((id) => id !== proposalId);
      if (nextIds.length) {
        transaction.set(
          userVoteReference,
          {
            proposalIds: nextIds,
            proposalId: nextIds[0] || null,
            userId: interaction.user.id,
            updatedAt: new Date(),
          },
          { merge: true },
        );
      } else {
        transaction.delete(userVoteReference);
      }

      transaction.update(proposalReference, {
        voteCount: Math.max(0, targetCount - 1),
      });

      return {
        action: "removed",
        changedProposalIds: [proposalId],
        maxVotes,
      };
    }

    if (maxVotes > 1 && currentIds.length >= maxVotes) {
      throw new Error("VOTE_LIMIT_REACHED");
    }

    let nextIds;
    const changedProposalIds = [proposalId];

    if (maxVotes === 1) {
      nextIds = [proposalId];

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
    } else {
      nextIds = [...currentIds, proposalId];
    }

    transaction.set(
      userVoteReference,
      {
        proposalIds: nextIds,
        proposalId: nextIds[0] || null,
        userId: interaction.user.id,
        updatedAt: new Date(),
      },
      { merge: true },
    );
    transaction.update(proposalReference, {
      voteCount: targetCount + 1,
    });

    return {
      action:
        maxVotes === 1 && currentIds.length ? "changed" : "added",
      changedProposalIds,
      maxVotes,
    };
  });

  await Promise.all(
    result.changedProposalIds.map((id) =>
      refreshProposalMessage(
        interaction,
        db,
        pollId,
        id,
        source,
      ).catch((error) =>
        console.warn(
          "[community-poll] refresh proposal failed:",
          error?.message || error,
        ),
      ),
    ),
  );

  await refreshMainMessage(interaction, db, pollId, source).catch((error) =>
    console.warn(
      "[community-poll] refresh main after vote failed:",
      error?.message || error,
    ),
  );

  const feedback = {
    added:
      result.maxVotes > 1
        ? `✅ Ton vote a été enregistré (${result.maxVotes} votes actifs maximum).`
        : "✅ Ton vote a été enregistré.",
    changed: "✅ Ton vote a été déplacé vers cette proposition.",
    removed: "✅ Ton vote a été retiré.",
  };

  await interaction.editReply(
    feedback[result.action] || "✅ Vote mis à jour.",
  );
}

async function showResults(interaction, db) {
  await interaction.deferReply({ ephemeral: true });

  const context = await getCurrentOrLastPollContext(
    db,
    interaction.guildId,
  );

  if (!context) {
    await interaction.editReply(
      "ℹ️ Aucun sondage communautaire n'a encore été créé.",
    );
    return;
  }

  const poll = pollWithSourceDefaults(
    context.snapshot.data() || {},
    context.source,
  );
  const proposals = await proposalsRef(
    db,
    context.snapshot.id,
    context.source,
  ).get();

  const sorted = sortProposals(proposals.docs);
  const embed = new EmbedBuilder()
    .setTitle(`📊 ${poll.title || "Résultats du sondage"}`)
    .setDescription(rankingText(sorted, RESULTS_RANKING_LIMIT))
    .setFooter({
      text: poll.active ? "Sondage en cours" : "Sondage terminé",
    });

  await interaction.editReply({ embeds: [embed] });
}

async function closePoll(interaction, db) {
  await interaction.deferReply({ ephemeral: true });

  const context = await getActivePollContext(db, interaction.guildId);
  if (!context || !context.snapshot.data()?.active) {
    await interaction.editReply(
      "ℹ️ Aucun sondage communautaire n'est actuellement actif.",
    );
    return;
  }

  const pollId = context.snapshot.id;
  const source = context.source;
  const pollReference = pollRef(db, pollId, source);

  await db.runTransaction(async (transaction) => {
    const latestPoll = await transaction.get(pollReference);
    if (!latestPoll.exists || !latestPoll.data()?.active) {
      throw new Error("POLL_CLOSED");
    }

    transaction.update(pollReference, {
      active: false,
      status: "closed",
      closedAt: new Date(),
      closedBy: interaction.user.id,
    });

    transaction.set(
      stateRef(db, interaction.guildId, source),
      {
        activePollId: null,
        lastPollId: pollId,
        updatedAt: new Date(),
      },
      { merge: true },
    );
  });

  const proposals = await proposalsRef(db, pollId, source).get();

  await refreshMainMessage(
    interaction,
    db,
    pollId,
    source,
    { closed: true },
  ).catch((error) =>
    console.warn(
      "[community-poll] close main refresh failed:",
      error?.message || error,
    ),
  );

  for (const doc of proposals.docs) {
    await refreshProposalMessage(
      interaction,
      db,
      pollId,
      doc.id,
      source,
      { closed: true },
    ).catch((error) =>
      console.warn(
        "[community-poll] close proposal refresh failed:",
        error?.message || error,
      ),
    );
  }

  const sorted = sortProposals(proposals.docs);
  const winner = sorted[0];
  const winnerVotes = Number(winner?.voteCount || 0);

  await interaction.editReply(
    winner
      ? `🏆 Sondage clôturé. **${winner.name}** arrive en tête avec **${winnerVotes} vote${winnerVotes > 1 ? "s" : ""}**.`
      : "✅ Sondage clôturé. Aucune proposition n'avait été ajoutée.",
  );
}

async function handleSlashCommand(interaction, db) {
  const legacySkinAlias =
    interaction.commandName === CARD_SKIN_POLL_COMMAND_NAME;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "creer") {
    await createPoll(interaction, db, { legacySkinAlias });
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

function parseComponentCustomId(customId) {
  const text = String(customId || "");
  const namespaces = [
    GENERIC_SOURCE.customIdPrefix,
    LEGACY_SOURCE.customIdPrefix,
  ];

  const namespace = namespaces.find((value) =>
    text.startsWith(`${value}:`),
  );
  if (!namespace) return null;

  const parts = text.split(":");
  if (parts.length < 3) return null;

  const action = parts[1];
  const pollId = parts[2];
  const proposalId = parts[3] || null;

  if (!["propose", "vote", "modal"].includes(action) || !pollId) {
    return null;
  }

  return {
    namespace,
    action,
    pollId,
    proposalId,
  };
}

const registeredClients = new WeakSet();

function registerCommunityPollEvents({ client }) {
  if (registeredClients.has(client)) return;
  registeredClients.add(client);

  const db = getFirestore();

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (
        interaction.isChatInputCommand?.() &&
        [
          COMMUNITY_POLL_COMMAND_NAME,
          CARD_SKIN_POLL_COMMAND_NAME,
        ].includes(interaction.commandName)
      ) {
        await handleSlashCommand(interaction, db);
        return;
      }

      if (interaction.isButton?.()) {
        const parsed = parseComponentCustomId(interaction.customId);
        if (!parsed) return;

        if (parsed.action === "propose") {
          await showProposalModal(interaction, db, parsed.pollId);
          return;
        }

        if (parsed.action === "vote" && parsed.proposalId) {
          await vote(
            interaction,
            db,
            parsed.pollId,
            parsed.proposalId,
          );
        }
        return;
      }

      if (interaction.isModalSubmit?.()) {
        const parsed = parseComponentCustomId(interaction.customId);
        if (!parsed || parsed.action !== "modal") return;

        await submitProposal(interaction, db, parsed.pollId);
      }
    } catch (error) {
      console.error(
        "[community-poll] interaction failed:",
        error?.message || error,
      );

      const messages = {
        DUPLICATE_PROPOSAL:
          "❌ Cette proposition existe déjà dans ce sondage.",
        POLL_CLOSED: "❌ Ce sondage est déjà terminé.",
        PROPOSAL_NOT_FOUND: "❌ Cette proposition n'existe plus.",
        VOTE_LIMIT_REACHED:
          "❌ Tu as atteint le nombre maximum de votes actifs. Retire d'abord un vote avant d'en ajouter un autre.",
      };

      const message =
        messages[error?.message] ||
        "❌ Une erreur est survenue pendant le traitement du sondage.";

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
  COMMUNITY_POLL_COMMAND_NAME,
  CARD_SKIN_POLL_COMMAND_NAME,
  registerCommunityPollEvents,
  parseComponentCustomId,
  normalizeProposalName,
};
