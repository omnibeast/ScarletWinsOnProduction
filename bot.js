/* eslint-disable no-console */
"use strict";

/**
 * TELEGRAM GAME ACCOUNT MANAGER BOT - PRODUCTION READY
 *
 * Tech Stack: Node.js + node-telegram-bot-api
 * Polling Mode ONLY (no webhooks, no Mini Apps)
 * Single File: bot.js
 * Persistence: Telegram messages in Forum Topics + in-memory Maps
 * Source of Truth: Telegram messages (never deleted, only edited)
 *
 * CORE ARCHITECTURE:
 * - ONE Telegram supergroup with Forum Topics enabled
 * - Each topic acts as a database table
 * - Bot must be ADMIN in the group
 * - Inline keyboards ONLY (no reply keyboards)
 * - ALL persistence via SYSTEM_BACKUPS topic snapshots
 * - On restart: restore from pinned snapshot message
 *
 * FLOW RULES:
 * - Load Balance: ONE message ONLY (edit throughout flow)
 * - Cashout: ONE message ONLY (edit throughout flow)
 * - No new messages until flow complete
 * - All actions auditable
 */

// =========================
// CONFIG (PLACEHOLDERS ONLY)
// =========================
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN || "8370829137:AAHQHXqLlh4uLTjNqInbj_iXDQ07n3vQYPQ";
const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID || "-1003733011913");

const TOPIC_THREAD_IDS = {
  ACCOUNT_INVENTORY: 4,
  LOAD_APPROVALS: 6,
  WITHDRAW_APPROVALS: 8,
  TRANSACTION_LOGS: 10,
  EMAIL_LOGS: 12,
  PROMOTIONS: 2,
  MANAGE_GAMES: 20,
  PAYMENT_CONFIG: 57,
  ADMIN_USER_MSGS: 59,
  SUPPORT_TICKETS: 186,
  SYSTEM_BACKUPS: 92,
};

// =========================
// GAME SYSTEM (FIXED)
// =========================
const DEFAULT_GAMES = [
  { id: "GameA", name: "Game A", status: "ACTIVE", download_link: "https://example.com/download/gameA" },
  { id: "GameB", name: "Game B", status: "ACTIVE", download_link: "https://example.com/download/gameB" },
  { id: "GameC", name: "Game C", status: "DISABLED", download_link: "https://example.com/download/gameC" },
];

// =========================
// BOT INIT (POLLING ONLY)
// =========================
if (!BOT_TOKEN || BOT_TOKEN === "BOT_TOKEN") {
  console.error("❌ BOT_TOKEN placeholder not set.");
  process.exit(1);
}
if (!ADMIN_GROUP_ID || Number.isNaN(ADMIN_GROUP_ID)) {
  console.error("❌ ADMIN_GROUP_ID placeholder not set (must be numeric).");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    interval: 300,
    params: { timeout: 30 },
  },
});

// Add error handlers for polling
bot.on("polling_error", (err) => {
  console.error(`[POLLING ERROR] ${err.code}: ${err.message}`);
});

bot.on("polling_start", () => {
  console.log("[POLLING] Started successfully");
});

bot.on("error", (err) => {
  console.error(`[BOT ERROR] ${err.message}`);
});

// =========================
// CONSTANTS / LIMITS
// =========================
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000; // periodic snapshots
const ADMIN_CACHE_TTL_MS = 2 * 60 * 1000;
// SNAPSHOT lines must contain JSON that can be parsed on restart.

// =========================
// IN-MEMORY STATE (REHYDRATED)
// =========================
/** @type {number|null} */
let BOT_ID = null;
/** @type {string|null} */
let BOT_USERNAME = null;

// Canonical records are always bot-sent messages in their topics (so we can edit them).
// Admins can "add/update" by posting formatted messages; bot ingests and updates canonical bot messages.

/** @type {Map<string, {id:string,name:string,status:"ACTIVE"|"DISABLED"|"ARCHIVED", message_id:number}>} */
const gamesById = new Map();

/**
 * Inventory by canonical message id.
 * @type {Map<number, {game:string, username:string, password:string, status:"AVAILABLE"|"ASSIGNED", assigned_to?:number, assigned_at?:string}>}
 */
const accountsByMsgId = new Map();
/** @type {Map<string, number[]>} gameId -> FIFO queue of AVAILABLE canonical inventory message_ids (sorted asc) */
const availableQueueByGame = new Map();

/**
 * userKey = `${userId}::${gameId}`
 * @type {Map<string, {inventory_message_id:number, username:string, password:string, assigned_at:string}>}
 */
const assignedByUserGame = new Map();

/**
 * Known users store selection + email in values (persists via snapshot in KnownUsers JSON).
 * @type {Map<number, {user_id:number, username?:string, first_name?:string, last_name?:string, first_seen:string, last_seen:string, selected_game?:string|null, email?:string|null}>}
 */
const knownUsers = new Map();

/**
 * Payment QR config per game+method (key = `${game}::${method}`).
 * Each entry: { game, method, type: "photo"|"document", file_id, message_id }
 * Admin sets via PAYMENT_CONFIG topic with caption: PAYMENT_QR | game=GameA | method=CashApp
 */
const paymentQRs = new Map();

/**
 * Disabled payment methods (key = `${game}::${method}`, value = true if disabled).
 * Admin controls via PAYMENT_CONFIG topic messages:
 * - PAYMENT_METHOD_DISABLE | game=GameA | method=CashApp
 * - PAYMENT_METHOD_ENABLE | game=GameA | method=CashApp
 */
const disabledMethods = new Map();

/**
 * Approval requests (ephemeral, restored via snapshot+inflight only).
 * @type {Map<string, {
 *   request_id:string,
 *   type:"LOAD"|"CASHOUT",
 *   game:string,
 *   user_id:number,
 *   username:string,
 *   amount:number,
 *   cashtag?:string,
 *   created_at:string,
 *   status:"PENDING"|"APPROVED"|"REJECTED",
 *   decision_at?:string,
 *   decision_by?:string,
 *   reason?:string,
 *   approvals_topic_message_id?:number,
 *   approvals_topic_thread_id?:number,
 *   user_flow_chat_id?:number,
 *   user_flow_message_id?:number,
 *   screenshot_file_id?:string,
 *   receiving_qr_file_id?:string,
 *   receiving_qr_type?: "photo"|"document"
 * }>}
 */
const approvalRequests = new Map();

// Private chat single-message flows
/**
 * @type {Map<number, {
 *   kind:"LOAD"|"CASHOUT"|"EMAIL",
 *   chat_id:number,
 *   message_id:number,
 *   step:string,
 *   game?:string,
 *   username?:string,
 *   amount?:number,
 *   cashtag?:string,
 *   paid_screenshot_file_id?:string,
 *   receiving_qr_file_id?:string,
 *   receiving_qr_type?: "photo"|"document",
 *   started_at:string,
 *   request_id?:string
 * }>}
 */
const userFlows = new Map();

/**
 * Support tickets (user→admin communication).
 * @type {Map<string, {
 *   ticket_id:string,
 *   user_id:number,
 *   username?:string,
 *   first_name?:string,
 *   subject:string,
 *   message:string,
 *   created_at:string,
 *   status:"OPEN"|"RESOLVED"|"CLOSED",
 *   replies:Array<{by:string, text:string, timestamp:string}>,
 *   message_thread_id?:number
 * }>}
 */
const supportTickets = new Map();// Admin interactive states (reject reason, promo text, msguser steps)
/**
 * @type {Map<number, { kind:"REJECT_REASON", request_id:string, topic_thread_id:number, approvals_message_id:number } | { kind:"PROMO_TEXT" } | { kind:"MSGUSER_USERID" } | { kind:"MSGUSER_TEXT", target_user_id:number } >}
 */
const adminInputs = new Map();

// Admin check cache
/** @type {Map<number, { ok:boolean, checked_at:number }>} */
const adminCheckCache = new Map();

// =========================
// UTILITIES
// =========================
function isoNow() {
  return new Date().toISOString();
}

function isPrivate(msg) {
  return msg?.chat?.type === "private";
}

function isGroup(msg) {
  const t = msg?.chat?.type;
  return t === "supergroup" || t === "group";
}

function isAdminGroupMessage(msg) {
  return msg?.chat?.id === ADMIN_GROUP_ID;
}

function getThreadId(msg) {
  return typeof msg?.message_thread_id === "number" ? msg.message_thread_id : null;
}

function safeText(s) {
  return (s ?? "").toString();
}

function json(obj) {
  return JSON.stringify(obj);
}

function validateTopicThreadIdsOrExit() {
  const bad = [];
  for (const [k, v] of Object.entries(TOPIC_THREAD_IDS)) {
    if (!Number.isInteger(v) || v <= 0) bad.push(`${k}=${v}`);
  }
  if (bad.length) {
    console.error("❌ TOPIC_THREAD_IDS must be set to valid forum topic thread IDs (positive integers):");
    for (const b of bad) console.error(`   - ${b}`);
    process.exit(1);
  }
}

function normalizeAmount(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function validateEmail(email) {
  const e = safeText(email).trim();
  // Reasonably strict without being hostile.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e);
}

function makeUserGameKey(userId, gameId) {
  return `${userId}::${gameId}`;
}

function shortUserLabel(user) {
  const u = user?.username ? `@${user.username}` : null;
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return u || name || `user:${user?.id ?? "?"}`;
}

function adminIdentity(from) {
  const uname = from?.username ? `@${from.username}` : null;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim();
  const label = uname || name || `id:${from?.id ?? "?"}`;
  return `${label} (${from?.id ?? "?"})`;
}

function mustBeTopic(msg, threadIdExpected) {
  return isAdminGroupMessage(msg) && getThreadId(msg) === threadIdExpected;
}

function cb(parts) {
  return parts.join("|").slice(0, 64);
}

function parseCb(data) {
  return safeText(data).split("|");
}

async function answerCb(id, text) {
  try {
    await bot.answerCallbackQuery(id, { text: safeText(text).slice(0, 200) });
  } catch {
    // ignore
  }
}

async function answerCbAlert(id, text) {
  try {
    await bot.answerCallbackQuery(id, { text: safeText(text).slice(0, 200), show_alert: true });
  } catch {
    // ignore
  }
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const retryAfter = e?.response?.body?.parameters?.retry_after;
    if (typeof retryAfter === "number" && retryAfter > 0 && retryAfter < 60) {
      await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
      return await fn();
    }
    throw e;
  }
}

async function safeEditText(chatId, messageId, text, replyMarkup) {
  try {
    return await withRetry(() =>
      bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: replyMarkup || undefined,
      }),
    );
  } catch (e) {
    const m = safeText(e?.message);
    if (m.includes("message is not modified")) return null;
    console.warn("editMessageText failed:", m);
    return null;
  }
}

async function safeEditCaption(chatId, messageId, caption, replyMarkup) {
  try {
    return await withRetry(() =>
      bot.editMessageCaption(caption, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: replyMarkup || undefined,
      }),
    );
  } catch (e) {
    const m = safeText(e?.message);
    if (m.includes("message is not modified")) return null;
    console.warn("editMessageCaption failed:", m);
    return null;
  }
}

async function safeEditMedia(chatId, messageId, media, replyMarkup) {
  try {
    return await withRetry(() =>
      bot.editMessageMedia(media, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup || undefined,
      }),
    );
  } catch (e) {
    const m = safeText(e?.message);
    if (m.includes("message is not modified")) return null;
    console.warn("editMessageMedia failed:", m);
    return null;
  }
}

async function safeEditReplyMarkup(chatId, messageId, replyMarkup) {
  try {
    return await withRetry(() =>
      bot.editMessageReplyMarkup(replyMarkup || { inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: messageId,
      }),
    );
  } catch (e) {
    const m = safeText(e?.message);
    if (m.includes("message is not modified")) return null;
    console.warn("editMessageReplyMarkup failed:", m);
    return null;
  }
}

function topicSendOpts(topicThreadId) {
  return { message_thread_id: topicThreadId, disable_web_page_preview: true };
}

async function sendToTopicText(topicThreadId, text, extra = {}) {
  return await withRetry(() =>
    bot.sendMessage(ADMIN_GROUP_ID, text, { ...topicSendOpts(topicThreadId), parse_mode: "HTML", ...extra }),
  );
}

