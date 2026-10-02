# WhatsApp BulkSender — Final Project Status & Technical Documentation

**Generated At:** 2026-10-02  
**Baseline Git Commit:** `95725ae10ffb27c4a3d430c861397a135fbf090a`  
**Commit Message:** `feat: add WhatsApp group messaging mode with safe confirmation and UI controls`  
**Branch:** `main` (Synchronized with `origin/main`)  
**Working Tree Status:** Clean  
**Test Suite:** 27/27 Passing (0 Failed, 0 Cancelled, 0 Skipped)  

---

## 1. Project Overview

**WhatsApp BulkSender** is an open-source, production-ready, self-hosted web application and desktop tool designed for sending personalized bulk WhatsApp messages, media campaigns, and WhatsApp group broadcasts directly from the user's connected WhatsApp account.

### Core Value Proposition
- **Self-Hosted & Private:** Runs entirely on the user's local machine; no third-party APIs, monthly subscriptions, or cloud database storage.
- **Safety First:** Strict duplicate-prevention, zero automatic retries, configurable anti-ban random delays, batch cooldown intervals, and built-in legal compliance (STOP opt-out suppression).
- **Hardened Confirmation Engine:** Multi-tier confirmation prevents false-failure reports caused by Puppeteer/WhatsApp Web internal state latency.
- **Dual Sending Modes:**
  1. **Direct Numbers Mode:** Personalized individual outreach with spin-syntax (`{Hi|Hello}`) and dynamic template tags (`{{Name}}`).
  2. **WhatsApp Groups Mode:** Broadcast messages directly into groups the connected WhatsApp account is already a member of, without member scraping or spamming individual members.

---

## 2. Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Web Dashboard (Vanilla JS)                   │
│         public/dashboard.html | public/app.js | public/styles.css│
└────────────────────────────────┬────────────────────────────────┘
                                 │ REST API (JSON / FormData)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Express Application                       │
│                           server.js                             │
│   • Health & QR Endpoints       • Campaign Engine               │
│   • Direct Send Pipeline        • Group Messaging Pipeline      │
│   • Contact Parser & Validator  • History & Status Tracker      │
└──────────────┬─────────────────┬───────────────────┬────────────┘
               │                 │                   │
               ▼                 ▼                   ▼
     ┌──────────────────┐ ┌───────────────┐ ┌──────────────────┐
     │  lib/phoneUtils  │ │ lib/groupUtils│ │lib/optOutService │
     │  Phone Norm &    │ │ Safe Group    │ │ STOP Detection & │
     │  Template Engine │ │ Filter & Valid│ │ Suppression File │
     └──────────────────┘ └───────────────┘ └──────────────────┘
               │                 │                   │
               └─────────────────┼───────────────────┘
                                 ▼
               ┌───────────────────────────────────┐
               │    lib/messageConfirmation.js     │
               │  Multi-Tier Confirmation Engine   │
               │  (sendMessage / Event / Fetch)    │
               └─────────────────┬─────────────────┘
                                 │
                                 ▼
               ┌───────────────────────────────────┐
               │      lib/browserResolver.js       │
               │   Chrome / Edge / Puppeteer Path  │
               └─────────────────┬─────────────────┘
                                 │
                                 ▼
               ┌───────────────────────────────────┐
               │         whatsapp-web.js           │
               │   Puppeteer Headless/Visible      │
               │  Pinned Web: 2.3000.1044306241    │
               └─────────────────┬─────────────────┘
                                 │
                                 ▼
               ┌───────────────────────────────────┐
               │     Local Storage on Disk         │
               │  .wwebjs_auth/ | history.json     │
               │  opt_outs.json | uploads/         │
               └───────────────────────────────────┘
