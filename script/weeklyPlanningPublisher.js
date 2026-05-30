"use strict";

const crypto = require("node:crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

const WEEKLY_PLANNING_DOC_PATH = Object.freeze({
  collection: "weekly_planning",
  id: "current",
});
const WEEKLY_PLANNING_ANNOUNCEMENTS_COLLECTION =
  "weekly_planning_announcements";
const WEEKLY_PLANNING_DEFAULT_TIMEZONE = "Europe/Brussels";
const WEEKLY_PLANNING_MAX_SLOTS_PER_DAY = 8;
const WEEKLY_PLANNING_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKLY_PLANNING_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PLANNING_BUTTON_PREFIX = "weekly_planning";

const WEEKLY_PLANNING_DAY_ORDER = Object.freeze([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const WEEKLY_PLANNING_DAY_LABELS_FR = Object.freeze({
  monday: "Lundi",
  tuesday: "Mardi",
  wednesday: "Mercredi",
  thursday: "Jeudi",
  friday: "Vendredi",
  saturday: "Samedi",
  sunday: "Dimanche",
});

function trimText(value) {
  return String(value ?? "").trim();
}

function sanitizeDiscordText(value, fallback = "") {
  return trimText(value || fallback).replace(/@/g, "@\u200b");
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function addUtcDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function dayKeyInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  let year = "0000";
  let month = "00";
  let day = "00";

  for (const part of parts) {
    if (part.type === "year") year = part.value;
    if (part.type === "month") month = part.value;
    if (part.type === "day") day = part.value;
  }

  return `${year}-${month}-${day}`;
}

function weekdayInTimezone(date, timeZone) {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  return (
    {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    }[short] ?? date.getUTCDay()
  );
}

function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatPlanningDateLabel(dayKey) {
  const normalized = normalizePlanningDate(dayKey);
  if (!normalized) return "";
  const [year, month, day] = normalized.split("-");
  return `${day}/${month}/${year}`;
}

function getPlanningWeekRange(timeZone, now = new Date()) {
  const safeTimeZone = trimText(timeZone) || WEEKLY_PLANNING_DEFAULT_TIMEZONE;
  const weekday = weekdayInTimezone(now, safeTimeZone);
  const daysSinceMonday = (weekday + 6) % 7;
  const startDate = addUtcDays(now, -daysSinceMonday);
  const endDate = addUtcDays(startDate, 6);
  const startKey = dayKeyInTimezone(startDate, safeTimeZone);
  const endKey = dayKeyInTimezone(endDate, safeTimeZone);

  return {
    startDate,
    endDate,
    startKey,
    endKey,
    weekKey: `${startKey}_${endKey}`,
    startLabel: formatDateLabel(startDate, safeTimeZone),
    endLabel: formatDateLabel(endDate, safeTimeZone),
  };
}

function createWeeklyPlanningDaysTemplate() {
  return WEEKLY_PLANNING_DAY_ORDER.reduce((acc, dayKey) => {
    acc[dayKey] = [];
    return acc;
  }, {});
}

function isValidPlanningTime(value) {
  return WEEKLY_PLANNING_TIME_RE.test(trimText(value));
}

function normalizePlanningDate(value) {
  const raw = trimText(value);
  if (!raw || !WEEKLY_PLANNING_DATE_RE.test(raw)) return null;
  const [year, month, day] = raw.split("-").map((part) => Number(part));
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return raw;
}

function planningTimeToMinutes(value) {
  const raw = trimText(value);
  if (!isValidPlanningTime(raw)) return Number.POSITIVE_INFINITY;
  const [hours, minutes] = raw.split(":").map((part) => Number(part));
  return hours * 60 + minutes;
}

function formatPlanningSlotTime(slot = {}) {
  const startTime = trimText(slot.startTime || slot.time);
  const endTime = trimText(slot.endTime);
  if (startTime && endTime) return `${startTime} - ${endTime}`;
  return startTime || "-";
}

function normalizePlanningSlot(slot = {}) {
  if (!slot || typeof slot !== "object") return null;

  const startTime = trimText(slot.startTime || slot.time);
  const endTime = trimText(slot.endTime);
  const title = sanitizeDiscordText(slot.title);
  const note = sanitizeDiscordText(slot.note);

  if (!isValidPlanningTime(startTime)) return null;
  if (endTime && !isValidPlanningTime(endTime)) return null;
  if (
    endTime &&
    planningTimeToMinutes(endTime) <= planningTimeToMinutes(startTime)
  ) {
    return null;
  }
  if (!title) return null;

  const payload = { startTime, title };
  if (endTime) payload.endTime = endTime;
  if (note) payload.note = note;
  return payload;
}

function sortPlanningSlotsByTime(a, b) {
  return planningTimeToMinutes(a?.startTime || a?.time) -
    planningTimeToMinutes(b?.startTime || b?.time);
}

function normalizeWeeklyPlanning(raw = {}) {
  const timezone =
    trimText(raw?.timezone) || WEEKLY_PLANNING_DEFAULT_TIMEZONE;
  const inputDays = raw?.days && typeof raw.days === "object" ? raw.days : {};
  const days = createWeeklyPlanningDaysTemplate();

  WEEKLY_PLANNING_DAY_ORDER.forEach((dayKey) => {
    const slots = Array.isArray(inputDays?.[dayKey]) ? inputDays[dayKey] : [];
    days[dayKey] = slots
      .map((slot) => normalizePlanningSlot(slot))
      .filter(Boolean)
      .sort(sortPlanningSlotsByTime)
      .slice(0, WEEKLY_PLANNING_MAX_SLOTS_PER_DAY);
  });

  return {
    timezone,
    days,
    monthlyDrawDate: normalizePlanningDate(raw?.monthlyDrawDate),
    updatedAt: raw?.updatedAt ?? null,
  };
}

function hashWeeklyPlanning(planning) {
  const stable = {
    timezone: planning?.timezone || WEEKLY_PLANNING_DEFAULT_TIMEZONE,
    days: planning?.days || createWeeklyPlanningDaysTemplate(),
    monthlyDrawDate: planning?.monthlyDrawDate || null,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex")
    .slice(0, 16);
}

function buildPlanningDescription(planning, range) {
  const lines = [
    `Semaine du **${range.startLabel}** au **${range.endLabel}**`,
  ];
  let activeSlots = 0;

  WEEKLY_PLANNING_DAY_ORDER.forEach((dayKey, index) => {
    const slots = Array.isArray(planning?.days?.[dayKey])
      ? planning.days[dayKey]
      : [];
    if (!slots.length) return;

    activeSlots += slots.length;
    const dayDate = addUtcDays(range.startDate, index);
    const dayLabel = WEEKLY_PLANNING_DAY_LABELS_FR[dayKey] || dayKey;
    lines.push("");
    lines.push(`**${dayLabel} ${formatDateLabel(dayDate, planning.timezone)}**`);
    slots.forEach((slot) => {
      const time = formatPlanningSlotTime(slot);
      const title = sanitizeDiscordText(slot.title, "Live");
      const note = sanitizeDiscordText(slot.note);
      lines.push(`• \`${time}\` ${title}${note ? ` — ${note}` : ""}`);
    });
  });

  if (!activeSlots) {
    lines.push("");
    lines.push("Aucun stream prévu pour le moment.");
  }

  if (planning?.monthlyDrawDate) {
    const drawLabel = formatPlanningDateLabel(planning.monthlyDrawDate);
    if (drawLabel) {
      lines.push("");
      lines.push(`🎁 Tirage mensuel : **${drawLabel} à 19h**`);
    }
  }

  return truncateText(lines.join("\n"), 3900);
}

function buildPlanningDraft(rawPlanning, { now = new Date(), timeZone } = {}) {
  const planning = normalizeWeeklyPlanning(rawPlanning || {});
  const effectiveTimeZone = trimText(timeZone) || planning.timezone;
  const range = getPlanningWeekRange(effectiveTimeZone, now);
  const planningHash = hashWeeklyPlanning(planning);
  const description = buildPlanningDescription(planning, range);
  const title = "Planning de la semaine";
  const content = `${title}\n\n${description}`;

  return {
    planning,
    range,
    weekKey: range.weekKey,
    planningHash,
    title,
    description,
    content,
  };
}

function buildPlanningButtonCustomId(action, weekKey, planningHash) {
  return [
    PLANNING_BUTTON_PREFIX,
    action,
    String(weekKey || ""),
    String(planningHash || ""),
  ].join(":");
}

function parsePlanningButtonCustomId(customId) {
  const parts = String(customId || "").split(":");
  if (parts.length !== 4 || parts[0] !== PLANNING_BUTTON_PREFIX) return null;
  const action = parts[1];
  if (action !== "approve" && action !== "reject") return null;
  return {
    action,
    weekKey: parts[2],
    planningHash: parts[3],
  };
}

function buildPlanningActionRow(draft, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildPlanningButtonCustomId(
          "approve",
          draft.weekKey,
          draft.planningHash,
        ),
      )
      .setLabel("Valider")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(
        buildPlanningButtonCustomId(
          "reject",
          draft.weekKey,
          draft.planningHash,
        ),
      )
      .setLabel("Refuser")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function buildPlanningMessagePayload(
  draft,
  { test = false, review = false, disabled = false } = {},
) {
  const embed = new EmbedBuilder()
    .setTitle(test ? "TEST - Planning de la semaine" : draft.title)
    .setDescription(draft.description)
    .setColor(test ? 0xf59e0b : review ? 0x60a5fa : 0x8b5cf6)
    .setFooter({
      text: `Semaine ${draft.range.startKey} -> ${draft.range.endKey}`,
    })
    .setTimestamp(new Date());

  const content = test
    ? "🧪 **TEST - non publié**"
    : review
      ? "📝 **Brouillon planning à valider**"
      : "🗓️ **Planning de la semaine**";

  return {
    content,
    embeds: [embed],
    components: review ? [buildPlanningActionRow(draft, { disabled })] : [],
    allowedMentions: { parse: [] },
  };
}

function normalizeApproverIds(value) {
  const source = Array.isArray(value) ? value.join(",") : String(value || "");
  return new Set(
    source
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function isPlanningApprover(member, userId, config = {}) {
  const approverIds = normalizeApproverIds(
    config?.planning?.approverUserIds || process.env.PLANNING_APPROVER_USER_IDS,
  );
  if (userId && approverIds.has(String(userId))) return true;
  return Boolean(member?.permissions?.has?.("ManageGuild"));
}

function fieldDelete(admin) {
  return admin?.firestore?.FieldValue?.delete
    ? admin.firestore.FieldValue.delete()
    : undefined;
}

function serverTimestamp(admin) {
  return admin?.firestore?.FieldValue?.serverTimestamp
    ? admin.firestore.FieldValue.serverTimestamp()
    : new Date();
}

function createError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function createWeeklyPlanningPublisher({
  db,
  admin,
  client,
  config,
  defaultReviewChannelId,
  defaultPublicChannelId,
  timeZone,
}) {
  if (!db || !client) {
    throw new Error("createWeeklyPlanningPublisher: missing db/client");
  }

  const reviewChannelId =
    defaultReviewChannelId ||
    config?.planning?.reviewChannelId ||
    config?.discord?.logChannelId;
  const publicChannelId =
    defaultPublicChannelId ||
    config?.planning?.publicChannelId ||
    config?.discord?.announcementChannelId;
  const safeTimeZone =
    trimText(timeZone) || trimText(config?.timezone) || WEEKLY_PLANNING_DEFAULT_TIMEZONE;

  const stateDoc = (weekKey) =>
    db.collection(WEEKLY_PLANNING_ANNOUNCEMENTS_COLLECTION).doc(weekKey);

  async function loadCurrentDraft({ now = new Date() } = {}) {
    const snap = await db
      .collection(WEEKLY_PLANNING_DOC_PATH.collection)
      .doc(WEEKLY_PLANNING_DOC_PATH.id)
      .get();
    const raw = snap.exists ? snap.data() : {};
    return buildPlanningDraft(raw || {}, {
      now,
      timeZone: safeTimeZone,
    });
  }

  async function fetchTextChannel(channelId) {
    if (!channelId) throw createError("Canal Discord manquant.", "MISSING_CHANNEL");
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased?.()) {
      throw createError(`Canal Discord invalide: ${channelId}`, "INVALID_CHANNEL");
    }
    return channel;
  }

  async function sendPlanningTest({ channelId = reviewChannelId, now = new Date() } = {}) {
    const draft = await loadCurrentDraft({ now });
    const channel = await fetchTextChannel(channelId);
    const message = await channel.send(
      buildPlanningMessagePayload(draft, { test: true }),
    );
    return { draft, message };
  }

  async function createPlanningPreview({
    channelId = reviewChannelId,
    requestedBy = null,
    source = "manual",
    now = new Date(),
  } = {}) {
    const draft = await loadCurrentDraft({ now });
    const docRef = stateDoc(draft.weekKey);
    const existingSnap = await docRef.get();
    if (existingSnap.exists) {
      const existing = existingSnap.data() || {};
      const status = String(existing.status || "");
      if (
        existing.planningHash === draft.planningHash &&
        (status === "pending" || status === "processing" || status === "sent")
      ) {
        return { draft, skipped: true, reason: status };
      }
    }

    const channel = await fetchTextChannel(channelId);
    const payload = buildPlanningMessagePayload(draft, { review: true });
    const message = await channel.send(payload);

    await docRef.set(
      {
        status: "pending",
        planningHash: draft.planningHash,
        content: draft.content,
        rangeStart: draft.range.startKey,
        rangeEnd: draft.range.endKey,
        previewChannelId: channelId,
        previewMessageId: message?.id || null,
        previewMessageUrl: message?.url || null,
        publicChannelId,
        requestedBy: requestedBy || null,
        source,
        error: fieldDelete(admin),
        createdAt: serverTimestamp(admin),
        updatedAt: serverTimestamp(admin),
      },
      { merge: true },
    );

    return { draft, message, skipped: false };
  }

  async function schedulePlanningPreview() {
    return createPlanningPreview({
      channelId: reviewChannelId,
      source: "cron",
    });
  }

  async function approvePlanning({
    weekKey,
    planningHash,
    approvedBy,
    now = new Date(),
  }) {
    const draft = await loadCurrentDraft({ now });
    if (draft.weekKey !== weekKey || draft.planningHash !== planningHash) {
      throw createError(
        "Ce brouillon n'est plus à jour. Regénère un preview du planning.",
        "STALE_PLANNING",
      );
    }

    const docRef = stateDoc(weekKey);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) {
        throw createError("Brouillon planning introuvable.", "MISSING_DRAFT");
      }
      const data = snap.data() || {};
      if (data.planningHash !== planningHash) {
        throw createError("Hash planning invalide.", "STALE_PLANNING");
      }
      if (String(data.status || "") !== "pending") {
        throw createError(
          `Brouillon déjà traité (${data.status || "unknown"}).`,
          "DRAFT_NOT_PENDING",
        );
      }
      tx.update(docRef, {
        status: "processing",
        approvedBy: approvedBy || null,
        approvedAt: serverTimestamp(admin),
        updatedAt: serverTimestamp(admin),
        error: fieldDelete(admin),
      });
    });

    try {
      const channel = await fetchTextChannel(publicChannelId);
      const message = await channel.send(buildPlanningMessagePayload(draft));
      await docRef.update({
        status: "sent",
        publicChannelId,
        publicMessageId: message?.id || null,
        publicMessageUrl: message?.url || null,
        sentAt: serverTimestamp(admin),
        updatedAt: serverTimestamp(admin),
        error: fieldDelete(admin),
      });
      return { draft, message };
    } catch (err) {
      await docRef.update({
        status: "error",
        error: truncateText(err?.stack || err?.message || err, 1500),
        updatedAt: serverTimestamp(admin),
      });
      throw err;
    }
  }

  async function rejectPlanning({ weekKey, planningHash, rejectedBy }) {
    const docRef = stateDoc(weekKey);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) {
        throw createError("Brouillon planning introuvable.", "MISSING_DRAFT");
      }
      const data = snap.data() || {};
      if (data.planningHash !== planningHash) {
        throw createError("Hash planning invalide.", "STALE_PLANNING");
      }
      if (String(data.status || "") !== "pending") {
        throw createError(
          `Brouillon déjà traité (${data.status || "unknown"}).`,
          "DRAFT_NOT_PENDING",
        );
      }
      tx.update(docRef, {
        status: "rejected",
        rejectedBy: rejectedBy || null,
        rejectedAt: serverTimestamp(admin),
        updatedAt: serverTimestamp(admin),
      });
    });
    return { weekKey, planningHash };
  }

  return {
    loadCurrentDraft,
    sendPlanningTest,
    createPlanningPreview,
    schedulePlanningPreview,
    approvePlanning,
    rejectPlanning,
  };
}

module.exports = {
  WEEKLY_PLANNING_ANNOUNCEMENTS_COLLECTION,
  buildPlanningDraft,
  buildPlanningMessagePayload,
  createWeeklyPlanningPublisher,
  getPlanningWeekRange,
  hashWeeklyPlanning,
  isPlanningApprover,
  normalizeWeeklyPlanning,
  parsePlanningButtonCustomId,
};