async function sendToTopicPhoto(topicThreadId, fileId, caption, extra = {}) {
  return await withRetry(() =>
    bot.sendPhoto(ADMIN_GROUP_ID, fileId, {
      ...topicSendOpts(topicThreadId),
      caption,
      parse_mode: "HTML",
      ...extra,
    }),
  );
}

async function sendToTopicDocument(topicThreadId, fileId, caption, extra = {}) {
  return await withRetry(() =>
    bot.sendDocument(ADMIN_GROUP_ID, fileId, {
      ...topicSendOpts(topicThreadId),
      caption,
      parse_mode: "HTML",
      ...extra,
    }),
  );
}

function ensureQueue(gameId) {
  if (!availableQueueByGame.has(gameId)) availableQueueByGame.set(gameId, []);
  return availableQueueByGame.get(gameId);
}

function queueAddAvailable(gameId, messageId) {
  const q = ensureQueue(gameId);
  if (!q.includes(messageId)) q.push(messageId);
  q.sort((a, b) => a - b);
}

function queueRemove(gameId, messageId) {
  const q = ensureQueue(gameId);
  const idx = q.indexOf(messageId);
  if (idx >= 0) q.splice(idx, 1);
}

function getActiveGamesForUsers() {
  const arr = [];
  for (const g of gamesById.values()) {
    if (g.status === "ACTIVE") arr.push(g);
  }
  arr.sort((a, b) => a.id.localeCompare(b.id));
  return arr;
}

function formatGameLine(g) {
  return `GAME | id=${g.id} | name=${g.name} | status=${g.status} | download_link=${g.download_link || ""}`;
}

function parseKVLine(line, prefix) {
  const t = safeText(line).trim();
  if (!t.startsWith(prefix)) return null;
  const parts = t.split("|").map(s => s.trim());
  const out = {};
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function parseGameMessage(text) {
  const kv = parseKVLine(text, "GAME |");
  if (!kv) return null;
  if (!kv.id || !kv.name || !kv.status) return null;
  const status = kv.status;
  if (!["ACTIVE", "DISABLED", "ARCHIVED"].includes(status)) return null;
  return { id: kv.id, name: kv.name, status, download_link: kv.download_link || "" };
}

function formatAccountAvailableLine(game, username, password) {
  return `ACCOUNT | game=${game} | username=${username} | password=${password} | status=AVAILABLE`;
}

function formatAccountAssignedLine(game, username, password, assignedTo, assignedAtIso) {
  return `ACCOUNT | game=${game} | username=${username} | password=${password} | status=ASSIGNED | assigned_to=${assignedTo} | assigned_at=${assignedAtIso}`;
}

function parseAccountMessage(text) {
  const kv = parseKVLine(text, "ACCOUNT |");
  if (!kv) return null;
  if (!kv.game || !kv.username || !kv.password || !kv.status) return null;
  const status = kv.status;
  if (!["AVAILABLE", "ASSIGNED"].includes(status)) return null;
  const assigned_to = kv.assigned_to ? Number(kv.assigned_to) : undefined;
  const assigned_at = kv.assigned_at ? kv.assigned_at : undefined;
  return {
    game: kv.game,
    username: kv.username,
    password: kv.password,
    status,
    assigned_to: Number.isFinite(assigned_to) ? assigned_to : undefined,
    assigned_at: assigned_at || undefined,
  };
}

function pickBestPhotoFileId(photoArr) {
  if (!Array.isArray(photoArr) || photoArr.length === 0) return null;
  const p = photoArr[photoArr.length - 1];
  return p?.file_id || null;
}

function buildGamePickerKeyboard() {
  const games = getActiveGamesForUsers();
  const rows = [];
  for (const g of games) {
    rows.push([{ text: `🎮 ${g.name}`, callback_data: cb(["U", "GAME", g.id]) }]);
  }
  rows.push([{ text: "🔄 Refresh", callback_data: cb(["U", "REFRESH_GAMES"]) }]);
  return { inline_keyboard: rows };
}

function buildGameDownloadsKeyboard() {
  const games = getActiveGamesForUsers();
  const rows = [];
  for (const g of games) {
    if (g.download_link) {
      rows.push([{ text: `📥 ${g.name}`, url: g.download_link }]);
    }
  }
  rows.push([{ text: "🔙 Back", callback_data: cb(["U", "MENU", "MAIN"]) }]);
  return { inline_keyboard: rows };
}

function renderGameDownloadsText() {
  const games = getActiveGamesForUsers();
  const lines = ["📥 <b>Game Downloads</b>", "", "Available games:"];
  for (const g of games) {
    if (g.download_link) {
      lines.push(`🎮 <b>${g.name}</b>`);
      lines.push(`🔗 <code>${g.download_link}</code>`);
    }
  }
  return lines.join("\n");
}

function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🧾 Register Account", callback_data: cb(["U", "MENU", "REGISTER"]) }],
      [{ text: "👤 View My Account", callback_data: cb(["U", "MENU", "VIEW"]) }],
      [{ text: "🟦 Load Balance", callback_data: cb(["U", "MENU", "LOAD"]) }],
      [{ text: "🟩 Cashout", callback_data: cb(["U", "MENU", "CASHOUT"]) }],
      [{ text: "� Game Downloads", callback_data: cb(["U", "MENU", "DOWNLOADS"]) }],
      [{ text: "�💬 Support", callback_data: cb(["U", "MENU", "SUPPORT"]) }],
      [{ text: "🎮 Change Game", callback_data: cb(["U", "MENU", "CHANGE_GAME"]) }],
    ],
  };
}

function buildFlowNavKeyboard(flowKind) {
  const rows = [];
  rows.push([{ text: "✖ Cancel", callback_data: cb(["U", "FLOW", flowKind, "CANCEL"]) }]);
  return { inline_keyboard: rows };
}

function buildLoadStepKeyboard(step, canProceed) {
  const rows = [];
  if (step === "QR_WAIT_PAID") {
    rows.push([{ text: "✅ I Have Paid", callback_data: cb(["U", "FLOW", "LOAD", "PAID"]) }]);
  }
  if (step === "DONE") {
    rows.push([{ text: "🏠 Back to Menu", callback_data: cb(["U", "FLOW", "LOAD", "MENU"]) }]);
  }
  if (canProceed === true && step === "WAIT_SCREENSHOT") {
    rows.push([{ text: "🔁 Re-check", callback_data: cb(["U", "FLOW", "LOAD", "RENDER"]) }]);
  }
  rows.push([{ text: "✖ Cancel", callback_data: cb(["U", "FLOW", "LOAD", "CANCEL"]) }]);
  return { inline_keyboard: rows };
}

function buildPaymentMethodKeyboard(gameId) {
  const methodKeys = Array.from(paymentQRs.keys()).filter(k => k.startsWith(`${gameId}::`));
  const methods = methodKeys
    .map(k => k.split("::")[1])
    .filter(m => !disabledMethods.get(`${gameId}::${m}`));
  const rows = methods.map(m => [{ text: m, callback_data: cb(["U", "PAYMETHOD", m, gameId]) }]);
  rows.push([{ text: "↩ Back", callback_data: cb(["U", "FLOW", "LOAD", "RENDER"]) }]);
  return { inline_keyboard: rows };
}

function buildCashoutStepKeyboard(step) {
  const rows = [];
  if (step === "DONE") {
    rows.push([{ text: "🏠 Back to Menu", callback_data: cb(["U", "FLOW", "CASHOUT", "MENU"]) }]);
  }
  rows.push([{ text: "✖ Cancel", callback_data: cb(["U", "FLOW", "CASHOUT", "CANCEL"]) }]);
  return { inline_keyboard: rows };
}

function buildEmailKeyboard(step) {
  const rows = [];
  if (step === "DONE") rows.push([{ text: "🏠 Back to Menu", callback_data: cb(["U", "FLOW", "EMAIL", "MENU"]) }]);
  rows.push([{ text: "✖ Cancel", callback_data: cb(["U", "FLOW", "EMAIL", "CANCEL"]) }]);
  return { inline_keyboard: rows };
}

function buildAdminApproveRejectKeyboard(requestId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: cb(["A", "APP", "OK", requestId]) },
        { text: "❌ Reject", callback_data: cb(["A", "APP", "NO", requestId]) },
      ],
    ],
  };
}

function buildAdminRejectCancelKeyboard(requestId) {
  return {
    inline_keyboard: [[{ text: "↩ Cancel Reject", callback_data: cb(["A", "APP", "RC", requestId]) }]],
  };
}

function buildAdminGameControlsKeyboard(gameId, status) {
  const rows = [];
  if (status !== "ACTIVE") rows.push([{ text: "✅ Enable", callback_data: cb(["A", "GAME", gameId, "ACTIVE"]) }]);
  if (status !== "DISABLED") rows.push([{ text: "🚫 Disable", callback_data: cb(["A", "GAME", gameId, "DISABLED"]) }]);
  if (status !== "ARCHIVED") rows.push([{ text: "🗄 Archive", callback_data: cb(["A", "GAME", gameId, "ARCHIVED"]) }]);
  return { inline_keyboard: rows };
}

// =========================
// ADMIN AUTH
// =========================
async function isAdmin(userId) {
  const cached = adminCheckCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.checked_at < ADMIN_CACHE_TTL_MS) return cached.ok;
  try {
    const m = await bot.getChatMember(ADMIN_GROUP_ID, userId);
    const ok = m && (m.status === "administrator" || m.status === "creator");
    adminCheckCache.set(userId, { ok: !!ok, checked_at: now });
    return !!ok;
  } catch {
    adminCheckCache.set(userId, { ok: false, checked_at: now });
    return false;
  }
}

// =========================
// SNAPSHOTS (SYSTEM_BACKUPS)
// =========================
function snapshotObject() {
  const games = Array.from(gamesById.entries());
  const accounts = Array.from(accountsByMsgId.entries());
  const assigned = Array.from(assignedByUserGame.entries());
  const users = Array.from(knownUsers.entries());
  const qrs = Array.from(paymentQRs.entries());
  const disabled = Array.from(disabledMethods.entries());
  const tickets = Array.from(supportTickets.entries());
  return { games, accounts, assigned, users, qrs, disabled, tickets };
}

function buildSnapshotText() {
  const snap = snapshotObject();
  // REQUIRED FORMAT (exact headers)
  return [
    "SNAPSHOT",
    "Type: STATE",
    `Timestamp: ${isoNow()}`,
    `Games: ${json(snap.games)}`,
    `Accounts: ${json(snap.accounts)}`,
    `AssignedMap: ${json(snap.assigned)}`,
    `KnownUsers: ${json(snap.users)}`,
    `PaymentQRs: ${json(snap.qrs)}`,
    `DisabledMethods: ${json(snap.disabled)}`,
    `SupportTickets: ${json(snap.tickets)}`,
  ].join("\n");
}

function parseSnapshotText(text) {
  const t = safeText(text);
  if (!t.startsWith("SNAPSHOT\n")) return null;
  const lines = t.split("\n");
  const getLine = (prefix) => lines.find(l => l.startsWith(prefix));
  const gamesLine = getLine("Games: ");
  const accountsLine = getLine("Accounts: ");
  const assignedLine = getLine("AssignedMap: ");
  const usersLine = getLine("KnownUsers: ");
  const qrsLine = getLine("PaymentQRs: ");
  const disabledLine = getLine("DisabledMethods: ");
  const ticketsLine = getLine("SupportTickets: ");
  if (!gamesLine || !accountsLine || !assignedLine || !usersLine || !qrsLine) return null;
  const parseJson = (line) => {
    const idx = line.indexOf(": ");
    if (idx === -1) return null;
    const payload = line.slice(idx + 2).trim();
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  };
  return {
    games: parseJson(gamesLine),
    accounts: parseJson(accountsLine),
    assigned: parseJson(assignedLine),
    users: parseJson(usersLine),
    qrs: parseJson(qrsLine),
    disabled: disabledLine ? parseJson(disabledLine) : [],
    tickets: ticketsLine ? parseJson(ticketsLine) : [],
  };
}