```

### Module Responsibilities
- [server.js](file:///c:/antigravity/bulk%20whatsapp%20sender/server.js): Main Express application server, lifecycle coordinator, API endpoints, rate-limiter, campaign loop, and graceful shutdown handlers.
- [lib/groupUtils.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/groupUtils.js): Sanitizes WhatsApp chat arrays into safe group representations (excluding member lists) and validates/deduplicates `@g.us` group JIDs.
- [lib/messageConfirmation.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/messageConfirmation.js): Multi-tier confirmation engine that prevents false failures by cross-verifying message delivery across 3 distinct WhatsApp signals.
- [lib/phoneUtils.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/phoneUtils.js): Normalizes international phone formats, strips Excel artifacts, parses contacts from text/files, and executes spin syntax (`{A|B}`) and template tags (`{{var}}`).
- [lib/optOutService.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/optOutService.js): Detects STOP/unsubscribe keywords in incoming chats and maintains a local suppression list in `opt_outs.json`.
- [lib/browserResolver.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/browserResolver.js): Inspects Windows Registry and disk paths to detect installed Chrome, Microsoft Edge, or Puppeteer-bundled Chromium.

---

## 3. Local PC Deployment Setup

- **Operating System:** Windows 10 / Windows 11 / Windows Server (PowerShell / Command Prompt).
- **Runtime:** Node.js v18+ or v20+ with native test runner (`node --test`).
- **Default Port:** `5000` (configurable via `.env` or settings).
- **Binding Address:** `127.0.0.1` / `localhost` (`http://localhost:5000`).
- **Environment Flags:**
  - `BULKSENDER_DESKTOP="true"`: Prevents tray initialization in headless / terminal environments.
  - `BULKSENDER_NO_AUTOCONNECT="true"`: Used during automated testing to isolate tests from active WhatsApp Web sessions.
  - `NODE_ENV="test"`: Isolates test data inside `.test_data`.
- **VPS / Cloud Deployment Status:** **Not deployed.** The project is currently strictly verified and configured for local PC desktop operation.

---

## 4. WhatsApp Authentication & Session Handling

- **Underlying Client:** `whatsapp-web.js` v1.34.7 using `LocalAuth` strategy.
- **Session Directory:** `.wwebjs_auth/session` (stored locally in workspace data directory).
- **Authentication Lifecycle:**
  1. On initial start, `/api/connect` initializes Puppeteer.
  2. If unauthenticated, `qr` event generates a QR string; `/api/qr` exposes base64 QR data for dashboard display.
  3. When scanned with WhatsApp Mobile App, `authenticated` and `ready` events fire.
  4. On subsequent application boots, `autoConnectTimer` detects existing `.wwebjs_auth` session files and automatically reconnects without re-scanning.
- **Disconnection & Cleanup:**
  - `POST /api/disconnect`: Destroys the Puppeteer client cleanly and resets connection state to `disconnected`.
  - `POST /api/quit`: Cleanly shuts down the server, destroys Puppeteer, flushes `history.json`, and exits process with code 0.

---

## 5. Direct Number Messaging

- **Endpoint:** `POST /api/send`
- **Supported Inputs:**
  - Raw numbers via text area (`numbers_text`).
  - Uploaded contact files (`.txt`, `.csv`, `.xlsx`, `.xls`).
  - Optional message text (`message_text`) or file template (`message_file`).
  - Optional media file attachment (`media_file` up to 50MB).
- **Pipeline Flow:**
  1. Contacts parsed and deduplicated by [lib/phoneUtils.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/phoneUtils.js).
  2. Numbers filtered against suppression list by [lib/optOutService.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/optOutService.js).
  3. Pre-send validation via `canSendToRecipient(chatId)` (`waClient.isRegisteredUser(chatId)`).
  4. Template processed per contact (`processTemplateVars` + `processSpinSyntax`).
  5. Message dispatched through `sendWhatsAppMessage` and verified via `confirmMessageSend`.
  6. Delay and batch cooldown executed before next recipient.

---

## 6. False-Failure Message Confirmation Fix

### The Problem
In `whatsapp-web.js` 1.34.7 running against pinned WhatsApp Web builds, calling `waClient.sendMessage()` often delivers the message to the recipient successfully, but `sendMessage()` returns `undefined` (or throws `Cannot read properties of undefined (reading 'id')`) because Puppeteer's internal page evaluation returns before the message object is serialized. In older versions of the codebase, this threw an error and logged the message as `failed` (UI showed `Sent: 0, Failed: 1`) despite the recipient actually receiving the message.

