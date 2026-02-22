# Telegram Game Account Manager Bot
## Admin Standard Operating Procedures (SOP)

**Document Version:** 1.0  
**Effective Date:** January 31, 2026  
**Purpose:** Complete guide for administrators managing the bot

---

## 📋 Table of Contents

1. Introduction & Overview
2. System Architecture
3. Admin Topics & Data Structure
4. User Workflows
5. Admin Commands
6. Game Management
7. Approval Workflows
8. Inventory Management
9. Payment Configuration
10. System Monitoring & Maintenance

---

## 1️⃣ Introduction & Overview

### Purpose

The Telegram Game Account Manager Bot is a production-ready automated system for managing game account distribution, balance loads, cashouts, and user approvals through Telegram. This SOP provides comprehensive guidance for administrators.

### Key Features

- ✅ FIFO account assignment (one account per user per game)
- ✅ Single-message Load Balance & Cashout flows (edit only, no extra messages)
- ✅ Manual admin approval system (auditable)
- ✅ Email collection & validation
- ✅ Promotion broadcasts to all users
- ✅ Direct admin-to-user messaging
- ✅ Complete transaction logging
- ✅ Automatic snapshot backups

### Admin Requirements

To use admin commands, you must be:
- A **member of the admin supergroup**
- An **administrator** in that supergroup
- Have appropriate permissions to manage topics

---

## 2️⃣ System Architecture

### Polling Mode

The bot operates in **polling mode only** — no webhooks. This means:
- Bot continuously checks for new messages every 300ms
- No external HTTP endpoint required
- More reliable for unstable connections
- Standard deployment on any server

### Single File Deployment

The entire bot is contained in a single JavaScript file: `bot.js`
- No external databases
- No filesystem writes
- All data lives in Telegram
- In-memory Maps for fast access

### Persistence Model

Telegram messages are the **source of truth**:
- Messages are **never deleted**
- Only **bot-sent messages are edited**
- State snapshots automatically saved every 15 minutes
- On restart: restore from pinned snapshot

---

## 3️⃣ Admin Topics & Data Structure

### Forum Topics Overview

The admin supergroup must have **Forum Topics enabled**. Each topic acts as a database table:

#### 🎮 MANAGE_GAMES (Topic ID: 20)
- **Purpose:** Game configuration and status
- **Format:** `GAME | id=GameA | name=Game A | status=ACTIVE | download_url=https://example.com/gamea.apk`
- **Contains:** Bot-sent messages with game info and control buttons

#### 📦 ACCOUNT_INVENTORY (Topic ID: 4)
- **Purpose:** Game account inventory management
- **Format:** `ACCOUNT | game=GameA | username=user1 | password=pass123 | status=AVAILABLE`
- **Contains:** FIFO queue of accounts for assignment

#### 🟦 LOAD_APPROVALS (Topic ID: 6)
- **Purpose:** Load balance requests awaiting admin approval
- **Contains:** User's payment screenshot + admin approval buttons

#### 🟩 WITHDRAW_APPROVALS (Topic ID: 8)
- **Purpose:** Cashout requests awaiting admin approval
- **Contains:** User's receiving QR + admin approval buttons

#### 🧾 TRANSACTION_LOGS (Topic ID: 10)
- **Purpose:** Complete audit trail of all operations
- **Logs:** Games created, accounts assigned, approvals, rejections, all timestamps

#### 📧 EMAIL_LOGS (Topic ID: 12)
- **Purpose:** Email collection history
- **Logs:** When users provide their email addresses

#### 📣 PROMOTIONS (Topic ID: 2)
- **Purpose:** Promotion broadcasts
- **Action:** Use `/promo` command to broadcast to all users

#### 💳 PAYMENT_CONFIG (Topic ID: 57)
- **Purpose:** Payment QR codes per game
- **Contains:** Upload payment QR images/documents here

#### ✉️ ADMIN_USER_MSGS (Topic ID: 59)
- **Purpose:** Admin-to-user messaging logs
- **Action:** Use `/msguser` command to send DMs to users

#### 💾 SYSTEM_BACKUPS (Topic ID: 92)
- **Purpose:** State snapshots for recovery
- **Important:** Automatically created every 15 minutes. Do not modify.

---

## 4️⃣ User Workflows

### User Registration Flow (/start)

When a user sends `/start` in a private chat:
1. Bot saves user ID to known users
2. If no game selected → show game picker
3. If game selected → show main menu