function rehydrateFromSnapshot(parsed) {
  if (!parsed) return false;
  if (!Array.isArray(parsed.games)) return false;
  if (!Array.isArray(parsed.accounts)) return false;
  if (!Array.isArray(parsed.assigned)) return false;
  if (!Array.isArray(parsed.users)) return false;
  if (!Array.isArray(parsed.qrs)) return false;

  gamesById.clear();
  accountsByMsgId.clear();
  assignedByUserGame.clear();
  knownUsers.clear();
  paymentQRs.clear();
  disabledMethods.clear();
  supportTickets.clear();
  availableQueueByGame.clear();

  for (const [id, g] of parsed.games) {
    if (!g || !id) continue;
    gamesById.set(id, g);
  }

  for (const [msgId, acc] of parsed.accounts) {
    if (!acc || !msgId) continue;
    accountsByMsgId.set(Number(msgId), acc);
    if (acc.status === "AVAILABLE") queueAddAvailable(acc.game, Number(msgId));
  }

  for (const [k, v] of parsed.assigned) {
    if (!k || !v) continue;
    assignedByUserGame.set(k, v);
  }

  for (const [uid, u] of parsed.users) {
    if (!uid || !u) continue;
    knownUsers.set(Number(uid), u);
  }

  for (const [game, qr] of parsed.qrs) {
    if (!game || !qr) continue;
    paymentQRs.set(game, qr);
  }

  for (const [key, disabled] of parsed.disabled || []) {
    if (!key) continue;
    disabledMethods.set(key, !!disabled);
  }

  for (const [ticketId, ticket] of parsed.tickets || []) {
    if (!ticketId || !ticket) continue;
    supportTickets.set(ticketId, ticket);
  }

  return true;
}

async function writeSnapshot() {
  const text = buildSnapshotText();
  const sent = await sendToTopicText(TOPIC_THREAD_IDS.SYSTEM_BACKUPS, text);
  // Make restart rehydration possible via getChat().pinned_message
  try {
    await bot.pinChatMessage(ADMIN_GROUP_ID, sent.message_id, { disable_notification: true });
  } catch (e) {
    console.warn("pinChatMessage failed:", safeText(e?.message));
  }
}

async function rehydrateOnStartup() {
  try {
    const chat = await bot.getChat(ADMIN_GROUP_ID);
    const pinned = chat?.pinned_message;
    const text = pinned?.text || pinned?.caption || null;
    if (!text) return false;
    const parsed = parseSnapshotText(text);
    if (!parsed) return false;
    const ok = rehydrateFromSnapshot(parsed);
    return ok;
  } catch (e) {
    console.warn("rehydrateOnStartup failed:", safeText(e?.message));
    return false;
  }
}

// =========================
// LOGGING (TOPICS)
// =========================
async function logEmail(userId, email) {
  const u = knownUsers.get(userId);
  const label = u?.username ? `@${u.username}` : safeText(userId);
  const text = [
    "📧 <b>EMAIL COLLECTED</b>",
    `User: <code>${label}</code>`,
    `User ID: <code>${userId}</code>`,
    `Email: <code>${email}</code>`,
    `Timestamp: <code>${isoNow()}</code>`,
  ].join("\n");
  await sendToTopicText(TOPIC_THREAD_IDS.EMAIL_LOGS, text);
}

async function logTransaction(req) {
  const text = [
    "🧾 <b>TRANSACTION</b>",
    `Type: <b>${req.type}</b>`,
    `Game: <b>${req.game}</b>`,
    `User ID: <code>${req.user_id}</code>`,
    `Amount: <b>${req.amount}</b>`,
    `Decision: <b>${req.status}</b>`,
    `Reason: <code>${req.reason || "-"}</code>`,
    `Approved by: <code>${req.decision_by || "-"}</code>`,
    `Timestamp: <code>${req.decision_at || isoNow()}</code>`,
    `Request ID: <code>${req.request_id}</code>`,
  ].join("\n");
  await sendToTopicText(TOPIC_THREAD_IDS.TRANSACTION_LOGS, text);
}

async function logAccountAssignment(userId, gameId, acc, inventoryMsgId) {
  const text = [
    "📦 <b>ACCOUNT ASSIGNED</b>",
    `Game: <b>${gameId}</b>`,
    `User ID: <code>${userId}</code>`,
    `Username: <code>${acc.username}</code>`,
    `Inventory Msg ID: <code>${inventoryMsgId}</code>`,
    `Timestamp: <code>${isoNow()}</code>`,
  ].join("\n");
  await sendToTopicText(TOPIC_THREAD_IDS.TRANSACTION_LOGS, text);
}

async function logPromotion(promoText, stats) {
  const text = [
    "📣 <b>PROMOTION</b>",
    `Timestamp: <code>${isoNow()}</code>`,
    `Known users: <b>${stats.known}</b>`,
    `Delivered: <b>${stats.delivered}</b>`,
    `Blocked/Failed: <b>${stats.failed}</b>`,
    "",
    "<b>Message</b>:",
    safeText(promoText),
  ].join("\n");
  await sendToTopicText(TOPIC_THREAD_IDS.PROMOTIONS, text);
}

async function logAdminUserMsg(adminFrom, targetUserId, msgText, result) {
  const text = [
    "✉️ <b>ADMIN → USER MESSAGE</b>",
    `Admin: <code>${adminIdentity(adminFrom)}</code>`,
    `Target User ID: <code>${targetUserId}</code>`,
    `Result: <code>${result}</code>`,
    `Timestamp: <code>${isoNow()}</code>`,
    "",
    "<b>Message</b>:",
    safeText(msgText),
  ].join("\n");
  await sendToTopicText(TOPIC_THREAD_IDS.ADMIN_USER_MSGS, text);
}

// =========================
// PRIVATE CHAT UI RENDERING
// =========================
function selectedGameForUser(userId) {
  return knownUsers.get(userId)?.selected_game || null;
}

function setSelectedGameForUser(userId, gameId) {
  const u = knownUsers.get(userId);
  if (!u) return;
  u.selected_game = gameId;
  u.last_seen = isoNow();
  knownUsers.set(userId, u);
}

function userEmail(userId) {
  return knownUsers.get(userId)?.email || null;
}

function setUserEmail(userId, email) {
  const u = knownUsers.get(userId);
  if (!u) return;
  u.email = email;
  u.last_seen = isoNow();
  knownUsers.set(userId, u);
}

function renderGamePickerText(userId) {
  const sel = selectedGameForUser(userId);
  const selLine = sel ? `Current: <b>${sel}</b>` : "Current: <b>None</b>";
  return [
    "🎮 <b>Select Your Game</b>",
    selLine,
    "",
    "Choose from active games below:",
  ].join("\n");
}

function renderMainMenuText(userId) {
  const game = selectedGameForUser(userId);
  return [
    "🏠 <b>Main Menu</b>",
    "",
    `🎮 Game: <b>${game || "None"}</b>`,
    "",
    "Choose an option:",
  ].join("\n");
}

function renderViewAccountText(userId) {
  const game = selectedGameForUser(userId);
  if (!game) {
    return [
      "👤 <b>View My Account</b>",
      "",
      "No game selected.",
      "Tap <b>Change Game</b> to continue.",
    ].join("\n");
  }
  const key = makeUserGameKey(userId, game);
  const assigned = assignedByUserGame.get(key);
  if (!assigned) {
    return [
      "👤 <b>View My Account</b>",
      "",
      `🎮 Game: <b>${game}</b>`,
      "",
      "Status: <b>NO ACCOUNT ASSIGNED</b>",
      "",
      "Tap <b>Register Account</b> to get an account (FIFO).",
    ].join("\n");
  }
  return [
    "👤 <b>View My Account</b>",
    "",
    `🎮 Game: <b>${game}</b>`,
    "",
    "Status: <b>ASSIGNED</b>",
    `Username: <code>${assigned.username}</code>`,
    `Password: <code>${assigned.password}</code>`,
    `Assigned At: <code>${assigned.assigned_at}</code>`,
  ].join("\n");
}

async function sendGamePicker(chatId, userId) {
  await withRetry(() =>
    bot.sendMessage(chatId, renderGamePickerText(userId), {
      parse_mode: "HTML",
      reply_markup: buildGamePickerKeyboard(),
    }),
  );
}

async function sendMainMenu(chatId, userId) {
  await withRetry(() =>
    bot.sendMessage(chatId, renderMainMenuText(userId), {
      parse_mode: "HTML",
      reply_markup: buildMainMenuKeyboard(),
    }),
  );
}

// =========================
// PRIVATE FLOWS (ONE MESSAGE ONLY)
// =========================
async function startEmailFlow(userId) {
  const chatId = userId;
  const msg = await withRetry(() =>
    bot.sendMessage(
      chatId,
      [
        "📧 <b>Email Required</b>",
        "Step 1 / 1",
        "",
        "Please enter your email address to continue:",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: buildEmailKeyboard("WAIT_EMAIL") },
    ),
  );
  userFlows.set(userId, {
    kind: "EMAIL",
    chat_id: chatId,
    message_id: msg.message_id,
    step: "WAIT_EMAIL",
    started_at: isoNow(),
  });
}

async function startSupportFlow(userId) {
  const chatId = userId;
  const msg = await withRetry(() =>
    bot.sendMessage(
      chatId,
      [
        "💬 <b>Support Ticket</b>",
        "Step 1 / 2",
        "",
        "Please enter a <b>subject</b> for your support request:",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: buildFlowNavKeyboard("SUPPORT") },
    ),
  );
  userFlows.set(userId, {
    kind: "SUPPORT",
    chat_id: chatId,
    message_id: msg.message_id,
    step: "WAIT_SUBJECT",
    started_at: isoNow(),
  });
}

function renderSupportText(flow, note) {
  const lines = [];
  lines.push("💬 <b>Support Ticket</b>");
  if (flow.step === "WAIT_SUBJECT") lines.push("Step 1 / 2");
  if (flow.step === "WAIT_MESSAGE") lines.push("Step 2 / 2");
  if (flow.step === "PROCESSING") lines.push("⏳ Submitting…");
  if (flow.step === "DONE") lines.push("✅ Submitted");
  lines.push("");
  lines.push(`📝 Subject: <code>${flow.subject || "-"}</code>`);
  lines.push("");
  if (flow.step === "WAIT_SUBJECT") lines.push("Enter a <b>subject</b>:");
  if (flow.step === "WAIT_MESSAGE") lines.push("Enter your <b>detailed message</b>:");
  if (flow.step === "PROCESSING") lines.push("Please wait…");
  if (flow.step === "DONE") {
    lines.push(`✅ Your ticket has been submitted`);
    lines.push(`Ticket ID: <code>${flow.ticket_id}</code>`);
  }
  if (note) {
    lines.push("");
    lines.push(`⚠️ <i>${note}</i>`);
  }
  return lines.join("\n");
}

async function renderSupportFlow(userId, note) {
  const flow = userFlows.get(userId);
  if (!flow || flow.kind !== "SUPPORT") return;
  const text = renderSupportText(flow, note);
  await safeEditText(flow.chat_id, flow.message_id, text, buildFlowNavKeyboard("SUPPORT"));
}

async function submitSupportTicket(flow) {
  const ticketId = newRequestId("T");
  const user = knownUsers.get(flow.chat_id);
  const ticket = {
    ticket_id: ticketId,
    user_id: flow.chat_id,
    username: user?.username || "-",
    first_name: user?.first_name || "-",
    subject: flow.subject,
    message: flow.message,
    created_at: isoNow(),
    status: "OPEN",
    replies: [],
  };
  supportTickets.set(ticketId, ticket);

  const caption = [
    "💬 <b>SUPPORT TICKET</b>",
    "",
    `Ticket ID: <code>${ticketId}</code>`,
    `User ID: <code>${flow.chat_id}</code>`,
    `Username: <code>${ticket.username}</code>`,
    `Name: <code>${ticket.first_name}</code>`,
    `Created: <code>${ticket.created_at}</code>`,
    "",
    `📋 Subject: <b>${ticket.subject}</b>`,
    "",
    `📝 Message:`,
    `<code>${ticket.message}</code>`,
    "",
    `Status: <b>${ticket.status}</b>`,
  ].join("\n");

  const sent = await sendToTopicText(TOPIC_THREAD_IDS.SUPPORT_TICKETS, caption, {
    reply_markup: buildAdminTicketKeyboard(ticketId),
  });

  ticket.message_thread_id = sent.message_id;
  supportTickets.set(ticketId, ticket);
  await writeSnapshot();
  return ticketId;
}