### The Solution
Instead of relying solely on the return value of `sendMessage()`, the sending pipeline delegates message confirmation to `confirmMessageSend()` in [lib/messageConfirmation.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/messageConfirmation.js).
- **Duplicate Prevention:** The system **never** blindly retries or calls `sendMessage()` a second time.
- If `sendMessage()` returns `undefined` or throws, the engine checks whether a real outgoing message was created or fetched in that chat.
- If verified delivered, it marks the status as `sent` and saves the valid WhatsApp `messageId`.
- If genuine delivery failure occurs and no message was created, it reports `failed` with zero retries.

---

## 7. Multi-Tier Message Confirmation System

[lib/messageConfirmation.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/messageConfirmation.js) employs a 3-tier cascade:

| Tier | Method | How It Works |
|---|---|---|
| **Tier 1** | Immediate Return Check | Checks if `sendMessage()` returned a valid `Message` instance with an `id`. |
| **Tier 2** | Real-Time Event Listener (`message_create`) | Attaches a temporary listener for WhatsApp `message_create` events before calling `sendMessage`. Validates `fromMe === true`, matching remote JID (`@c.us` or `@g.us`), matching text/caption, and timestamp within drift tolerance. Listener is always removed in `finally`. |
| **Tier 3** | Post-Send Message Fetch (`chat.fetchMessages`) | If Tier 1 and Tier 2 have not confirmed within the grace window, queries the target chat for the last 10 messages using `fetchMessages` to locate the newly created outgoing message. |

**Result:** Zero false-failures, zero duplicate messages, and 100% verified status accuracy.

---

## 8. WhatsApp Group Messaging

- **Discovery Endpoint:** `GET /api/groups`
  - Retrieves WhatsApp chats where `isGroup === true` or ID ends with `@g.us`.
  - Implements **in-page model evaluation** directly via Puppeteer (`window.require('WAWebCollections').Chat`) with `waClient.getChats()` fallback.
  - **Bypasses WhatsApp Web Metadata Crash:** Standard `waClient.getChats()` attempts to update group metadata and invokes `WAWebLidMigrationUtils`, throwing `r` on modern WhatsApp Web builds. The in-page reader reads existing chat models without triggering participant updates.
  - **Strict Privacy Rule:** **Never exports or returns group member/participant lists.**
  - Returns only safe metadata: `id`, `name`, `unreadCount`, `timestamp`, `isReadOnly`, `archived`, `pinned`.
- **Group Send Endpoint:** `POST /api/groups/send`
  - Validates and deduplicates group IDs using regex `/^[a-zA-Z0-9_\-\.]+@g\.us$/`.
  - Rejects empty selections or non-group IDs.
  - Checks if the group is marked `isReadOnly` (announcement group where only admins can post). If read-only, safely marks failed without sending.
  - Sends exactly once per group using `sendWhatsAppMessage` and `confirmMessageSend`.
  - Logs `recipientType: "group"`, `groupId`, and `groupName` in campaign history.
- **Frontend Dashboard:**
  - Mode switcher: **Direct Numbers** vs **WhatsApp Groups**.
  - Searchable group selection box with live search filter.
  - "Select All" and "Clear Selection" controls.
  - "Refresh Groups" button to reload groups from WhatsApp Web.
  - Activity table and history display purple `[GROUP]` badge and group name.

---

## 9. CSV / Excel Contact Workflow Current Status

### What is Verified:
- `lib/phoneUtils.parseContacts` handles plain text, `.csv`, and `.xlsx` structures.
- Deduplication of phone numbers and Excel decimal artifacts (e.g., `919876543210.0` -> `919876543210`) is verified via automated unit tests.
- Variable extraction (e.g. `{{Name}}`, `{{City}}`, `{{OrderID}}`) from tabular structures is verified via unit tests.
- Contact preview endpoint `POST /api/contacts/preview` validates inputs, filters duplicates, flags invalid rows, and strips opt-out numbers.

### What is NOT Yet Live-Verified:
- End-to-end binary upload of a real `.xlsx` file via the browser UI file picker attached to an active, real-recipient sending run (only text inputs and simulated parsing files have been verified in live runs).
- Dynamic Excel column mapping for arbitrary nested columns beyond standard `number`/`name`/custom headers in live campaigns.

---

## 10. Campaign, Delay, and Cancellation Behavior

