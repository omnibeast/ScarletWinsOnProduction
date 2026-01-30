/**
 * Production-ready Telegram bot (polling) using node-telegram-bot-api
 * - Private chat user flow with inline buttons
 * - Admin group acts as database (accounts + requests are messages in group)
 * - In-memory state per user via Map()
 * - Mirrors state into admin group messages and edits them to reflect status
 *
 * IMPORTANT:
 * - Bot MUST be admin in the admin group to read messages reliably and to edit messages.
 * - Accounts are stored as admin-group messages with a strict format (see ACCOUNT line below).
 */

const TelegramBot = require("node-telegram-bot-api");

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "8370829137:AAGT2UrtcfpJp136LxNvIFvLjvt4VLW_j2M";

// Your admin group chat id, e.g. -1001234567890
const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID || "-1003579950450");

// Admin user IDs (optional hardening).
// If empty, bot will rely on Telegram "administrator/creator" status checks in the group.
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

// Games shown to users (buttons + stored as IDs)
const GAMES = [
  { id: "GameA", label: "Game A" },
  { id: "GameB", label: "Game B" },
  { id: "GameC", label: "Game C" },
];

// Payment QR: use a Telegram file_id for a photo for best speed
// You can also use a URL, but file_id is better.
const PAYMENT_QR_FILE_ID = process.env.PAYMENT_QR_FILE_ID || null;

// Account scanning limit when searching admin group history
// Keep reasonable to avoid slowness.
const ACCOUNT_SCAN_LIMIT = Number(process.env.ACCOUNT_SCAN_LIMIT || "200");

// ===================== INIT =====================
if (!BOT_TOKEN || BOT_TOKEN.includes("PUT_YOUR_BOT_TOKEN_HERE")) {
  console.error("❌ Please set BOT_TOKEN in env or bot.js");
  process.exit(1);
}
if (!ADMIN_GROUP_ID || Number.isNaN(ADMIN_GROUP_ID)) {
  console.error("❌ Please set ADMIN_GROUP_ID (e.g. -100123...) in env or bot.js");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 30 },
  },
});

// ===================== STATE =====================
// Per-user state machine (private chat)
const userState = new Map(); // userId -> session

// Simple cache of admin group accounts (parsed from messages)
// accountKey = `${game}|${username}`
const accountCache = new Map(); // accountKey -> { game, username, password, status, assigned_to, message_id }

// Pending approvals (requestId -> data)
const pendingRequests = new Map(); // requestId -> { type, userId, game, username, amount, cashtag?, adminMsgId, photoFileId? }

// ===================== UTIL =====================
function isPrivateChat(msg) {
  return msg.chat && msg.chat.type === "private";
}
function isAdminGroup(msg) {
  return msg.chat && (msg.chat.id === ADMIN_GROUP_ID);
}

function nowIso() {
  return new Date().toISOString();
}

function getSession(userId) {
  if (!userState.has(userId)) {
    userState.set(userId, {
      step: "IDLE", // state step for text/photo capture
      game: null,   // selected game id
      flow: null,   // REGISTER | LOAD | CASHOUT
      temp: {},     // stores username/amount/cashtag etc during flow
      lastPromptMsgId: null,
    });
  }
  return userState.get(userId);
}

function resetToMenu(userId) {
  const s = getSession(userId);
  s.step = "IDLE";
  s.flow = null;
  s.temp = {};
}

function gameLabel(gameId) {
  return (GAMES.find(g => g.id === gameId) || { label: gameId }).label;
}

function buildGameKeyboard() {
  return {
    inline_keyboard: [
      GAMES.map(g => ({ text: g.label, callback_data: `U|GAME|${g.id}` })),
    ],
  };
}

function buildMainMenuKeyboard(gameId) {
  return {
    inline_keyboard: [
      [{ text: "Register Account", callback_data: `U|MENU|REGISTER|${gameId}` }],
      [{ text: "Load Balance", callback_data: `U|MENU|LOAD|${gameId}` }],
      [{ text: "Cashout", callback_data: `U|MENU|CASHOUT|${gameId}` }],
      [{ text: "Change Game", callback_data: `U|CHANGE_GAME` }],
    ],
  };
}

function buildIHavePaidKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "I Have Paid", callback_data: "U|PAID" }],
      [{ text: "Cancel", callback_data: "U|CANCEL" }],
    ],
  };
}

function buildAdminApproveRejectKeyboard(requestId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `A|APPROVE|${requestId}` },
        { text: "❌ Reject", callback_data: `A|REJECT|${requestId}` },
      ],
    ],
  };
}