function buildAdminTicketKeyboard(ticketId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Resolve", callback_data: cb(["A", "TICKET", "RESOLVE", ticketId]) },
        { text: "❌ Close", callback_data: cb(["A", "TICKET", "CLOSE", ticketId]) },
      ],
      [{ text: "💬 Reply", callback_data: cb(["A", "TICKET", "REPLY", ticketId]) }],
    ],
  };
}

function formatTicketCaption(ticket) {
  const cap = [
    "💬 <b>SUPPORT TICKET</b>",
    "",
    `Ticket ID: <code>${ticket.ticket_id}</code>`,
    `User ID: <code>${ticket.user_id}</code>`,
    `Username: <code>${ticket.username}</code>`,
    `Name: <code>${ticket.first_name}</code>`,
    `Created: <code>${ticket.created_at}</code>`,
    "",
    `📋 Subject: <b>${ticket.subject}</b>`,
    "",
    `📝 Message:`,
    `<code>${ticket.message}</code>`,
    "",
    `Status: <b>${ticket.status}</b>`,
  ];
  if (ticket.replies && ticket.replies.length > 0) {
    cap.push("");
    cap.push("<b>💬 Replies:</b>");
    for (const r of ticket.replies) {
      cap.push(`[${r.by} @ ${r.timestamp}]`);
      cap.push(`<code>${r.text}</code>`);
      cap.push("");
    }
  }
  return cap.join("\n");
}

async function renderEmailFlow(userId, note) {
  const flow = userFlows.get(userId);
  if (!flow || flow.kind !== "EMAIL") return;
  const header = [
    "📧 <b>Email Required</b>",
    "Step 1 / 1",
    "",
    "Enter your email address:",
  ];
  if (note) header.push("", `⚠️ <i>${note}</i>`);
  await safeEditText(flow.chat_id, flow.message_id, header.join("\n"), buildEmailKeyboard(flow.step));
}

async function finishEmailFlow(userId) {
  const flow = userFlows.get(userId);
  if (!flow || flow.kind !== "EMAIL") return;
  flow.step = "DONE";
  const email = userEmail(userId);
  await safeEditText(
    flow.chat_id,
    flow.message_id,
    ["✅ <b>Email Saved</b>", "", `Email: <code>${email}</code>`].join("\n"),
    buildEmailKeyboard("DONE"),
  );
}

async function startLoadFlow(userId) {
  const chatId = userId;
  const game = selectedGameForUser(userId);
  if (!game) {
    const msg = await withRetry(() =>
      bot.sendMessage(chatId, "🎮 Please select a game first.", { parse_mode: "HTML", reply_markup: buildGamePickerKeyboard() }),
    );
    return msg;
  }

  // Check if any methods are configured for this game
  const methodKeys = Array.from(paymentQRs.keys()).filter(k => k.startsWith(`${game}::`) && !disabledMethods.get(k));
  if (methodKeys.length === 0) {
    const msg = await withRetry(() =>
      bot.sendMessage(
        chatId,
        [
          "🟦 <b>Load Balance</b>",
          "",
          `🎮 Game: <b>${game}</b>`,
          "",
          "⚠️ <b>No payment methods available</b>",
          "Please contact an admin.",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: buildMainMenuKeyboard() },
      ),
    );
    return msg;
  }

  // Start at method selection step (no QR yet)
  const caption = [
    "🟦 <b>Load Balance</b>",
    "Step 1 / 5",
    "",
    `🎮 Game: <b>${game}</b>`,
    "",
    "💳 <b>Select Payment Method:</b>",
  ].join("\n");

  const sent = await withRetry(() =>
    bot.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: buildPaymentMethodKeyboard(game) }),
  );

  userFlows.set(userId, {
    kind: "LOAD",
    chat_id: chatId,
    message_id: sent.message_id,
    step: "WAIT_METHOD_SELECT",
    game,
    pay_method: null,
    started_at: isoNow(),
  });
}

function renderLoadCaption(flow, note) {
  const lines = [];
  lines.push("🟦 <b>Load Balance</b>");
  if (flow.step === "WAIT_METHOD_SELECT") lines.push("Step 1 / 5");
  if (flow.step === "WAIT_USERNAME") lines.push("Step 2 / 5");
  if (flow.step === "WAIT_AMOUNT") lines.push("Step 3 / 5");
  if (flow.step === "QR_WAIT_PAID") lines.push("Step 4 / 5");
  if (flow.step === "WAIT_SCREENSHOT") lines.push("Step 5 / 5");
  if (flow.step === "PROCESSING") lines.push("⏳ Processing…");
  if (flow.step === "DONE") lines.push("✅ Complete");
  lines.push("");
  lines.push(`🎮 Game: <b>${flow.game}</b>`);
  lines.push("");
  if (flow.pay_method) lines.push(`💳 Method: <b>${flow.pay_method}</b>`);
  lines.push(`👤 Username: <code>${flow.username || "-"}</code>`);
  lines.push(`💵 Amount: <b>${typeof flow.amount === "number" ? flow.amount : "-"}</b>`);
  lines.push("");
  if (flow.step === "WAIT_METHOD_SELECT") lines.push("💳 <b>Select Payment Method:</b>");
  if (flow.step === "WAIT_USERNAME") lines.push("Enter your username:");
  if (flow.step === "WAIT_AMOUNT") lines.push("Enter amount:");
  if (flow.step === "QR_WAIT_PAID") {
    lines.push("Scan QR & Pay");
    lines.push("Then tap <b>I Have Paid</b>.");
  }
  if (flow.step === "WAIT_SCREENSHOT") {
    lines.push("Send your <b>payment screenshot</b> now.");
    lines.push("No extra messages from the bot until you finish.");
  }
  if (flow.step === "PROCESSING") {
    lines.push(`Status: <b>PENDING</b>`);
    lines.push(`Request ID: <code>${flow.request_id}</code>`);
  }
  if (flow.step === "DONE") {
    lines.push(`Request ID: <code>${flow.request_id}</code>`);
  }
  if (note) {
    lines.push("");
    lines.push(`⚠️ <i>${note}</i>`);
  }
  return lines.join("\n");
}

async function renderLoadFlow(userId, note) {
  const flow = userFlows.get(userId);
  if (!flow || flow.kind !== "LOAD") return;
  const caption = renderLoadCaption(flow, note);
  await safeEditCaption(flow.chat_id, flow.message_id, caption, buildLoadStepKeyboard(flow.step));
}

async function startCashoutFlow(userId) {
  const chatId = userId;
  const game = selectedGameForUser(userId);
  if (!game) {
    await sendGamePicker(chatId, userId);
    return;
  }

  const msg = await withRetry(() =>
    bot.sendMessage(
      chatId,
      [
        "🟩 <b>Cashout</b>",
        "Step 1 / 4",
        "",
        `🎮 Game: <b>${game}</b>`,
        "",
        "Enter your username:",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: buildCashoutStepKeyboard("WAIT_USERNAME") },
    ),
  );

  userFlows.set(userId, {
    kind: "CASHOUT",
    chat_id: chatId,
    message_id: msg.message_id,
    step: "WAIT_USERNAME",
    game,
    started_at: isoNow(),
  });
}

function renderCashoutText(flow, note) {
  const lines = [];
  lines.push("🟩 <b>Cashout</b>");
  if (flow.step === "WAIT_USERNAME") lines.push("Step 1 / 4");
  if (flow.step === "WAIT_AMOUNT") lines.push("Step 2 / 4");
  if (flow.step === "WAIT_CASHTAG") lines.push("Step 3 / 4");
  if (flow.step === "WAIT_RECEIVING_QR") lines.push("Step 4 / 4");
  if (flow.step === "PROCESSING") lines.push("⏳ Processing…");
  if (flow.step === "DONE") lines.push("✅ Complete");
  lines.push("");
  lines.push(`🎮 Game: <b>${flow.game}</b>`);
  lines.push("");
  lines.push(`👤 Username: <code>${flow.username || "-"}</code>`);
  lines.push(`💵 Amount: <b>${typeof flow.amount === "number" ? flow.amount : "-"}</b>`);
  lines.push(`🏷 Cashtag: <code>${flow.cashtag || "-"}</code>`);
  lines.push("");
  if (flow.step === "WAIT_USERNAME") lines.push("Enter your username:");
  if (flow.step === "WAIT_AMOUNT") lines.push("Enter amount:");
  if (flow.step === "WAIT_CASHTAG") lines.push("Enter cashtag:");
  if (flow.step === "WAIT_RECEIVING_QR") {
    lines.push("Send your <b>receiving QR</b> (photo or document) now.");
  }
  if (flow.step === "PROCESSING") {
    lines.push(`Status: <b>PENDING</b>`);
    lines.push(`Request ID: <code>${flow.request_id}</code>`);
  }
  if (flow.step === "DONE") {
    lines.push(`Request ID: <code>${flow.request_id}</code>`);
  }
  if (note) {
    lines.push("");
    lines.push(`⚠️ <i>${note}</i>`);
  }
  return lines.join("\n");
}

async function renderCashoutFlow(userId, note) {
  const flow = userFlows.get(userId);
  if (!flow || flow.kind !== "CASHOUT") return;
  await safeEditText(flow.chat_id, flow.message_id, renderCashoutText(flow, note), buildCashoutStepKeyboard(flow.step));
}

async function cancelUserFlow(userId, reason) {
  const flow = userFlows.get(userId);
  if (!flow) return;
  const text = [
    "✖ <b>Cancelled</b>",
    "",
    reason ? `Reason: <i>${reason}</i>` : "",
  ].filter(Boolean).join("\n");
  if (flow.kind === "LOAD") await safeEditCaption(flow.chat_id, flow.message_id, text, buildMainMenuKeyboard());
  else await safeEditText(flow.chat_id, flow.message_id, text, buildMainMenuKeyboard());
  userFlows.delete(userId);
}

async function finishUserFlowToMenu(userId, kind) {
  const flow = userFlows.get(userId);
  if (!flow) return;
  const text = renderMainMenuText(userId);
  if (kind === "LOAD") await safeEditCaption(flow.chat_id, flow.message_id, text, buildMainMenuKeyboard());
  else await safeEditText(flow.chat_id, flow.message_id, text, buildMainMenuKeyboard());
  userFlows.delete(userId);
}

// =========================
// ACCOUNT INVENTORY (FIFO ASSIGNMENT)
// =========================
async function assignAccountToUser(userId, gameId) {
  const key = makeUserGameKey(userId, gameId);
  const already = assignedByUserGame.get(key);
  if (already) return { ok: true, already: true, account: already };

  if (!userEmail(userId)) {
    return { ok: false, needsEmail: true };
  }

  const q = ensureQueue(gameId);
  if (q.length === 0) return { ok: false, none: true };

  const inventoryMsgId = q[0];
  const acc = accountsByMsgId.get(inventoryMsgId);
  if (!acc || acc.status !== "AVAILABLE") {
    queueRemove(gameId, inventoryMsgId);
    return { ok: false, none: q.length === 0 };
  }

  const assignedAt = isoNow();
  const newText = formatAccountAssignedLine(acc.game, acc.username, acc.password, userId, assignedAt);

  // Only edit bot-sent canonical inventory messages
  const edited = await safeEditText(ADMIN_GROUP_ID, inventoryMsgId, newText, null);
  if (!edited) {
    return { ok: false, editFailed: true };
  }

  // Update memory
  acc.status = "ASSIGNED";
  acc.assigned_to = userId;
  acc.assigned_at = assignedAt;
  accountsByMsgId.set(inventoryMsgId, acc);
  queueRemove(gameId, inventoryMsgId);

  const assignRec = { inventory_message_id: inventoryMsgId, username: acc.username, password: acc.password, assigned_at: assignedAt };
  assignedByUserGame.set(key, assignRec);

  await logAccountAssignment(userId, gameId, acc, inventoryMsgId);
  await writeSnapshot();
  return { ok: true, already: false, account: assignRec };
}