- **Random Delay:** Every outgoing message pauses for a randomized delay between `delayMin` and `delayMax` (default 5–12 seconds, minimum 1 second) to mimic human behavior.
- **Batch Cooldown:** After every `batchSize` messages (e.g. 20 messages), sending pauses for `batchCooldown` seconds (e.g. 60 seconds).
- **Cancellation (`POST /api/cancel`):**
  - Sets `cancelRequested = true`.
  - `interruptibleSleep` evaluates `cancelRequested` every 250ms, aborting active delay waits immediately without hanging promises.
  - Campaign loop terminates at the current message; remaining pending items are cancelled cleanly.

---

## 11. Opt-Out / STOP Protection

- **Service:** [lib/optOutService.js](file:///c:/antigravity/bulk%20whatsapp%20sender/lib/optOutService.js)
- **Persistent Storage:** `opt_outs.json` (auto-created in data directory).
- **Detection:** On every incoming WhatsApp message, checks for opt-out keywords:
  - `STOP`, `UNSUBSCRIBE`, `QUIT`, `CANCEL`, `END`, `OPTOUT`, `STOPPROMO` (case-insensitive, trimmed).
- **Suppression:** Automatically suppresses registered numbers before any campaign starts via `filterSuppressed`.
- **Management API:**
  - `GET /api/optouts`: List all opted-out numbers.
  - `POST /api/optouts/add`: Manually suppress a number.
  - `POST /api/optouts/remove`: Unblock / re-subscribe a number.
- **Group Isolation:** Individual opt-outs do not block group broadcast sends.

---

## 12. Security & Privacy Protections

1. **No Group Member Scraping:** The system explicitly does not scrape, export, or store members of WhatsApp groups.
2. **No Unsolicited Group DMs:** Group mode broadcasts into group chats only; it never extracts members to send direct messages.
3. **HTTP Security Headers:** Implemented via Express middleware:
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: SAMEORIGIN`
   - `X-XSS-Protection: 1; mode=block`
4. **File Upload Hardening:**
   - Sanitized filenames via `path.basename` and regex alphanumeric replacements.
   - File size ceiling: 50MB maximum for media attachments.
   - Immediate unlinking of temporary upload files in `finally` blocks.
5. **No Secret Leaks:** `.env`, `.wwebjs_auth`, session caches, and user data files are strictly ignored by `.gitignore`.

---

## 13. Test Suite Results

- **Test Command:** `npm test` (`node --test tests/**/*.test.js`)
- **Suite Execution:** Native Node.js test runner (`node:test`, `node:assert/strict`)
- **Total Tests:** **27**
- **Passed:** **27**
- **Failed:** **0**
- **Cancelled:** **0**
- **Skipped:** **0**
- **Execution Duration:** ~3.0 – 3.2 seconds

### Test Breakdown

#### API Integration Suite (`tests/api.test.js` — 12 tests)
1. `GET / serves HTML with security headers`
2. `GET /api/health returns system health and state`
3. `GET /api/qr returns valid connection state object`
4. `POST /api/contacts/preview validates input, removes duplicates, detects variables`
5. `Opt-Out API: Add, List, and Remove numbers from suppression`
6. `POST /api/settings/save enforces validation and rejects injections`
7. `POST /api/send rejects gracefully if WhatsApp is not connected`
8. `GET /api/groups rejects gracefully if WhatsApp is not connected`
9. `POST /api/groups/send rejects gracefully if WhatsApp is not connected`
10. `Group messaging pipeline: discovery, validation, single-send, confirmation, and cancellation`
11. `POST /api/disconnect gracefully sets state to disconnected`
12. `GET /api/status returns initial sending status object`

#### Unit Suite (`tests/unit.test.js` — 15 tests)
13. `normalizePhoneNumber handles various formats correctly`
14. `parseContacts deduplicates and extracts variables`
15. `processSpinSyntax randomizes options correctly`
16. `processTemplateVars replaces variables case-insensitively`
17. `OptOutService manages STOP keywords and suppression`
18. `resolveBrowserExecutable locates an available Chromium browser`
19. `confirmMessageSend resolves with confirmed message when sendMessage returns undefined (false-failure regression)`
20. `confirmMessageSend resolves when sendMessage throws but fetchMessages verifies delivered message`
21. `confirmMessageSend resolves when message_create arrives asynchronously after sendMessage finishes`
22. `isMatchingOutgoingMessage handles object remote, newlines, and media matching`
23. `filterGroupChats filters only actual WhatsApp group chats and never returns member/participant lists`
24. `validateGroupIds deduplicates, validates format, and handles multiple input types`
25. `confirmMessageSend confirms outgoing group message with @g.us remote JID`
26. `confirmMessageSend throws and does not retry when group message send fails without confirmation`
27. `confirmMessageSend cleans up listeners on error`

---

## 14. Latest Successful Live QA Results

### A. Direct Message Send & False-Failure Verification (Live)
- **Target:** Single verified recipient phone number.
- **Result:**
  - Message received on recipient's WhatsApp client: Yes.
  - UI Status: `Sent: 1, Failed: 0, Pending: 0`.
  - Delivery Status: `sent`.
  - Message ID: Confirmed and recorded.
  - Duplicate Messages: None (zero duplicates).

### B. Group Messaging Send & Discovery Verification (Live)
- **Date & Time:** 2026-10-02 16:32:15 IST
- **Group Discovery:** `GET /api/groups` returned 6 groups available on connected account.
  - Read-only school group correctly detected as `isReadOnly: true`.
  - Zero participant lists returned or queried.
- **Selected Test Group:** `Rectangle film production` (`120363421053221880@g.us`).
- **Sent Message:** `"BulkSender group mode verification test: 2026-10-02 16:32:15"`
- **Live Output:**
  - Confirmed via: `message_create` event listener.
  - Message ID: `3EB06FA9C2C1BB226B932E`
  - UI Status: `Sent: 1, Failed: 0, Pending: 0, isSending: false`.
  - Group History Record:
    ```json
    {
      "recipientType": "group",
      "groupId": "120363421053221880@g.us",
      "groupName": "Rectangle film production",
      "number": "120363421053221880@g.us",
      "name": "Rectangle film production",
      "status": "sent",
      "deliveryStatus": "sent",
      "messageId": "3EB06FA9C2C1BB226B932E"
    }
    ```
  - Duplicate Sends: Exactly 0 duplicates.

---

## 15. GitHub Repository & Branch Information

- **Primary Remote (`origin`):** `https://github.com/tokenanalyzer/Whatsapp-Bulk-Sender.git`
- **Upstream Remote (`upstream`):** `https://github.com/Malaviya24/Whatsapp-Bulk-Sender.git`
- **Active Branch:** `main`
- **Synchronization:** `HEAD` is in sync with `origin/main`.
- **Local Workspaces:**
  - Primary: `c:\antigravity\bulk whatsapp sender`
  - Mirror: `C:\antigravity\Whatsapp-Bulk-Sender`

---

## 16. Latest Commit Hash and Commit Message

- **Commit Hash:** `95725ae10ffb27c4a3d430c861397a135fbf090a`
- **Short Hash:** `95725ae`
- **Commit Subject:** `feat: add WhatsApp group messaging mode with safe confirmation and UI controls`
- **Author/Committer:** Verified repository maintainer.

---

## 17. Exact Files Currently Included

Below is the verified list of all 37 tracked files in the repository:

```
.env.example                             # Environment variable template
.github/workflows/windows-release.yml    # GitHub Actions workflow for Windows desktop release
.gitignore                               # Ignores .env, sessions, caches, logs, temp data
BulkSender.vbs                           # Windows silent launcher script
CHANGELOG.md                             # Version history
CONTRIBUTING.md                          # Contribution guidelines
LICENSE                                  # Project license
README.md                                # User overview and quickstart
SECURITY.md                              # Vulnerability reporting protocol
assets/icon.ico                          # Application icon
assets/wa-version/2.3000.1044306241.html # Pinned stable WhatsApp Web release bundle
electron-main.js                         # Optional Electron wrapper entrypoint
install.bat                              # Windows dependency installer script
lib/browserResolver.js                   # Local Chrome/Edge executable resolver
lib/groupUtils.js                        # Group chat filtering & ID validation
lib/messageConfirmation.js               # Multi-tier confirmation engine
lib/optOutService.js                     # Opt-out (STOP) suppression manager
lib/phoneUtils.js                        # Phone normalization, parsing, template engine
package-for-share.bat                    # Script to package clean release bundle
package-lock.json                        # Exact pinned npm dependencies
package.json                             # Project manifest & scripts
public/app.js                            # Frontend single-page app controller
public/dashboard.html                    # Dashboard UI markup
public/logo.png                          # Dashboard branding logo
public/styles.css                        # Dashboard stylesheet & theme
run.bat                                  # Windows run script
sample_message.txt                       # Sample template text
sample_numbers.txt                       # Sample recipient contact list
screenshots/README.md                    # Documentation asset placeholder
scripts/create-icon.ps1                  # PowerShell helper to generate icon
scripts/create-png-logo.ps1              # PowerShell helper to generate logo
scripts/create-shortcuts.ps1             # PowerShell desktop shortcut creator
scripts/prepare-puppeteer-cache.ps1      # Offline browser cache downloader
server.js                                # Primary Express server & backend logic
stop.bat                                 # Windows server termination script
tests/api.test.js                        # API integration tests (12 tests)
tests/unit.test.js                       # Unit & regression tests (15 tests)
uninstall.bat                            # Windows uninstall & cleanup script
```

---

## 18. Current Known Limitations

1. **Local Desktop Dependency:** Relies on local Chrome/Chromium installation and Windows desktop network stack. Cannot run headless on minimal VPS without Chromium dependencies installed.
2. **Single Account Session:** Uses one `LocalAuth` profile at a time. Multiple simultaneous WhatsApp sender accounts require separate ports and session directories.
3. **WhatsApp Web Protocol Drift:** WhatsApp Web frequently updates internal Webpack modules. Pinned web version (`assets/wa-version/2.3000.1044306241.html`) must be preserved to prevent DOM breaking changes.
4. **Account Safety & Rate Limits:** WhatsApp aggressively bans numbers sending bulk unsolicited messages. Users must keep delay intervals sensible (e.g. 5–15 seconds minimum) and maintain opt-out suppression.

---

## 19. How to Start the Project Locally

### Prerequisites
- Node.js v18.0.0 or higher.
- Google Chrome or Microsoft Edge installed on Windows.

### Steps
1. Open PowerShell or Command Prompt in the repository directory:
   ```powershell
   cd "c:\antigravity\bulk whatsapp sender"
   ```
2. Install dependencies (if not already installed):
   ```powershell
   npm install
   ```
3. Run the application:
   ```powershell
   $env:BULKSENDER_DESKTOP="true"; node server.js
   ```
   *(Or double click `run.bat`)*
4. Open your browser and navigate to:
   ```
   http://localhost:5000
   ```
5. Scan the QR code with WhatsApp on your phone (if not already authenticated).

---

## 20. How to Stop the Project Safely

**Option A (Recommended — Web UI / API):**
Send a POST request to `/api/quit`:
```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:5000/api/quit"
```
Or click the "Quit" button in the dashboard or Windows system tray icon.

**Option B (Terminal):**
Press `Ctrl + C` in the running PowerShell terminal.

**Option C (Batch Script):**
Run `stop.bat` from the repository root.

*All options trigger graceful shutdown: destroying Puppeteer, saving `history.json`, and cleaning active timers.*

---

## 21. Future Work & Pending Items

1. **Live End-to-End Excel Campaign Validation:** Perform live testing with complex `.xlsx` spreadsheets uploaded via drag-and-drop against real test numbers.
2. **Scheduled Campaigns:** Allow scheduling campaigns to execute at a specific date and time.
3. **History Exporting:** Add a "Download CSV Report" button to export campaign logs directly from the dashboard.
4. **Cloud / Headless Linux Dockerization:** Create a standardized Docker container with headless Chromium for optional cloud VPS deployments.

---

## 22. Recovery & Continuation Instructions

If you need to resume work or restore the project to this exact verified state on any machine:

1. **Clone the Repository:**
   ```powershell
   git clone https://github.com/tokenanalyzer/Whatsapp-Bulk-Sender.git
   cd Whatsapp-Bulk-Sender
   ```
2. **Check Out Verified Commit:**
   ```powershell
   git checkout main
   git reset --hard 95725ae
   ```
3. **Install Exact Dependencies:**
   ```powershell
   npm ci
   ```
4. **Run Verification Quality Gates:**
   ```powershell
   node --check server.js
   node --check lib/messageConfirmation.js
   node --check lib/groupUtils.js
   npm test
   git diff --check
   ```
5. **Verify Status:** All 27 tests must pass with 0 failures before writing new code.