### Main Menu Options

| Option | Description | Requirements |
|--------|-------------|--------------|
| 🧾 Register Account | Get assigned a game account from inventory | Email must be provided first (if new user) |
| 👤 View My Account | Display assigned username & password | Account must be assigned to user |
| 📥 Download Game | Show selected game's download link and open-link button | Selected game should have `download_url` configured |
| 🟦 Load Balance | Submit load request with payment proof | Account assigned; payment QR configured |
| 🟩 Cashout | Request withdrawal with receiving QR | Account assigned; sufficient balance |
| 🎮 Change Game | Switch to a different active game | Must be ACTIVE status |

Main menu also shows the currently selected game's download link at the top (or `Not set` if not configured).

### Load Balance Flow (ONE MESSAGE ONLY)

**CRITICAL: This flow edits a SINGLE message. NO extra bot messages are sent.**

1. **Step 1:** Bot displays payment QR + asks for username
2. **Step 2:** Bot EDITS message → asks for amount
3. **Step 3:** Bot EDITS message → user clicks "I Have Paid"
4. **Step 4:** Bot EDITS message → asks for payment screenshot
5. **Processing:** Bot EDITS message → shows "PENDING" status
6. **Result:** Bot EDITS message → shows "APPROVED" or "REJECTED"

### Cashout Flow (ONE MESSAGE ONLY)

**CRITICAL: This flow edits a SINGLE message. NO extra bot messages are sent.**

1. **Step 1:** Bot asks for username
2. **Step 2:** Bot EDITS message → asks for amount
3. **Step 3:** Bot EDITS message → asks for cashtag
4. **Step 4:** Bot EDITS message → asks for receiving QR
5. **Processing:** Bot EDITS message → shows "PENDING" status
6. **Result:** Bot EDITS message → shows "APPROVED" or "REJECTED"

---

## 5️⃣ Admin Commands

All admin commands must be issued in the **admin supergroup** (specific topic). Private chat commands are NOT supported for admins.

### Command 1: /promo

**📣 Broadcast Promotion to All Users**

**Location:** PROMOTIONS topic only  
**Access:** Administrators only

#### Usage Method 1: Inline Arguments
```
/promo Hello everyone! New Game X is LIVE!
```
The promotion text is sent immediately to all known users.

#### Usage Method 2: Follow-up Message
1. Type `/promo` (without text)
2. Bot will ask you to send the promotion text as your next message
3. Send the text, and it broadcasts immediately

#### Step-by-Step Example:
1. Navigate to **PROMOTIONS** topic in admin supergroup
2. Type: `/promo`
3. Bot replies: "Send the promotion text as your next message"
4. Send your promotion message
5. Bot broadcasts to all users + logs to PROMOTIONS topic

#### Result Logging:
- ✅ Successfully sent to N users
- ⚠️ Blocked/failed count tracked
- 📝 Full promotion text logged

**⚠️ Note:** If users have blocked the bot, they won't receive the promotion. Count of blocked users is logged.

---

### Command 2: /msguser

**✉️ Send Direct Message to Specific User**

**Location:** ADMIN_USER_MSGS topic only  
**Access:** Administrators only

#### Usage Method 1: Inline Arguments
```
/msguser 123456789 Your account has been approved!
```
Sends message immediately to user ID 123456789.

#### Usage Method 2: Interactive Steps
1. Type `/msguser` (without arguments)
2. Bot will ask for User ID, then message text in follow-up messages

#### Step-by-Step Example:
1. Navigate to **ADMIN_USER_MSGS** topic in admin supergroup
2. Type: `/msguser`
3. Bot replies: "Step 1 / 2: Send the User ID as your next message"
4. Send the numeric user ID (e.g., `123456789`)
5. Bot replies: "Step 2 / 2: Send the message text"
6. Send your message text
7. Bot sends message to user + logs result

#### How to Find User ID:
- User ID appears in approval requests (LOAD_APPROVALS / WITHDRAW_APPROVALS topics)
- Check TRANSACTION_LOGS for past user IDs
- Forward a message from the user to a bot that shows user info

**⚠️ Important:** User must have interacted with the bot before (via /start). Otherwise, message delivery will fail.

---

## 6️⃣ Game Management

### Creating Games

Games can be created two ways:

#### Method 1: Default Games (Automatic)
On first bot startup, three default games are automatically created in MANAGE_GAMES topic:
- Game A (ACTIVE)
- Game B (ACTIVE)
- Game C (DISABLED)

#### Method 2: Admin Posts New Game
To add a new game:
1. Go to **MANAGE_GAMES** topic
2. Post a message with format:
   ```
   GAME | id=GameD | name=Game D | status=ACTIVE | download_url=https://example.com/gamed.apk
   ```
3. Bot ingests it and creates canonical bot-sent record
4. Control buttons appear for admins (Enable/Disable/Archive)

### Changing Game Status

Use inline buttons in MANAGE_GAMES topic:

| Button | Current Status | New Status | Effect |
|--------|----------------|-----------|--------|
| ✅ Enable | DISABLED or ARCHIVED | ACTIVE | Game visible to users; can register accounts |
| 🚫 Disable | ACTIVE | DISABLED | Hidden from users; no new registrations |
| 🗄 Archive | ACTIVE or DISABLED | ARCHIVED | Permanently hidden; kept for record |

**💡 Tip:** Only **ACTIVE** games appear in the user game picker. Disabled/Archived games are hidden.

### Game Format Reference

When creating/updating games, use this exact format:
```
GAME | id=GAMEID | name=Game Name | status=STATUS | download_url=https://example.com/app.apk
```

- `id`: Unique identifier (no spaces, alphanumeric + underscore)
- `name`: Display name for users
- `status`: One of ACTIVE, DISABLED, ARCHIVED
- `download_url`: Optional HTTP/HTTPS download link shown in main menu and Download Game option

---

## 7️⃣ Approval Workflows

### Load Balance Approval Process

1. **User Submits:** User completes Load flow, bot sends payment screenshot to LOAD_APPROVALS topic with approval buttons
2. **Admin Reviews:** Admin sees photo + request details (username, amount, user ID, request ID)
3. **Admin Decides:** Click **✅ Approve** or **❌ Reject**
4. **If Approve:** Bot logs decision, edits user's message to show "APPROVED", removes buttons
5. **If Reject:** Admin enters rejection reason, bot logs it, edits user's message to show "REJECTED" + reason

### Cashout Approval Process

1. **User Submits:** User completes Cashout flow, bot sends receiving QR to WITHDRAW_APPROVALS topic with approval buttons
2. **Admin Reviews:** Admin sees photo/document + request details (username, amount, cashtag, user ID, request ID)
3. **Admin Decides:** Click **✅ Approve** or **❌ Reject**
4. **If Approve:** Bot logs decision, edits user's message to show "APPROVED", removes buttons
5. **If Reject:** Admin enters rejection reason in the same topic, bot logs it, edits user's message

### How to Reject with Reason

**When you click ❌ Reject:**

1. Bot changes message to "Enter rejection reason"
2. Send your reason as the next message in the same topic
3. Bot logs the rejection, sends reason to user, removes buttons

**⚠️ Important:** Your rejection reason message must be in the SAME topic thread as the approval request.

### Request ID Tracking

Each load/cashout request gets a unique ID format:
- **Load Requests:** Start with 'L' (e.g., `La1b2c3d4`)
- **Cashout Requests:** Start with 'C' (e.g., `Ca5e6f7g8`)

Use these IDs to look up transactions in TRANSACTION_LOGS topic.

---

## 8️⃣ Inventory Management

### Adding Game Accounts to Inventory

1. Navigate to **ACCOUNT_INVENTORY** topic
2. Post message with format:
   ```
   ACCOUNT | game=GameA | username=user123 | password=pass456 | status=AVAILABLE
   ```
3. Bot creates canonical bot-sent record for FIFO assignment
4. Account becomes available for users to register

### Account Format Reference

```
ACCOUNT | game=GAMEID | username=USERNAME | password=PASSWORD | status=STATUS
```

- `game`: Game ID (must match a created game)
- `username`: Account login username
- `password`: Account login password
- `status`: AVAILABLE (can also be ASSIGNED after registration)

### Account Assignment (Automatic)

When a user registers:
1. Bot checks user email (must be collected first)
2. Bot takes first AVAILABLE account from FIFO queue for that game
3. Bot EDITS the inventory message to mark status=ASSIGNED
4. Logs assignment to TRANSACTION_LOGS
5. Account no longer available for other users

**✅ FIFO Guarantee:** Accounts are assigned in the order they were added. First user to register gets first account.