// =========================
// APPROVAL SYSTEM
// =========================
function newRequestId(prefix) {
  const a = Date.now().toString(36);
  const b = Math.random().toString(36).slice(2, 6);
  return `${prefix}${a}${b}`;
}

function approvalCaption(req) {
  const lines = [];
  lines.push(req.type === "LOAD" ? "🟦 <b>LOAD APPROVAL</b>" : "🟩 <b>CASHOUT APPROVAL</b>");
  lines.push("");
  lines.push(`Request ID: <code>${req.request_id}</code>`);
  lines.push(`Game: <b>${req.game}</b>`);
  lines.push(`User ID: <code>${req.user_id}</code>`);
  lines.push(`Username: <code>${req.username}</code>`);
  lines.push(`Amount: <b>${req.amount}</b>`);
  if (req.pay_method) lines.push(`Payment Method: <b>${req.pay_method}</b>`);
  if (req.type === "CASHOUT") lines.push(`Cashtag: <code>${req.cashtag || "-"}</code>`);
  lines.push("");
  lines.push(`Status: <b>${req.status}</b>`);
  if (req.status !== "PENDING") {
    lines.push(`Decision: <b>${req.status}</b>`);
    lines.push(`Reason: <code>${req.reason || "-"}</code>`);
    lines.push(`Approved by: <code>${req.decision_by || "-"}</code>`);
    lines.push(`Timestamp: <code>${req.decision_at || "-"}</code>`);
  }
  return lines.join("\n");
}

async function submitLoadForApproval(flow, screenshotFileId) {
  const requestId = newRequestId("L");
  const req = {
    request_id: requestId,
    type: "LOAD",
    game: flow.game,
    user_id: flow.chat_id,
    username: flow.username,
    amount: flow.amount,
    pay_method: flow.pay_method,
    created_at: isoNow(),
    status: "PENDING",
    screenshot_file_id: screenshotFileId,
    user_flow_chat_id: flow.chat_id,
    user_flow_message_id: flow.message_id,
  };
  approvalRequests.set(requestId, req);

  const caption = approvalCaption(req);
  const sent = await sendToTopicPhoto(TOPIC_THREAD_IDS.LOAD_APPROVALS, screenshotFileId, caption, {
    reply_markup: buildAdminApproveRejectKeyboard(requestId),
  });

  req.approvals_topic_message_id = sent.message_id;
  req.approvals_topic_thread_id = TOPIC_THREAD_IDS.LOAD_APPROVALS;
  approvalRequests.set(requestId, req);
  await writeSnapshot();
  return requestId;
}

async function submitCashoutForApproval(flow, receivingQr) {
  const requestId = newRequestId("C");
  const req = {
    request_id: requestId,
    type: "CASHOUT",
    game: flow.game,
    user_id: flow.chat_id,
    username: flow.username,
    amount: flow.amount,
    pay_method: flow.pay_method,
    cashtag: flow.cashtag,
    created_at: isoNow(),
    status: "PENDING",
    receiving_qr_file_id: receivingQr.file_id,
    receiving_qr_type: receivingQr.type,
    user_flow_chat_id: flow.chat_id,
    user_flow_message_id: flow.message_id,
  };
  approvalRequests.set(requestId, req);

  const caption = approvalCaption(req);
  const sent =
    receivingQr.type === "photo"
      ? await sendToTopicPhoto(TOPIC_THREAD_IDS.WITHDRAW_APPROVALS, receivingQr.file_id, caption, {
          reply_markup: buildAdminApproveRejectKeyboard(requestId),
        })
      : await sendToTopicDocument(TOPIC_THREAD_IDS.WITHDRAW_APPROVALS, receivingQr.file_id, caption, {
          reply_markup: buildAdminApproveRejectKeyboard(requestId),
        });

  req.approvals_topic_message_id = sent.message_id;
  req.approvals_topic_thread_id = TOPIC_THREAD_IDS.WITHDRAW_APPROVALS;
  approvalRequests.set(requestId, req);
  await writeSnapshot();
  return requestId;
}

async function finalizeDecision(requestId, decision, decidedBy, reason) {
  const req = approvalRequests.get(requestId);
  if (!req) return { ok: false, notFound: true };
  if (req.status !== "PENDING") return { ok: false, already: true };

  req.status = decision;
  req.decision_by = decidedBy;
  req.decision_at = isoNow();
  req.reason = reason || (decision === "REJECTED" ? "No reason provided" : undefined);
  approvalRequests.set(requestId, req);

  // Remove buttons and write final caption/text in approvals topic
  const msgId = req.approvals_topic_message_id;
  if (msgId) {
    const cap = approvalCaption(req);
    // Determine whether approvals message is photo/document/text: we only have message_id; safe approach is edit caption first, then markup.
    await safeEditCaption(ADMIN_GROUP_ID, msgId, cap, { inline_keyboard: [] });
    await safeEditReplyMarkup(ADMIN_GROUP_ID, msgId, { inline_keyboard: [] });
  }

  // Update user single-message flow
  if (req.user_flow_chat_id && req.user_flow_message_id) {
    const userId = req.user_flow_chat_id;
    const flow = userFlows.get(userId);
    // If flow still active, update it; otherwise, still try to edit the original message (one-message requirement still holds).
    const flowKind = req.type === "LOAD" ? "LOAD" : "CASHOUT";
    const finalText =
      decision === "APPROVED"
        ? ["✅ <b>Approved</b>", "", `Request ID: <code>${requestId}</code>`, `Timestamp: <code>${req.decision_at}</code>`].join("\n")
        : [
            "❌ <b>Rejected</b>",
            "",
            `Request ID: <code>${requestId}</code>`,
            `Reason: <code>${req.reason || "-"}</code>`,
            `Timestamp: <code>${req.decision_at}</code>`,
          ].join("\n");

    if (flowKind === "LOAD") {
      await safeEditCaption(userId, req.user_flow_message_id, finalText, buildLoadStepKeyboard("DONE"));
    } else {
      await safeEditText(userId, req.user_flow_message_id, finalText, buildCashoutStepKeyboard("DONE"));
    }

    if (flow && flow.request_id === requestId) {
      flow.step = "DONE";
      userFlows.set(userId, flow);
    }
  }

  await logTransaction(req);
  await writeSnapshot();
  return { ok: true };
}

// =========================
// MANAGE GAMES (TELEGRAM MESSAGES AS SOURCE OF TRUTH)
// =========================
async function upsertCanonicalGameFromParsed(parsed, sourceUserLabel) {
  const existing = gamesById.get(parsed.id);
  if (!existing) {
    // Create canonical bot-sent record in MANAGE_GAMES topic
    const line = formatGameLine(parsed);
    const sent = await sendToTopicText(TOPIC_THREAD_IDS.MANAGE_GAMES, line, {
      reply_markup: buildAdminGameControlsKeyboard(parsed.id, parsed.status),
    });
    gamesById.set(parsed.id, { ...parsed, message_id: sent.message_id });
    await sendToTopicText(
      TOPIC_THREAD_IDS.TRANSACTION_LOGS,
      ["🎮 <b>GAME CREATED</b>", `By: <code>${sourceUserLabel}</code>`, `Game: <code>${parsed.id}</code>`, `Timestamp: <code>${isoNow()}</code>`].join("\n"),
    );
    await writeSnapshot();
    return;
  }

  // Update canonical bot-sent record
  const line = formatGameLine(parsed);
  await safeEditText(ADMIN_GROUP_ID, existing.message_id, line, buildAdminGameControlsKeyboard(parsed.id, parsed.status));
  gamesById.set(parsed.id, { ...parsed, message_id: existing.message_id });
  await sendToTopicText(
    TOPIC_THREAD_IDS.TRANSACTION_LOGS,
    ["🎮 <b>GAME UPDATED</b>", `By: <code>${sourceUserLabel}</code>`, `Game: <code>${parsed.id}</code>`, `Timestamp: <code>${isoNow()}</code>`].join("\n"),
  );
  await writeSnapshot();
}

async function syncDefaultGamesIfFirstBoot(hadState) {
  if (hadState && gamesById.size > 0) return;
  // First boot: push DEFAULT_GAMES into MANAGE_GAMES as canonical messages
  for (const g of DEFAULT_GAMES) {
    if (gamesById.has(g.id)) continue;
    const sent = await sendToTopicText(TOPIC_THREAD_IDS.MANAGE_GAMES, formatGameLine(g), {
      reply_markup: buildAdminGameControlsKeyboard(g.id, g.status),
    });
    gamesById.set(g.id, { ...g, message_id: sent.message_id });
  }
  await writeSnapshot();
}

// =========================
// PAYMENT CONFIG (PAYMENT_QR records)
// =========================
async function upsertPaymentQr(gameId, method, media) {
  const key = `${gameId}::${method}`;
  const existing = paymentQRs.get(key);
  const caption = `PAYMENT_QR | game=${gameId} | method=${method}`;

  if (!existing) {
    const sent =
      media.type === "photo"
        ? await sendToTopicPhoto(TOPIC_THREAD_IDS.PAYMENT_CONFIG, media.file_id, caption)
        : await sendToTopicDocument(TOPIC_THREAD_IDS.PAYMENT_CONFIG, media.file_id, caption);
    paymentQRs.set(key, { game: gameId, method, type: media.type, file_id: media.file_id, message_id: sent.message_id });
    await sendToTopicText(
      TOPIC_THREAD_IDS.TRANSACTION_LOGS,
      ["💳 <b>PAYMENT QR SET</b>", `Game: <b>${gameId}</b>`, `Method: <b>${method}</b>`, `Msg ID: <code>${sent.message_id}</code>`, `Timestamp: <code>${isoNow()}</code>`].join("\n"),
    );
    await writeSnapshot();
    return;
  }

  // Update canonical record by editing media (bot-sent only)
  const inputMedia =
    media.type === "photo"
      ? { type: "photo", media: media.file_id, caption, parse_mode: "HTML" }
      : { type: "document", media: media.file_id, caption, parse_mode: "HTML" };

  await safeEditMedia(ADMIN_GROUP_ID, existing.message_id, inputMedia, undefined);
  paymentQRs.set(key, { game: gameId, method, type: media.type, file_id: media.file_id, message_id: existing.message_id });
  await sendToTopicText(
    TOPIC_THREAD_IDS.TRANSACTION_LOGS,
    ["💳 <b>PAYMENT QR UPDATED</b>", `Game: <b>${gameId}</b>`, `Method: <b>${method}</b>`, `Msg ID: <code>${existing.message_id}</code>`, `Timestamp: <code>${isoNow()}</code>`].join("\n"),
  );
  await writeSnapshot();
}

// =========================
// INGEST "TABLE" INPUTS (ADMIN POSTS)
// =========================
async function handleManageGamesTopicMessage(msg) {
  if (!msg.text) return;
  const parsed = parseGameMessage(msg.text);
  if (!parsed) return;

  // Admins can post; bot converts into canonical bot message (never deletes admin post).
  const ok = await isAdmin(msg.from.id);
  if (!ok) return;

  await upsertCanonicalGameFromParsed(parsed, adminIdentity(msg.from));
}

async function handleAccountInventoryTopicMessage(msg) {
  if (!msg.text) return;
  const parsed = parseAccountMessage(msg.text);
  if (!parsed) return;
  const ok = await isAdmin(msg.from.id);
  if (!ok) return;

  // Create canonical bot-sent inventory record (so it can be edited later).
  if (msg.from.id === BOT_ID) {
    // Canonical messages are bot-sent; ingest them into memory for FIFO assignment.
    accountsByMsgId.set(msg.message_id, parsed);
    if (parsed.status === "AVAILABLE") queueAddAvailable(parsed.game, msg.message_id);
    else queueRemove(parsed.game, msg.message_id);
    await writeSnapshot();
    return;
  }

  // Admin posted inventory line -> bot writes canonical record in the same topic (no deletion).
  const canonicalText =
    parsed.status === "AVAILABLE"
      ? formatAccountAvailableLine(parsed.game, parsed.username, parsed.password)
      : formatAccountAssignedLine(parsed.game, parsed.username, parsed.password, parsed.assigned_to || 0, parsed.assigned_at || isoNow());

  const sent = await sendToTopicText(TOPIC_THREAD_IDS.ACCOUNT_INVENTORY, canonicalText);
  accountsByMsgId.set(sent.message_id, parseAccountMessage(canonicalText));
  if (parseAccountMessage(canonicalText).status === "AVAILABLE") queueAddAvailable(parsed.game, sent.message_id);
  await sendToTopicText(
    TOPIC_THREAD_IDS.TRANSACTION_LOGS,
    ["📦 <b>INVENTORY INGESTED</b>", `By: <code>${adminIdentity(msg.from)}</code>`, `Game: <b>${parsed.game}</b>`, `Username: <code>${parsed.username}</code>`, `Timestamp: <code>${isoNow()}</code>`].join("\n"),
  );
  await writeSnapshot();
}