async function safeEditMessageText(chatId, messageId, text, replyMarkup) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    // Common: "message is not modified" or message too old, etc.
    console.warn("editMessageText failed:", e.message);
    return null;
  }
}

async function safeEditMessageReplyMarkup(chatId, messageId, replyMarkup) {
  try {
    return await bot.editMessageReplyMarkup(replyMarkup, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (e) {
    console.warn("editMessageReplyMarkup failed:", e.message);
    return null;
  }
}

async function safeAnswerCallbackQuery(cbqId, text, showAlert = false) {
  try {
    await bot.answerCallbackQuery(cbqId, { text, show_alert: showAlert });
  } catch (e) {
    // ignore
  }
}

// Check admin status in group (stronger than a static list)
async function isUserAdminInGroup(userId) {
  // If ADMIN_USER_IDS is provided, allow those immediately
  if (ADMIN_USER_IDS.length && ADMIN_USER_IDS.includes(userId)) return true;

  try {
    const member = await bot.getChatMember(ADMIN_GROUP_ID, userId);
    return member && (member.status === "administrator" || member.status === "creator");
  } catch (e) {
    return false;
  }
}

// ===================== ADMIN GROUP “DATABASE” PARSING =====================
//
// Accounts are stored as messages in the admin group with this canonical line format:
//
// ACCOUNT | game=GameA | username=xxx | password=yyy | status=AVAILABLE
// Optional fields added/edited by bot:
// ACCOUNT | game=GameA | username=xxx | password=yyy | status=ASSIGNED | assigned_to=123456
//
// We parse these messages and cache them.
//

function parseAccountText(text) {
  if (!text) return null;
  const t = text.trim();
  if (!t.startsWith("ACCOUNT |")) return null;

  // naive parsing by splitting on "|"
  const parts = t.split("|").map(p => p.trim());
  // parts[0] = "ACCOUNT"
  const data = {};
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const [k, ...rest] = seg.split("=");
    if (!k || rest.length === 0) continue;
    data[k.trim()] = rest.join("=").trim();
  }
  if (!data.game || !data.username || !data.password || !data.status) return null;

  return {
    game: data.game,
    username: data.username,
    password: data.password,
    status: data.status,
    assigned_to: data.assigned_to ? Number(data.assigned_to) : null,
  };
}

function accountKey(game, username) {
  return `${game}|${username}`;
}

// Load recent account messages from admin group (best-effort)
async function refreshAccountCache() {
  // NOTE: Telegram Bot API cannot truly “search history” unless the bot is present and receives updates.
  // However, in practice, if accounts are created while bot is in group, we cache them as they come in.
  // This refresh attempts to use getUpdates indirectly via polling is handled by library.
  // So refreshAccountCache is mainly a placeholder for future enhancements.
  //
  // We'll keep cache updated from on("message") for admin group.
  return;
}

// Find first AVAILABLE account for game from cache
function findFirstAvailableAccount(gameId) {
  for (const acc of accountCache.values()) {
    if (acc.game === gameId && acc.status === "AVAILABLE") {
      return acc;
    }
  }
  return null;
}

// Update account message in admin group to ASSIGNED
async function assignAccount(acc, userId) {
  const newText =
    `ACCOUNT | game=${acc.game} | username=${acc.username} | password=${acc.password} | status=ASSIGNED | assigned_to=${userId} | assigned_at=${nowIso()}`;

  // Edit the admin group message
  await safeEditMessageText(ADMIN_GROUP_ID, acc.message_id, newText, null);

  // Update cache
  acc.status = "ASSIGNED";
  acc.assigned_to = userId;
  accountCache.set(accountKey(acc.game, acc.username), acc);

  return acc;
}

// ===================== USER HANDLERS =====================
async function sendWelcomeAndGames(chatId) {
  await bot.sendMessage(chatId, "Welcome! Select a game:", {
    reply_markup: buildGameKeyboard(),
  });
}

async function sendMainMenu(chatId, userId) {
  const s = getSession(userId);
  if (!s.game) {
    return sendWelcomeAndGames(chatId);
  }
  await bot.sendMessage(
    chatId,
    `Selected: <b>${gameLabel(s.game)}</b>\nChoose an option:`,
    { parse_mode: "HTML", reply_markup: buildMainMenuKeyboard(s.game) }
  );
}

async function startRegisterFlow(chatId, userId, gameId) {
  const s = getSession(userId);
  s.flow = "REGISTER";
  s.step = "IDLE";

  // Find first available account from cache
  const acc = findFirstAvailableAccount(gameId);
  if (!acc) {
    await bot.sendMessage(chatId, "No accounts available right now.");
    return sendMainMenu(chatId, userId);
  }

  // Assign it by editing the admin message
  await assignAccount(acc, userId);

  // Send credentials privately
  await bot.sendMessage(
    chatId,
    `✅ Account assigned for <b>${gameLabel(gameId)}</b>\n\n` +
      `Username: <code>${acc.username}</code>\n` +
      `Password: <code>${acc.password}</code>`,
    { parse_mode: "HTML" }
  );

  resetToMenu(userId);
  return sendMainMenu(chatId, userId);
}

async function startLoadFlow(chatId, userId, gameId) {
  const s = getSession(userId);
  s.flow = "LOAD";
  s.step = "LOAD_WAIT_USERNAME";
  s.temp = { game: gameId };

  await bot.sendMessage(chatId, "Enter your game username:");
}

async function startCashoutFlow(chatId, userId, gameId) {
  const s = getSession(userId);
  s.flow = "CASHOUT";
  s.step = "CASHOUT_WAIT_USERNAME";
  s.temp = { game: gameId };

  await bot.sendMessage(chatId, "Enter game username:");
}

// Handle user text & photos (private chat)
async function handleUserMessage(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const s = getSession(userId);

  // Commands
  if (msg.text === "/start") {
    resetToMenu(userId);
    return sendWelcomeAndGames(chatId);
  }

  // Only process stateful inputs in private chat
  if (!isPrivateChat(msg)) return;

  // Cancel word (optional)
  if (msg.text && msg.text.toLowerCase() === "cancel") {
    resetToMenu(userId);
    await bot.sendMessage(chatId, "Cancelled.");
    return sendMainMenu(chatId, userId);
  }

  // PHOTO upload step for load proof
  if (s.step === "LOAD_WAIT_PROOF") {
    if (!msg.photo || msg.photo.length === 0) {
      await bot.sendMessage(chatId, "Please upload a payment screenshot (photo).");
      return;
    }

    // Choose highest-res photo file_id
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    // Create admin request message + attach screenshot
    const requestId = `L-${userId}-${Date.now()}`;

    const text =
      `🟡 <b>LOAD REQUEST</b>\n` +
      `Game: <b>${gameLabel(s.temp.game)}</b>\n` +
      `User ID: <code>${userId}</code>\n` +
      `Username: <code>${s.temp.username}</code>\n` +
      `Amount: <b>${s.temp.amount}</b>\n` +
      `Status: <b>PENDING</b>\n` +
      `Request ID: <code>${requestId}</code>`;

    const sent = await bot.sendPhoto(ADMIN_GROUP_ID, fileId, {
      caption: text,
      parse_mode: "HTML",
      reply_markup: buildAdminApproveRejectKeyboard(requestId),
    });

    pendingRequests.set(requestId, {
      type: "LOAD",
      userId,
      game: s.temp.game,
      username: s.temp.username,
      amount: s.temp.amount,
      adminMsgId: sent.message_id,
      photoFileId: fileId,
    });

    await bot.sendMessage(chatId, "✅ Proof received. Sent to admins for approval.");

    resetToMenu(userId);
    return sendMainMenu(chatId, userId);
  }

  // Text steps
  if (msg.text) {
    const text = msg.text.trim();

    // LOAD flow
    if (s.step === "LOAD_WAIT_USERNAME") {
      s.temp.username = text;
      s.step = "LOAD_WAIT_AMOUNT";
      await bot.sendMessage(chatId, "Enter amount:");
      return;
    }
    if (s.step === "LOAD_WAIT_AMOUNT") {
      const amt = Number(text);
      if (!Number.isFinite(amt) || amt <= 0) {
        await bot.sendMessage(chatId, "Please enter a valid amount (number > 0).");
        return;
      }
      s.temp.amount = amt;
      s.step = "LOAD_SHOW_QR";

      // Send payment QR + [I Have Paid]
      if (PAYMENT_QR_FILE_ID) {
        await bot.sendPhoto(chatId, PAYMENT_QR_FILE_ID, {
          caption: "Scan the QR to pay, then tap <b>I Have Paid</b>.",
          parse_mode: "HTML",
          reply_markup: buildIHavePaidKeyboard(),
        });
      } else {
        await bot.sendMessage(chatId, "Payment QR is not configured. Ask admin to set it.", {
          reply_markup: buildIHavePaidKeyboard(),
        });
      }
      return;
    }

    // CASHOUT flow
    if (s.step === "CASHOUT_WAIT_USERNAME") {
      s.temp.username = text;
      s.step = "CASHOUT_WAIT_AMOUNT";
      await bot.sendMessage(chatId, "Enter amount:");
      return;
    }
    if (s.step === "CASHOUT_WAIT_AMOUNT") {
      const amt = Number(text);
      if (!Number.isFinite(amt) || amt <= 0) {
        await bot.sendMessage(chatId, "Please enter a valid amount (number > 0).");
        return;
      }
      s.temp.amount = amt;
      s.step = "CASHOUT_WAIT_CASHTAG";
      await bot.sendMessage(chatId, "Enter cashtag:");
      return;
    }
    if (s.step === "CASHOUT_WAIT_CASHTAG") {
      s.temp.cashtag = text;

      const requestId = `C-${userId}-${Date.now()}`;

      const caption =
        `🟡 <b>CASHOUT REQUEST</b>\n` +
        `Game: <b>${gameLabel(s.temp.game)}</b>\n` +
        `User ID: <code>${userId}</code>\n` +
        `Username: <code>${s.temp.username}</code>\n` +
        `Amount: <b>${s.temp.amount}</b>\n` +
        `Cashtag: <code>${s.temp.cashtag}</code>\n` +
        `Status: <b>PENDING</b>\n` +
        `Request ID: <code>${requestId}</code>`;

      const sent = await bot.sendMessage(ADMIN_GROUP_ID, caption, {
        parse_mode: "HTML",
        reply_markup: buildAdminApproveRejectKeyboard(requestId),
      });

      pendingRequests.set(requestId, {
        type: "CASHOUT",
        userId,
        game: s.temp.game,
        username: s.temp.username,
        amount: s.temp.amount,
        cashtag: s.temp.cashtag,
        adminMsgId: sent.message_id,
      });

      await bot.sendMessage(chatId, "✅ Cashout request submitted. Waiting for admin decision.");

      resetToMenu(userId);
      return sendMainMenu(chatId, userId);
    }
  }

  // If user sends something unexpected
  // show menu rather than getting stuck
  if (s.step !== "IDLE") {
    await bot.sendMessage(chatId, "I didn’t understand that. Type <b>cancel</b> to abort.", {
      parse_mode: "HTML",
    });
  } else {
    await sendMainMenu(chatId, userId);
  }
}

// Handle user callbacks (private chat buttons)
async function handleUserCallback(cbq) {
  const userId = cbq.from.id;
  const chatId = cbq.message.chat.id;

  // Only allow user callbacks in private chats
  if (cbq.message.chat.type !== "private") return;

  const data = cbq.data || "";
  const s = getSession(userId);

  // U|GAME|GameA
  if (data.startsWith("U|GAME|")) {
    const gameId = data.split("|")[2];
    s.game = gameId;
    resetToMenu(userId); // keep game but reset flow
    s.game = gameId;

    await safeAnswerCallbackQuery(cbq.id, `Selected ${gameLabel(gameId)}`);
    await bot.sendMessage(chatId, `Selected: <b>${gameLabel(gameId)}</b>`, { parse_mode: "HTML" });
    return sendMainMenu(chatId, userId);
  }

  // U|MENU|REGISTER|GameA
  if (data.startsWith("U|MENU|")) {
    const [, , action, gameId] = data.split("|");
    await safeAnswerCallbackQuery(cbq.id, "OK");

    if (!s.game) s.game = gameId;

    if (action === "REGISTER") return startRegisterFlow(chatId, userId, s.game);
    if (action === "LOAD") return startLoadFlow(chatId, userId, s.game);
    if (action === "CASHOUT") return startCashoutFlow(chatId, userId, s.game);
  }

  if (data === "U|CHANGE_GAME") {
    resetToMenu(userId);
    await safeAnswerCallbackQuery(cbq.id, "Choose a game");
    return sendWelcomeAndGames(chatId);
  }

  if (data === "U|CANCEL") {
    resetToMenu(userId);
    await safeAnswerCallbackQuery(cbq.id, "Cancelled");
    await bot.sendMessage(chatId, "Cancelled.");
    return sendMainMenu(chatId, userId);
  }

  if (data === "U|PAID") {
    // Move to proof upload
    if (s.flow !== "LOAD") {
      await safeAnswerCallbackQuery(cbq.id, "Not in load flow");
      return;
    }
    s.step = "LOAD_WAIT_PROOF";
    await safeAnswerCallbackQuery(cbq.id, "Upload screenshot");
    await bot.sendMessage(chatId, "Please upload your payment screenshot (photo).");
    return;
  }

  await safeAnswerCallbackQuery(cbq.id, "Unknown action");
}

// ===================== ADMIN HANDLERS =====================
async function handleAdminCallback(cbq) {
  const fromId = cbq.from.id;
  const data = cbq.data || "";

  // Only process admin callbacks inside the admin group
  if (cbq.message.chat.id !== ADMIN_GROUP_ID) return;

  // Confirm admin
  const ok = await isUserAdminInGroup(fromId);
  if (!ok) {
    await safeAnswerCallbackQuery(cbq.id, "Admins only", true);
    return;
  }

  // A|APPROVE|requestId
  if (data.startsWith("A|APPROVE|") || data.startsWith("A|REJECT|")) {
    const [, action, requestId] = data.split("|");
    const req = pendingRequests.get(requestId);
    if (!req) {
      await safeAnswerCallbackQuery(cbq.id, "Request not found / already handled", true);
      // Remove buttons if stale
      await safeEditMessageReplyMarkup(ADMIN_GROUP_ID, cbq.message.message_id, { inline_keyboard: [] });
      return;
    }

    const approved = action === "APPROVE";
    const newStatus = approved ? "APPROVED" : "REJECTED";

    // Edit admin message text/caption to show status
    // For photos, it's caption; for text messages, it's text.
    const isPhoto = !!cbq.message.photo;

    const baseLines = (isPhoto ? (cbq.message.caption || "") : (cbq.message.text || "")).split("\n");
    const updated = baseLines.map(line => {
      if (line.startsWith("Status:")) return `Status: <b>${newStatus}</b>`;
      return line;
    });

    // Add admin marker line
    updated.push(`Admin: <code>${fromId}</code>`);
    updated.push(`Decision At: <code>${nowIso()}</code>`);

    const newContent = updated.join("\n");

    try {
      if (isPhoto) {
        await bot.editMessageCaption(newContent, {
          chat_id: ADMIN_GROUP_ID,
          message_id: cbq.message.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        await safeEditMessageText(ADMIN_GROUP_ID, cbq.message.message_id, newContent, { inline_keyboard: [] });
      }
    } catch (e) {
      console.warn("Failed to edit admin decision message:", e.message);
      // still continue
    }

    // Notify user
    const notifyText =
      req.type === "LOAD"
        ? (approved ? "✅ Load approved" : "❌ Load rejected")
        : (approved ? "✅ Cashout approved" : "❌ Cashout rejected");

    try {
      await bot.sendMessage(req.userId, notifyText);
    } catch (e) {
      // user may have blocked bot
      console.warn("Failed to notify user:", e.message);
    }

    pendingRequests.delete(requestId);

    await safeAnswerCallbackQuery(cbq.id, `Marked ${newStatus}`);
    return;
  }

  await safeAnswerCallbackQuery(cbq.id, "Unknown admin action");
}

// ===================== ADMIN GROUP MESSAGE INGEST =====================
// This keeps accountCache updated whenever someone posts an ACCOUNT line.
async function ingestAdminGroupMessage(msg) {
  // Only parse text messages for accounts
  if (!msg.text) return;

  const parsed = parseAccountText(msg.text);
  if (!parsed) return;

  const key = accountKey(parsed.game, parsed.username);
  accountCache.set(key, {
    ...parsed,
    message_id: msg.message_id,
  });
}

// ===================== ROUTERS =====================
bot.on("message", async (msg) => {
  try {
    if (isAdminGroup(msg)) {
      await ingestAdminGroupMessage(msg);
      // bot doesn't chat in group unless you later add admin-only commands
      return;
    }

    if (isPrivateChat(msg)) {
      await handleUserMessage(msg);
      return;
    }
  } catch (e) {
    console.error("message handler error:", e);
  }
});

bot.on("callback_query", async (cbq) => {
  try {
    const data = cbq.data || "";
    const chat = cbq.message?.chat;

    if (!chat) return;

    // Admin callbacks
    if (chat.id === ADMIN_GROUP_ID && data.startsWith("A|")) {
      return handleAdminCallback(cbq);
    }

    // User callbacks
    if (chat.type === "private" && data.startsWith("U|")) {
      return handleUserCallback(cbq);
    }

    // Fallback
    await safeAnswerCallbackQuery(cbq.id, "Not supported here");
  } catch (e) {
    console.error("callback handler error:", e);
  }
});

// ===================== STARTUP LOG =====================
(async () => {
  const me = await bot.getMe();
  console.log(`✅ Bot started: @${me.username}`);
  console.log(`✅ Admin group ID: ${ADMIN_GROUP_ID}`);
  console.log(`✅ Games: ${GAMES.map(g => g.id).join(", ")}`);

  if (!PAYMENT_QR_FILE_ID) {
    console.log("⚠️ PAYMENT_QR_FILE_ID not set. Load flow will warn user.");
  }
})();