### Checking Inventory Status

View ACCOUNT_INVENTORY topic to see:
- ✅ AVAILABLE accounts: Ready for registration
- 🔒 ASSIGNED accounts: Shows assigned user ID and timestamp
- 📊 Total count per game

**⚠️ Never Delete Messages:** Inventory messages are never deleted, only edited. This maintains audit trail.

---

## 9️⃣ Payment Configuration

### Setting Up Payment QR Codes

Payment QR codes are configured per game in the PAYMENT_CONFIG topic:

1. Navigate to **PAYMENT_CONFIG** topic
2. Upload photo or document with caption (specify payment method; optional `tag` can be added):
   ```
   PAYMENT_QR | game=GameA | method=CashApp | tag=Optional text
   ```
3. Bot stores this as canonical payment QR for GameA
4. When users load balance, bot displays this QR in their flow

### Updating Payment QR

To change a game's payment QR:
1. Go to PAYMENT_CONFIG topic
2. Upload the new QR image/document with caption, e.g. `PAYMENT_QR | game=GameA | method=CashApp | tag=Optional`
3. Bot automatically replaces the old QR with the new one

### Supported Formats

- ✅ Photo (PNG, JPG) - displayed inline in user's load flow
- ✅ Document (PDF, etc.) - downloadable in user's flow

**💡 Important:** If a game has no payment QR configured, users cannot load balance for that game. Configure QR before making game ACTIVE.

---

## 🔟 System Monitoring & Maintenance

### Monitoring System Health

Check these topics regularly:

| Topic | What to Monitor | Action if Issue |
|-------|-----------------|-----------------|
| TRANSACTION_LOGS | Frequency of operations (should see regular activity) | If no activity for hours, check bot status |
| LOAD_APPROVALS | Pending requests waiting for approval | Approve/reject promptly to keep users happy |
| WITHDRAW_APPROVALS | Pending cashout requests | Approve/reject promptly |
| EMAIL_LOGS | New users providing email addresses | Monitor for unusual activity |
| ACCOUNT_INVENTORY | Running low on AVAILABLE accounts? | Add more accounts before inventory empties |

### Automatic Backups

The system automatically creates state snapshots:
- ⏱️ Every 15 minutes (periodic automatic)
- 📝 After each major operation (game change, account assignment, approval)
- 💾 Stored in SYSTEM_BACKUPS topic
- 📌 Latest snapshot is pinned to the chat

### Recovery on Bot Restart

When the bot restarts:
1. Bot fetches pinned message from admin group
2. Extracts state snapshot from SYSTEM_BACKUPS topic
3. Rehydrates all Maps (games, accounts, users, payments, etc.)
4. Continues operation without data loss

**✅ Zero Data Loss:** Telegram is the source of truth. State is always recoverable.

### Bot Logs (Server Side)

Bot writes logs to console. Check server logs for:
- ⚠️ Error messages (if any operations fail)
- ✅ Startup confirmation (bot is running)
- 📊 Operation counts

### Email Validation

Email collection is mandatory for first-time account registration:
- Bot validates email format (basic regex check)
- Rejected emails: user prompted to re-enter
- Accepted emails logged to EMAIL_LOGS topic
- Email stored in user's session (in-memory)

### User Blocking Handling

If users block the bot:
- ❌ Promotions fail to deliver (counted in logs)
- ❌ Admin messages fail (error logged)
- ⚠️ User can still interact if they unblock

---

## ⚡ Quick Reference Card

| Task | Location | Action |
|------|----------|--------|
| Create Game | MANAGE_GAMES topic | Post `GAME \| id=X \| name=Y \| status=ACTIVE \| download_url=https://...` |
| Enable/Disable Game | MANAGE_GAMES topic | Click game control button |
| Add Accounts | ACCOUNT_INVENTORY topic | Post `ACCOUNT \| game=X \| username=Y \| password=Z \| status=AVAILABLE` |
| Set Payment QR | PAYMENT_CONFIG topic | Upload image with caption `PAYMENT_QR \| game=X \| method=MethodName \| tag=Optional` |
| Approve Load | LOAD_APPROVALS topic | Click ✅ Approve button |
| Reject Load | LOAD_APPROVALS topic | Click ❌ Reject, then send reason message |
| Approve Cashout | WITHDRAW_APPROVALS topic | Click ✅ Approve button |
| Reject Cashout | WITHDRAW_APPROVALS topic | Click ❌ Reject, then send reason message |
| Broadcast Promo | PROMOTIONS topic | Type `/promo` + text or send text after |
| Send DM to User | ADMIN_USER_MSGS topic | Type `/msguser USER_ID` + message |
| View All Logs | TRANSACTION_LOGS topic | Read chronological log of all operations |
| View Backups | SYSTEM_BACKUPS topic | Check pinned snapshot (do not edit) |