async function handlePaymentConfigTopicMessage(msg) {
  const ok = await isAdmin(msg.from.id);
  if (!ok) return;

  const caption = msg.caption || msg.text || "";
  const kv = parseKVLine(caption, "PAYMENT_QR |");
  if (!kv || !kv.game) return;
  const gameId = kv.game;
  const method = kv.method || "DEFAULT";

  const photoFileId = pickBestPhotoFileId(msg.photo);
  if (photoFileId) {
    await upsertPaymentQr(gameId, method, { type: "photo", file_id: photoFileId });
    return;
  }

  if (msg.document?.file_id) {
    await upsertPaymentQr(gameId, method, { type: "document", file_id: msg.document.file_id });
  }
}

async function handlePaymentMethodStatusMessage(msg, action) {
  // action = "DISABLE" or "ENABLE"
  // Caption format: PAYMENT_METHOD_DISABLE | game=GameA | method=CashApp
  if (!msg.caption && !msg.text) return;
  const caption = msg.caption || msg.text || "";
  const prefix = action === "DISABLE" ? "PAYMENT_METHOD_DISABLE |" : "PAYMENT_METHOD_ENABLE |";
  const kv = parseKVLine(caption, prefix);
  if (!kv || !kv.game || !kv.method) return;

  const key = `${kv.game}::${kv.method}`;
  const disabled = action === "DISABLE";
  disabledMethods.set(key, disabled);
  await sendToTopicText(
    TOPIC_THREAD_IDS.TRANSACTION_LOGS,
    [
      disabled ? "🚫 <b>PAYMENT METHOD DISABLED</b>" : "✅ <b>PAYMENT METHOD ENABLED</b>",
      `Game: <b>${kv.game}</b>`,
      `Method: <b>${kv.method}</b>`,
      `By: <code>${adminIdentity(msg.from)}</code>`,
      `Timestamp: <code>${isoNow()}</code>`,
    ].join("\n"),
  );
  await writeSnapshot();
}

// =========================
// PROMOTIONS & ADMIN→USER MSG (TOPIC-RESTRICTED)
// =========================
async function broadcastPromotion(promoText) {
  const userIds = Array.from(knownUsers.keys());
  let delivered = 0;
  let failed = 0;
  for (const uid of userIds) {
    try {
      await withRetry(() =>
        bot.sendMessage(
          uid,
          ["📣 <b>Promotion</b>", "", safeText(promoText)].join("\n"),
          { parse_mode: "HTML", disable_web_page_preview: true },
        ),
      );
      delivered++;
    } catch {
      failed++;
    }
  }
  await logPromotion(promoText, { known: userIds.length, delivered, failed });
}

async function handlePromoCommand(msg) {
  if (!mustBeTopic(msg, TOPIC_THREAD_IDS.PROMOTIONS)) return;
  const ok = await isAdmin(msg.from.id);
  if (!ok) return;

  const text = safeText(msg.text);
  const args = text.replace(/^\/promo\b/i, "").trim();
  if (args) {
    await broadcastPromotion(args);
    return;
  }

  adminInputs.set(msg.from.id, { kind: "PROMO_TEXT" });
  await sendToTopicText(
    TOPIC_THREAD_IDS.PROMOTIONS,
    ["📣 <b>/promo</b>", "Send the promotion text as your next message in this topic."].join("\n"),
  );
}

async function handleMsgUserCommand(msg) {
  if (!mustBeTopic(msg, TOPIC_THREAD_IDS.ADMIN_USER_MSGS)) return;
  const ok = await isAdmin(msg.from.id);
  if (!ok) return;

  const text = safeText(msg.text);
  const args = text.replace(/^\/msguser\b/i, "").trim();
  const parts = args.split(/\s+/).filter(Boolean);

  if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
    const targetUserId = Number(parts[0]);
    const msgText = args.slice(parts[0].length).trim();
    let result = "SENT";
    try {
      await withRetry(() => bot.sendMessage(targetUserId, msgText));
    } catch (e) {
      result = `FAILED: ${safeText(e?.message)}`;
    }
    await logAdminUserMsg(msg.from, targetUserId, msgText, result);
    return;
  }

  adminInputs.set(msg.from.id, { kind: "MSGUSER_USERID" });
  await sendToTopicText(
    TOPIC_THREAD_IDS.ADMIN_USER_MSGS,
    ["✉️ <b>/msguser</b>", "Step 1 / 2", "Send the <b>User ID</b> as your next message in this topic."].join("\n"),
  );
}

// =========================
// ROUTING: MESSAGES
// =========================
bot.on("message", async (msg) => {
  try {
    // Debug: log all messages
    console.log(`[MSG RECEIVED] Type: ${msg.chat?.type}, From: ${msg.from?.id}, Text: "${msg.text}", Caption: "${msg.caption}"`);
    
    if (!msg.from?.id) {
      console.log("[MSG] No user ID, skipping");
      return;
    }

    // Track known users on any private interaction
    if (isPrivate(msg) && msg.from?.id) {
      const uid = msg.from.id;
      const now = isoNow();
      if (!knownUsers.has(uid)) {
        knownUsers.set(uid, {
          user_id: uid,
          username: msg.from.username || undefined,
          first_name: msg.from.first_name || undefined,
          last_name: msg.from.last_name || undefined,
          first_seen: now,
          last_seen: now,
          selected_game: null,
          email: null,
        });
        await writeSnapshot();
      } else {
        const u = knownUsers.get(uid);
        u.username = msg.from.username || u.username;
        u.first_name = msg.from.first_name || u.first_name;
        u.last_name = msg.from.last_name || u.last_name;
        u.last_seen = now;
        knownUsers.set(uid, u);
      }
    }

    // PRIVATE CHAT COMMANDS
    if (isPrivate(msg)) {
      // Allow admins to submit ticket replies via private chat when prompted
      if (msg.from?.id) {
        const ai = adminInputs.get(msg.from.id);
        if (ai && ai.kind === "TICKET_REPLY") {
          if (!msg.text) {
            await bot.sendMessage(msg.from.id, "Please send your reply as text.");
            return;
          }
          const replyText = msg.text.trim();
          adminInputs.delete(msg.from.id);
          const ticket = supportTickets.get(ai.ticket_id);
          if (!ticket) {
            await bot.sendMessage(msg.from.id, "Ticket not found.");
            return;
          }
          ticket.replies.push({ by: adminIdentity(msg.from), text: replyText, timestamp: isoNow() });
          supportTickets.set(ai.ticket_id, ticket);
          const cap = formatTicketCaption(ticket);
          await safeEditText(ADMIN_GROUP_ID, ai.ticket_message_id, cap, buildAdminTicketKeyboard(ai.ticket_id));
          await bot.sendMessage(msg.from.id, `Reply posted to ticket ${ai.ticket_id}.`);

          // Notify ticket owner via DM (if possible) with a Reply button
          try {
            const userNotify = [
              `💬 Reply for your ticket <b>${ai.ticket_id}</b>`,
              "",
              `<b>Admin:</b> ${adminIdentity(msg.from)}`,
              "",
              `<b>Message:</b>`,
              `${replyText}`,
            ].join("\n");
            await withRetry(() =>
              bot.sendMessage(ticket.user_id, userNotify, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "↩ Reply", callback_data: cb(["U", "TICKET", "REPLY", ai.ticket_id]) }]] },
              }),
            );
          } catch (e) {
            // ignore if user cannot be messaged
          }
          await writeSnapshot();
          return;
        }
      }
      console.log(`[PRIVATE CMD] Text: "${msg.text}", isPrivate: ${isPrivate(msg)}`);
      if (msg.text && safeText(msg.text).trim() === "/start") {
        console.log(`[/start MATCHED] User ${msg.from.id}`);
        const uid = msg.from.id;
        console.log(`[/start] Received from user ${uid}`);
        const game = selectedGameForUser(uid);
        console.log(`[/start] Selected game: ${game || "none"}`);
        try {
          if (!game) await sendGamePicker(uid, uid);
          else await sendMainMenu(uid, uid);
          await writeSnapshot();
          console.log(`[/start] Successfully sent menu to user ${uid}`);
        } catch (err) {
          console.error(`[/start] Error for user ${uid}:`, err);
        }
        return;
      }

      // Private flow input handling (user messages are allowed; bot must not send extra messages during load/cashout)
      const uid = msg.from.id;
      const flow = userFlows.get(uid);
      if (flow) {
        if (flow.kind === "EMAIL") {
          if (msg.text) {
            const e = msg.text.trim();
            if (!validateEmail(e)) {
              await renderEmailFlow(uid, "Invalid email format. Try again.");
              return;
            }
            setUserEmail(uid, e);
            await logEmail(uid, e);
            await writeSnapshot();
            await finishEmailFlow(uid);
            return;
          }
          await renderEmailFlow(uid, "Please send a text email address.");
          return;
        }

        if (flow.kind === "LOAD") {
          if (flow.step === "WAIT_USERNAME") {
            if (!msg.text) {
              await renderLoadFlow(uid, "Please send your username as text.");
              return;
            }
            flow.username = msg.text.trim();
            flow.step = "WAIT_AMOUNT";
            userFlows.set(uid, flow);
            await renderLoadFlow(uid);
            return;
          }

          if (flow.step === "WAIT_AMOUNT") {
            if (!msg.text) {
              await renderLoadFlow(uid, "Please send the amount as text.");
              return;
            }
            const amt = normalizeAmount(msg.text.trim());
            if (amt === null) {
              await renderLoadFlow(uid, "Invalid amount. Enter a number greater than 0.");
              return;
            }
            flow.amount = amt;
            flow.step = "QR_WAIT_PAID";
            userFlows.set(uid, flow);
            await renderLoadFlow(uid);
            return;
          }

          if (flow.step === "WAIT_SCREENSHOT") {
            const fileId = pickBestPhotoFileId(msg.photo);
            if (!fileId) {
              await renderLoadFlow(uid, "Send a payment screenshot as a photo.");
              return;
            }
            flow.paid_screenshot_file_id = fileId;
            flow.step = "PROCESSING";
            userFlows.set(uid, flow);

            const requestId = await submitLoadForApproval(flow, fileId);
            flow.request_id = requestId;
            userFlows.set(uid, flow);
            await renderLoadFlow(uid);
            return;
          }

          return;
        }

        if (flow.kind === "TICKET_CONV") {
          if (flow.step === "WAIT_USER_REPLY") {
            if (!msg.text) {
              await bot.sendMessage(uid, "Please send your reply as text.");
              return;
            }
            const reply = msg.text.trim();
            const ticket = supportTickets.get(flow.ticket_id);
            if (!ticket) {
              await bot.sendMessage(uid, "Ticket not found.");
              userFlows.delete(uid);
              return;
            }
            const userInfo = knownUsers.get(uid);
            const by = userInfo?.username ? `@${userInfo.username}` : userInfo?.first_name || `User ${uid}`;
            ticket.replies.push({ by, text: reply, timestamp: isoNow() });
            supportTickets.set(flow.ticket_id, ticket);
            const cap = formatTicketCaption(ticket);
            await safeEditText(ADMIN_GROUP_ID, ticket.message_thread_id, cap, buildAdminTicketKeyboard(flow.ticket_id));
            await bot.sendMessage(uid, `Your reply was posted to ticket ${flow.ticket_id}.`);
            userFlows.delete(uid);
            await writeSnapshot();
            return;
          }
        }

        if (flow.kind === "CASHOUT") {
          if (flow.step === "WAIT_USERNAME") {
            if (!msg.text) {
              await renderCashoutFlow(uid, "Please send your username as text.");
              return;
            }
            flow.username = msg.text.trim();
            flow.step = "WAIT_AMOUNT";
            userFlows.set(uid, flow);
            await renderCashoutFlow(uid);
            return;
          }

          if (flow.step === "WAIT_AMOUNT") {
            if (!msg.text) {
              await renderCashoutFlow(uid, "Please send the amount as text.");
              return;
            }
            const amt = normalizeAmount(msg.text.trim());
            if (amt === null) {
              await renderCashoutFlow(uid, "Invalid amount. Enter a number greater than 0.");
              return;
            }
            flow.amount = amt;
            flow.step = "WAIT_CASHTAG";
            userFlows.set(uid, flow);
            await renderCashoutFlow(uid);
            return;
          }

          if (flow.step === "WAIT_CASHTAG") {
            if (!msg.text) {
              await renderCashoutFlow(uid, "Please send the cashtag as text.");
              return;
            }
            flow.cashtag = msg.text.trim();
            flow.step = "WAIT_RECEIVING_QR";
            userFlows.set(uid, flow);
            await renderCashoutFlow(uid);
            return;
          }

          if (flow.step === "WAIT_RECEIVING_QR") {
            const photoId = pickBestPhotoFileId(msg.photo);
            if (photoId) {
              flow.receiving_qr_file_id = photoId;
              flow.receiving_qr_type = "photo";
            } else if (msg.document?.file_id) {
              flow.receiving_qr_file_id = msg.document.file_id;
              flow.receiving_qr_type = "document";
            } else {
              await renderCashoutFlow(uid, "Send your receiving QR as a photo or document.");
              return;
            }
            flow.step = "PROCESSING";
            userFlows.set(uid, flow);

            const requestId = await submitCashoutForApproval(flow, {
              type: flow.receiving_qr_type,
              file_id: flow.receiving_qr_file_id,
            });
            flow.request_id = requestId;
            userFlows.set(uid, flow);
            await renderCashoutFlow(uid);
            return;
          }

          return;
        }

        if (flow.kind === "SUPPORT") {
          if (flow.step === "WAIT_SUBJECT") {
            if (!msg.text) {
              await renderSupportFlow(uid, "Please send your subject as text.");
              return;
            }
            flow.subject = msg.text.trim();
            flow.step = "WAIT_MESSAGE";
            userFlows.set(uid, flow);
            await renderSupportFlow(uid);
            return;
          }

          if (flow.step === "WAIT_MESSAGE") {
            if (!msg.text) {
              await renderSupportFlow(uid, "Please send your message as text.");
              return;
            }
            flow.message = msg.text.trim();
            flow.step = "PROCESSING";
            userFlows.set(uid, flow);

            const ticketId = await submitSupportTicket(flow);
            flow.ticket_id = ticketId;
            flow.step = "DONE";
            userFlows.set(uid, flow);
            await renderSupportFlow(uid);
            return;
          }

          return;
        }
      }

      // If no flow, ignore free text (menu is inline keyboard driven)
      return;
    }

    // ADMIN GROUP TOPIC INGEST
    if (isAdminGroupMessage(msg)) {
      const threadId = getThreadId(msg);
      if (threadId === TOPIC_THREAD_IDS.MANAGE_GAMES) {
        await handleManageGamesTopicMessage(msg);
        return;
      }
      if (threadId === TOPIC_THREAD_IDS.ACCOUNT_INVENTORY) {
        await handleAccountInventoryTopicMessage(msg);
        return;
      }
      if (threadId === TOPIC_THREAD_IDS.PAYMENT_CONFIG) {
        // Check for PAYMENT_METHOD_DISABLE
        if (msg.caption?.includes("PAYMENT_METHOD_DISABLE") || msg.text?.includes("PAYMENT_METHOD_DISABLE")) {
          await handlePaymentMethodStatusMessage(msg, "DISABLE");
          return;
        }
        // Check for PAYMENT_METHOD_ENABLE
        if (msg.caption?.includes("PAYMENT_METHOD_ENABLE") || msg.text?.includes("PAYMENT_METHOD_ENABLE")) {
          await handlePaymentMethodStatusMessage(msg, "ENABLE");
          return;
        }
        // Otherwise, treat as payment QR config
        await handlePaymentConfigTopicMessage(msg);
        return;
      }

      // Topic restricted commands
      if (msg.text && msg.text.trim().toLowerCase().startsWith("/promo")) {
        await handlePromoCommand(msg);
        return;
      }
      if (msg.text && msg.text.trim().toLowerCase().startsWith("/msguser")) {
        await handleMsgUserCommand(msg);
        return;
      }

      // Admin input capture
      const ai = adminInputs.get(msg.from.id);
      if (ai) {
        if (ai.kind === "PROMO_TEXT") {
          if (!mustBeTopic(msg, TOPIC_THREAD_IDS.PROMOTIONS)) return;
          adminInputs.delete(msg.from.id);
          const promoText = msg.text || msg.caption || "";
          if (!promoText.trim()) return;
          await broadcastPromotion(promoText.trim());
          return;
        }

        if (ai.kind === "MSGUSER_USERID") {
          if (!mustBeTopic(msg, TOPIC_THREAD_IDS.ADMIN_USER_MSGS)) return;
          if (!msg.text || !/^\d+$/.test(msg.text.trim())) {
            await sendToTopicText(TOPIC_THREAD_IDS.ADMIN_USER_MSGS, "⚠️ Please send a numeric User ID.");
            return;
          }
          const targetUserId = Number(msg.text.trim());
          adminInputs.set(msg.from.id, { kind: "MSGUSER_TEXT", target_user_id: targetUserId });
          await sendToTopicText(
            TOPIC_THREAD_IDS.ADMIN_USER_MSGS,
            ["✉️ <b>/msguser</b>", "Step 2 / 2", `Target User ID: <code>${targetUserId}</code>`, "Send the message text as your next message."].join("\n"),
          );
          return;
        }

        if (ai.kind === "MSGUSER_TEXT") {
          if (!mustBeTopic(msg, TOPIC_THREAD_IDS.ADMIN_USER_MSGS)) return;
          adminInputs.delete(msg.from.id);
          const msgText = (msg.text || msg.caption || "").trim();
          if (!msgText) return;
          let result = "SENT";
          try {
            await withRetry(() => bot.sendMessage(ai.target_user_id, msgText));
          } catch (e) {
            result = `FAILED: ${safeText(e?.message)}`;
          }
          await logAdminUserMsg(msg.from, ai.target_user_id, msgText, result);
          return;
        }

        if (ai.kind === "REJECT_REASON") {
          // Reason must be in approvals topic thread, from same admin who clicked Reject
          if (getThreadId(msg) !== ai.topic_thread_id) return;
          const reason = (msg.text || "").trim();
          if (!reason) return;
          adminInputs.delete(msg.from.id);
          await finalizeDecision(ai.request_id, "REJECTED", adminIdentity(msg.from), reason);
          return;
        }

        if (ai.kind === "TICKET_REPLY") {
          // Reply must be in support tickets topic thread
          if (getThreadId(msg) !== ai.topic_thread_id) return;
          const replyText = (msg.text || "").trim();
          if (!replyText) return;
          adminInputs.delete(msg.from.id);
          const ticket = supportTickets.get(ai.ticket_id);
          if (!ticket) return;
          ticket.replies.push({
            by: adminIdentity(msg.from),
            text: replyText,
            timestamp: isoNow(),
          });
          supportTickets.set(ai.ticket_id, ticket);
          const cap = formatTicketCaption(ticket);
          await safeEditText(ADMIN_GROUP_ID, ai.ticket_message_id, cap, buildAdminTicketKeyboard(ai.ticket_id));
          await writeSnapshot();
          return;
        }
      }
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

// =========================
// ROUTING: EDITED MESSAGES (Telegram source of truth)
// =========================
bot.on("edited_message", async (msg) => {
  try {
    if (!isAdminGroupMessage(msg)) return;
    const threadId = getThreadId(msg);
    if (threadId === TOPIC_THREAD_IDS.MANAGE_GAMES && msg.text && msg.from?.id === BOT_ID) {
      const parsed = parseGameMessage(msg.text);
      if (!parsed) return;
      const existing = gamesById.get(parsed.id);
      if (existing && existing.message_id === msg.message_id) {
        gamesById.set(parsed.id, { ...parsed, message_id: msg.message_id });
        await writeSnapshot();
      }
      return;
    }
    if (threadId === TOPIC_THREAD_IDS.ACCOUNT_INVENTORY && msg.text && msg.from?.id === BOT_ID) {
      const parsed = parseAccountMessage(msg.text);
      if (!parsed) return;
      accountsByMsgId.set(msg.message_id, parsed);
      if (parsed.status === "AVAILABLE") queueAddAvailable(parsed.game, msg.message_id);
      else queueRemove(parsed.game, msg.message_id);
      await writeSnapshot();
      return;
    }
  } catch (e) {
    console.error("edited_message handler error:", e);
  }
});

// =========================
// ROUTING: CALLBACK QUERIES (INLINE KEYBOARDS ONLY)
// =========================
bot.on("callback_query", async (q) => {
  try {
    console.log(`[CALLBACK] From user ${q.from?.id}, Data: "${q.data}"`);
    const data = safeText(q.data);
    const parts = parseCb(data);
    const fromId = q.from?.id;

    // USER callbacks (private chat)
    if (parts[0] === "U") {
      console.log(`[CALLBACK USER] Action: ${parts[1]}, Parts:`, parts);
      if (!q.message || q.message.chat.type !== "private") {
        await answerCb(q.id, "Use this in private chat.");
        return;
      }

      const userId = fromId;
      if (parts[1] === "REFRESH_GAMES") {
        await answerCb(q.id, "Refreshing…");
        await safeEditText(q.message.chat.id, q.message.message_id, renderGamePickerText(userId), buildGamePickerKeyboard());
        return;
      }

      if (parts[1] === "GAME") {
        const gameId = parts[2];
        const g = gamesById.get(gameId);
        if (!g || g.status !== "ACTIVE") {
          await answerCbAlert(q.id, "That game is not available.");
          return;
        }
        setSelectedGameForUser(userId, gameId);
        await writeSnapshot();
        await answerCb(q.id, `Selected ${g.name}`);
        await safeEditText(q.message.chat.id, q.message.message_id, renderMainMenuText(userId), buildMainMenuKeyboard());
        return;
      }

      if (parts[1] === "MENU") {
        const action = parts[2];
        await answerCb(q.id, "OK");

        if (action === "CHANGE_GAME") {
          await safeEditText(q.message.chat.id, q.message.message_id, renderGamePickerText(userId), buildGamePickerKeyboard());
          return;
        }

        const game = selectedGameForUser(userId);
        if (!game) {
          await safeEditText(q.message.chat.id, q.message.message_id, renderGamePickerText(userId), buildGamePickerKeyboard());
          return;
        }

        if (action === "VIEW") {
          await safeEditText(q.message.chat.id, q.message.message_id, renderViewAccountText(userId), buildMainMenuKeyboard());
          return;
        }

        if (action === "REGISTER") {
          const res = await assignAccountToUser(userId, game);
          if (res.needsEmail) {
            await startEmailFlow(userId);
            return;
          }
          if (res.none) {
            await safeEditText(
              q.message.chat.id,
              q.message.message_id,
              ["🧾 <b>Register Account</b>", "", `🎮 Game: <b>${game}</b>`, "", "Status: <b>NO ACCOUNTS AVAILABLE</b>", "Please try again later."].join("\n"),
              buildMainMenuKeyboard(),
            );
            return;
          }
          if (res.editFailed) {
            await safeEditText(
              q.message.chat.id,
              q.message.message_id,
              ["🧾 <b>Register Account</b>", "", "⚠️ Failed to assign (inventory edit failed). Please contact admin."].join("\n"),
              buildMainMenuKeyboard(),
            );
            return;
          }
          await safeEditText(
            q.message.chat.id,
            q.message.message_id,
            [
              "🧾 <b>Register Account</b>",
              "",
              `🎮 Game: <b>${game}</b>`,
              "",
              res.already ? "Status: <b>ALREADY ASSIGNED</b>" : "Status: <b>ASSIGNED</b>",
              `Username: <code>${res.account.username}</code>`,
              `Password: <code>${res.account.password}</code>`,
              `Assigned At: <code>${res.account.assigned_at}</code>`,
            ].join("\n"),
            buildMainMenuKeyboard(),
          );
          return;
        }

        if (action === "LOAD") {
          await startLoadFlow(userId);
          return;
        }

        if (action === "CASHOUT") {
          await startCashoutFlow(userId);
          return;
        }

        if (action === "SUPPORT") {
          await startSupportFlow(userId);
          return;
        }

        if (action === "DOWNLOADS") {
          await safeEditText(q.message.chat.id, q.message.message_id, renderGameDownloadsText(), buildGameDownloadsKeyboard());
          return;
        }

        if (action === "MAIN") {
          await safeEditText(q.message.chat.id, q.message.message_id, renderMainMenuText(userId), buildMainMenuKeyboard());
          return;
        }
      }


      if (parts[1] === "TICKET") {
        const action = parts[2];
        const ticketId = parts[3];
        if (action === "REPLY") {
          await answerCb(q.id, "Replying…");
          const ticket = supportTickets.get(ticketId);
          if (!ticket) {
            await answerCbAlert(q.id, "Ticket not found.");
            return;
          }
          // Prompt user in this private chat to enter reply
          try {
            await safeEditText(q.message.chat.id, q.message.message_id, `💬 Reply to ticket <b>${ticketId}</b>\n\nEnter your reply message:`, buildFlowNavKeyboard("TICKET"));
          } catch (e) {
            // ignore
          }
          userFlows.set(userId, {
            kind: "TICKET_CONV",
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            step: "WAIT_USER_REPLY",
            ticket_id: ticketId,
            started_at: isoNow(),
          });
          return;
        }
      }

      if (parts[1] === "PAYMETHOD") {
        const method = parts[2];
        const gameId = parts[3];
        await answerCb(q.id, `Selected ${method}`);
        const flow = userFlows.get(userId);
        if (!flow || flow.kind !== "LOAD") return;

        const key = `${flow.game}::${method}`;
        const qr = paymentQRs.get(key);
        if (!qr) {
          await answerCbAlert(q.id, "QR not found for this method");
          return;
        }

        // Update flow with selected method and move to WAIT_USERNAME step
        flow.pay_method = method;
        flow.step = "WAIT_USERNAME";
        userFlows.set(userId, flow);

        // Send QR media with username prompt
        const caption = renderLoadCaption(flow);
        const inputMedia =
          qr.type === "photo"
            ? { type: "photo", media: qr.file_id, caption, parse_mode: "HTML" }
            : { type: "document", media: qr.file_id, caption, parse_mode: "HTML" };

        await safeEditMedia(flow.chat_id, flow.message_id, inputMedia, buildLoadStepKeyboard(flow.step));
        return;
      }

      if (parts[1] === "FLOW") {
        const kind = parts[2];
        const action = parts[3];
        const flow = userFlows.get(userId);

        if (action === "CANCEL") {
          await answerCb(q.id, "Cancelled");
          await cancelUserFlow(userId, "User cancelled");
          return;
        }

        if (action === "MENU") {
          await answerCb(q.id, "Menu");
          await finishUserFlowToMenu(userId, kind);
          return;
        }

        if (!flow || flow.kind !== kind) {
          await answerCbAlert(q.id, "No active flow.");
          return;
        }

        if (kind === "LOAD") {
          if (action === "PAID" && flow.step === "QR_WAIT_PAID") {
            flow.step = "WAIT_SCREENSHOT";
            userFlows.set(userId, flow);
            await answerCb(q.id, "Send screenshot");
            await renderLoadFlow(userId);
            return;
          }
          if (action === "RENDER") {
            await answerCb(q.id, "Refreshing…");
            await renderLoadFlow(userId);
            return;
          }
          if (action === "METHODS") {
            await answerCb(q.id, "Choose method");
            if (!flow) return;
            const prompt = "💳 <b>Select Payment Method</b>";
            await safeEditCaption(flow.chat_id, flow.message_id, prompt, buildPaymentMethodKeyboard(flow.game));
            return;
          }
        }
      }

      if (kind === "SUPPORT") {
        if (action === "CANCEL" || action === "MENU") {
          await answerCb(q.id, "Cancelled");
          await cancelUserFlow(userId, "User cancelled");
          return;
        }
      }

      await answerCb(q.id, "Unsupported.");
      return;
    }

    // ADMIN callbacks (in group)
    if (parts[0] === "A") {
      if (!q.message || q.message.chat.id !== ADMIN_GROUP_ID) {
        await answerCb(q.id, "Admins only.");
        return;
      }
      const ok = await isAdmin(fromId);
      if (!ok) {
        await answerCbAlert(q.id, "Admins only.");
        return;
      }

      // Game controls
      if (parts[1] === "GAME") {
        const gameId = parts[2];
        const newStatus = parts[3];
        const g = gamesById.get(gameId);
        if (!g) {
          await answerCbAlert(q.id, "Game not found.");
          return;
        }
        const updated = { id: g.id, name: g.name, status: newStatus };
        await upsertCanonicalGameFromParsed(updated, adminIdentity(q.from));
        await answerCb(q.id, `Set ${gameId} → ${newStatus}`);
        return;
      }

      // Approvals
      if (parts[1] === "APP") {
        const action = parts[2];
        const requestId = parts[3];
        const req = approvalRequests.get(requestId);
        if (!req) {
          await answerCbAlert(q.id, "Request not found.");
          await safeEditReplyMarkup(ADMIN_GROUP_ID, q.message.message_id, { inline_keyboard: [] });
          return;
        }
        if (req.status !== "PENDING") {
          await answerCbAlert(q.id, "Already handled.");
          await safeEditReplyMarkup(ADMIN_GROUP_ID, q.message.message_id, { inline_keyboard: [] });
          return;
        }

        if (action === "OK") {
          await answerCb(q.id, "Approved");
          await finalizeDecision(requestId, "APPROVED", adminIdentity(q.from), "");
          return;
        }

        if (action === "NO") {
          // Reject requires reason: capture via admin's next message in the same approvals topic
          await answerCb(q.id, "Enter reason in topic");
          adminInputs.set(fromId, {
            kind: "REJECT_REASON",
            request_id: requestId,
            topic_thread_id: req.approvals_topic_thread_id,
            approvals_message_id: q.message.message_id,
          });

          const prompt = [
            "❌ <b>Rejecting…</b>",
            "",
            `Request ID: <code>${requestId}</code>`,
            "",
            "Send the <b>rejection reason</b> as your next message in this topic.",
          ].join("\n");

          // Keep the approval message but replace buttons with cancel reject
          if (q.message.caption) await safeEditCaption(ADMIN_GROUP_ID, q.message.message_id, prompt, buildAdminRejectCancelKeyboard(requestId));
          else await safeEditText(ADMIN_GROUP_ID, q.message.message_id, prompt, buildAdminRejectCancelKeyboard(requestId));
          return;
        }

        if (action === "RC") {
          await answerCb(q.id, "Cancelled");
          adminInputs.delete(fromId);
          // Restore original buttons and caption
          const cap = approvalCaption(req);
          if (q.message.caption) await safeEditCaption(ADMIN_GROUP_ID, q.message.message_id, cap, buildAdminApproveRejectKeyboard(requestId));
          else await safeEditText(ADMIN_GROUP_ID, q.message.message_id, cap, buildAdminApproveRejectKeyboard(requestId));
          return;
        }
      }

      // Support tickets
      if (parts[1] === "TICKET") {
        const action = parts[2];
        const ticketId = parts[3];
        const ticket = supportTickets.get(ticketId);
        if (!ticket) {
          await answerCbAlert(q.id, "Ticket not found.");
          return;
        }

        if (action === "RESOLVE") {
          ticket.status = "RESOLVED";
          supportTickets.set(ticketId, ticket);
          await answerCb(q.id, "Marked resolved");
          const cap = formatTicketCaption(ticket);
          await safeEditText(ADMIN_GROUP_ID, ticket.message_thread_id, cap, buildAdminTicketKeyboard(ticketId));
          await writeSnapshot();
          return;
        }

        if (action === "CLOSE") {
          ticket.status = "CLOSED";
          supportTickets.set(ticketId, ticket);
          await answerCb(q.id, "Marked closed");
          const cap = formatTicketCaption(ticket);
          await safeEditText(ADMIN_GROUP_ID, ticket.message_thread_id, cap, buildAdminTicketKeyboard(ticketId));
          await writeSnapshot();
          return;
        }

        if (action === "REPLY") {
          await answerCb(q.id, "Enter reply — I'll DM you to collect it.");
          adminInputs.set(fromId, {
            kind: "TICKET_REPLY",
            ticket_id: ticketId,
            topic_thread_id: TOPIC_THREAD_IDS.SUPPORT_TICKETS,
            ticket_message_id: ticket.message_thread_id,
          });
          const prompt = [
            "💬 <b>Replying to Ticket…</b>",
            "",
            `Ticket ID: <code>${ticketId}</code>`,
            "",
            "You can reply in this topic or send your reply in the private chat I just opened.",
          ].join("\n");
          await safeEditText(ADMIN_GROUP_ID, ticket.message_thread_id, prompt, buildAdminRejectCancelKeyboard(ticketId));

          // Also DM the admin to collect the reply (easier UX)
          try {
            await withRetry(() =>
              bot.sendMessage(fromId, [
                `💬 Replying to Ticket <b>${ticketId}</b>`,
                "",
                "Send your reply message here and I'll post it to the support ticket thread.",
                "(Or post directly in the support topic.)",
              ].join("\n"), { parse_mode: "HTML" }),
            );
          } catch (e) {
            // ignore DM failure (admin may have DMs closed)
          }
          return;
        }
      }

      await answerCb(q.id, "Unsupported.");
      return;
    }
  } catch (e) {
    console.error("callback_query handler error:", e);
  }
});

// =========================
// STARTUP / HEALTHCHECK
// =========================
async function startup() {
  const me = await bot.getMe();
  BOT_ID = me.id;
  BOT_USERNAME = me.username || null;

  validateTopicThreadIdsOrExit();

  // Ensure bot is admin in group
  const botMember = await bot.getChatMember(ADMIN_GROUP_ID, BOT_ID);
  if (!botMember || (botMember.status !== "administrator" && botMember.status !== "creator")) {
    console.error("❌ Bot must be ADMIN in the supergroup.");
    process.exit(1);
  }

  // Forum topics check (best-effort)
  try {
    const chat = await bot.getChat(ADMIN_GROUP_ID);
    if (!chat?.is_forum) {
      console.warn("⚠️ Group does not report is_forum=true. Forum Topics must be enabled.");
    }
  } catch {
    // ignore
  }

  const hadState = await rehydrateOnStartup();
  await syncDefaultGamesIfFirstBoot(hadState);

  // Periodic snapshots
  setInterval(async () => {
    try {
      await writeSnapshot();
    } catch (e) {
      console.warn("Periodic snapshot failed:", safeText(e?.message));
    }
  }, SNAPSHOT_INTERVAL_MS);

  // Log polling state
  console.log(`[STARTUP] Polling enabled: true`);
  console.log(`[STARTUP] BOT_TOKEN length: ${BOT_TOKEN.length}`);
  
  console.log(`✅ Bot started (polling): @${BOT_USERNAME || "unknown"} (${BOT_ID})`);
  console.log(`✅ Admin group: ${ADMIN_GROUP_ID}`);
  console.log(`[READY] Waiting for messages...`);
}

startup().catch((e) => {
  console.error("Startup failed:", e);
  process.exit(1);
});

// =========================
// GRACEFUL SHUTDOWN
// =========================
async function shutdown(sig) {
  try {
    console.log(`\n⏹ Shutting down (${sig})…`);
    await writeSnapshot();
  } catch {
    // ignore
  }
  try {
    await bot.stopPolling();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