---

## 🔧 Troubleshooting

### Bot Not Responding

- **Check:** Is bot still in admin supergroup?
- **Check:** Server logs for errors
- **Fix:** Restart bot process
- **Recovery:** State will be restored from pinned snapshot

### User Can't Register Account

- **Cause 1:** No AVAILABLE accounts in inventory
  - **Fix:** Add more accounts to ACCOUNT_INVENTORY topic
- **Cause 2:** User hasn't provided email yet
  - **Fix:** User must click "Register" again and provide email

### Payment QR Not Showing to User

- **Cause:** No PAYMENT_QR configured for that game
- **Fix:** Go to PAYMENT_CONFIG topic, upload QR with `PAYMENT_QR | game=X | method=MethodName` (include `tag=...` to show a small instruction under the QR)

### Approval Messages Not Appearing

- **Check:** User's payment screenshot was received?
- **Check:** LOAD_APPROVALS topic exists and is accessible?
- **Fix:** Verify bot is admin in supergroup

### Promotion Not Sent to Users

- **Check:** Were users blocked?
- **Check:** PROMOTIONS topic logs for delivery count
- **Note:** Blocked users won't receive; this is logged

---

## ✅ Best Practices

### Regular Maintenance
- ✅ Check LOAD_APPROVALS & WITHDRAW_APPROVALS daily for pending requests
- ✅ Approve/reject requests within 1-2 hours (keep users happy)
- ✅ Monitor ACCOUNT_INVENTORY inventory levels
- ✅ Review TRANSACTION_LOGS weekly for suspicious activity

### Game Management
- ✅ Always set PAYMENT_QR BEFORE making game ACTIVE
- ✅ Use clear, user-friendly game names
- ✅ Archive old games (don't delete for audit trail)

### Account Inventory
- ✅ Add accounts in batches (e.g., 10 at a time)
- ✅ Keep extra buffer (don't let inventory hit zero)
- ✅ Use strong passwords (or at least meaningful ones)

### Admin Communication
- ✅ Always give clear rejection reasons (helps users understand)
- ✅ Use promotions sparingly (avoid spam)
- ✅ Keep logs clean (no test messages in topics)

### Security
- ✅ Only admins can see approval topics (restrict supergroup access)
- ✅ Never share payment QR outside supergroup
- ✅ Review email logs occasionally (unusual addresses?)

---

## 📚 Glossary

| Term | Definition |
|------|-----------|
| **Forum Topic** | A thread-like feature in Telegram supergroups. Each topic is isolated (like a "table" in database). We use 10 topics for different data types. |
| **FIFO** | First In, First Out. Accounts are assigned in the order they were added. |
| **Canonical Message** | A bot-sent message that serves as the source of truth. Always editable, never deleted. |
| **Snapshot** | Complete state backup (all games, accounts, users, payments). Saved every 15 minutes. |
| **Single-Message Flow** | Load & Cashout flows that edit ONE message multiple times instead of sending new messages. |
| **Polling** | Bot periodically checks for new messages (every 300ms) instead of waiting for webhooks. |
| **User ID** | Unique numeric identifier for each Telegram user. Used to identify who approved what. |
| **Request ID** | Unique identifier for each load/cashout request (starts with L or C). Used for tracking. |
| **Admin Verification** | System checks if user is admin via getChatMember. Must be administrator or creator in supergroup. |
| **Inline Keyboard** | Button menu shown below a message. Only UI element type allowed (no reply keyboards). |

---

## 📞 Support & Escalation

For technical issues or questions:
1. Check TRANSACTION_LOGS for error patterns
2. Review server console logs for error messages
3. Contact the development team with:
   - Error message (if any)
   - Steps to reproduce
   - Screenshot of the issue
   - Timestamp (from logs)

---

**Document Prepared:** January 31, 2026  
**Status:** Production Ready  
**Next Review:** February 28, 2026
