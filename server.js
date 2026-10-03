// WhatsApp Bulk Sender - Node.js Backend
// Uses whatsapp-web.js for reliable messaging with hardened lifecycle, security, and compliance

require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const xlsx = require('xlsx');
const { exec } = require('child_process');

const { resolveBrowserExecutable } = require('./lib/browserResolver');
const { parseContacts, processSpinSyntax, processTemplateVars } = require('./lib/phoneUtils');
const OptOutService = require('./lib/optOutService');
const {
    isMatchingOutgoingMessage,
    verifyMessageDelivered,
    verifyViaFetchMessages,
    confirmMessageSend,
    ensurePageChatSafe,
} = require('./lib/messageConfirmation');
const { filterGroupChats, validateGroupIds } = require('./lib/groupUtils');

const app = express();
const APP_ROOT = __dirname;
const DATA_DIR = process.env.BULKSENDER_DATA_DIR || APP_ROOT;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const ASSETS_DIR = path.join(APP_ROOT, 'assets');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dataEnvPath = path.join(DATA_DIR, '.env');
if (fs.existsSync(dataEnvPath)) {
    require('dotenv').config({ path: dataEnvPath, override: true });
}

const PORT = parseInt(process.env.PORT, 10) || 5000;
const optOutService = new OptOutService(DATA_DIR);

// Clean temporary uploads on startup (files older than 1 hour)
function cleanOldUploads() {
    try {
        if (!fs.existsSync(UPLOAD_DIR)) return;
        const files = fs.readdirSync(UPLOAD_DIR);
        const now = Date.now();
        for (const f of files) {
            const p = path.join(UPLOAD_DIR, f);
            try {
                const stat = fs.statSync(p);
                if (now - stat.mtimeMs > 3600000) {
                    fs.unlinkSync(p);
                }
            } catch (e) {}
        }
    } catch (e) {}
}

// Security Headers & Request Limits
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(fileUpload({
    createParentPath: true,
    useTempFiles: false,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max file size
    abortOnLimit: true,
    responseOnLimit: 'File size exceeds maximum allowed limit (50MB).',
}));
app.use(express.static(PUBLIC_DIR));

// Folders
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SESSION_DIR = path.join(DATA_DIR, '.wwebjs_auth');
const CACHE_DIR = path.join(DATA_DIR, '.wwebjs_cache');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
cleanOldUploads();

// ─── WhatsApp Web version pinning ───
const PINNED_WEB_VERSION =
    process.env.WA_PIN_VERSION === '0' ? null : '2.3000.1044306241';
const BUNDLED_VERSION_DIR = path.join(APP_ROOT, 'assets', 'wa-version');

function ensurePinnedWebVersion() {
    try {
        const dest = path.join(CACHE_DIR, `${PINNED_WEB_VERSION}.html`);
        if (fs.existsSync(dest)) return true;
        const src = path.join(BUNDLED_VERSION_DIR, `${PINNED_WEB_VERSION}.html`);
        if (!fs.existsSync(src)) {
            console.warn('[WA] Bundled WhatsApp Web version missing:', src);
            return false;
        }
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(dest, fs.readFileSync(src));
        console.log(`[WA] Seeded pinned WhatsApp Web version ${PINNED_WEB_VERSION}.`);
        return true;
    } catch (e) {
        console.warn('[WA] Could not seed pinned web version:', e.message);
        return false;
    }
}

// ─── Connection Lifecycle State Machine ───
// 8 distinct states:
// 'disconnected', 'connecting', 'waiting_for_qr', 'qr_available',
// 'authenticated', 'connected', 'reconnecting', 'auth_failure'
let waClient = null;
let qrCodeData = null;
let waReady = false;
let waState = 'disconnected';
let lastError = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let isInitializing = false;
let intentionalDisconnect = false;
let reconnectTimer = null;
let autoConnectTimer = null;

let messageLogs = [];
let sendingStatus = {
    isSending: false,
    total: 0,
    sent: 0,
    failed: 0,
    pending: 0,
};
let allHistory = [];
let cancelRequested = false;

// Load history
function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            allHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        } catch (e) {
            allHistory = [];
        }
    }
}
function saveHistory() {
    try {
        const tempFile = `${HISTORY_FILE}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(allHistory, null, 2), 'utf-8');
        fs.renameSync(tempFile, HISTORY_FILE);
    } catch (e) {
        console.error('[History] Save error:', e.message);
    }
}
loadHistory();

let historySaveTimer = null;
function scheduleHistorySave() {
    if (historySaveTimer) return;
    historySaveTimer = setTimeout(() => {
        historySaveTimer = null;
        saveHistory();
    }, 2000);
}

// ─── WhatsApp Client Management ───
async function destroyWhatsAppClient() {
    if (autoConnectTimer) {
        clearTimeout(autoConnectTimer);
        autoConnectTimer = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (waClient) {
        try {
            waClient.removeAllListeners();
            await waClient.destroy();
        } catch (e) {
            console.log('[WA] Teardown warning:', e.message);
        }
        waClient = null;
    }
    isInitializing = false;
    waReady = false;
    qrCodeData = null;
}

async function initWhatsApp(isReconnect = false) {
    if (isInitializing) {
        console.log('[WA] Initialization already in progress, skipping duplicate call.');
        return;
    }

    isInitializing = true;
    intentionalDisconnect = false;

    if (!isReconnect) {
        reconnectAttempts = 0;
        waState = 'connecting';
        lastError = null;
    }

    try {
        await destroyWhatsAppClient();

        const resolvedBrowser = resolveBrowserExecutable(APP_ROOT);
        const chromePath = resolvedBrowser ? resolvedBrowser.path : null;

        console.log(`[WA] Initializing WhatsApp client. Browser: ${chromePath || 'puppeteer bundled'} (${resolvedBrowser ? resolvedBrowser.source : 'default'})`);

        const puppeteerOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--no-first-run',
                '--disable-notifications',
                '--mute-audio',
            ],
        };

        if (chromePath) {
            puppeteerOptions.executablePath = chromePath;
        }

        const pinnedOk = PINNED_WEB_VERSION && ensurePinnedWebVersion();
        const clientOptions = {
            authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
            puppeteer: puppeteerOptions,
            qrMaxRetries: 10,
        };

        if (pinnedOk) {
            clientOptions.webVersion = PINNED_WEB_VERSION;
            clientOptions.webVersionCache = { type: 'local', path: CACHE_DIR, strict: true };
        } else {
            clientOptions.webVersionCache = { type: 'local', path: CACHE_DIR };
        }

        waClient = new Client(clientOptions);

        // Client Events
        waClient.on('qr', async (qr) => {
            try {
                qrCodeData = await qrcode.toDataURL(qr);
                waState = 'qr_available';
                lastError = null;
                reconnectAttempts = 0;
                console.log('[WA] QR Code ready for scanning.');
            } catch (e) {
                console.error('[WA] QR generation failed:', e);
                lastError = 'Failed to generate QR data: ' + e.message;
            }
        });

        waClient.on('authenticated', () => {
            console.log('[WA] Authenticated successfully!');
            waState = 'authenticated';
            qrCodeData = null;
            lastError = null;
        });

        waClient.on('auth_failure', (msg) => {
            console.error('[WA] Authentication failure:', msg);
            waState = 'auth_failure';
            waReady = false;
            qrCodeData = null;
            lastError = typeof msg === 'string' ? msg : 'WhatsApp session authentication failed. Please scan QR code again.';
        });

        waClient.on('ready', async () => {
            console.log('[WA] Client is ready to send messages!');
            waReady = true;
            waState = 'connected';
            qrCodeData = null;
            lastError = null;
            reconnectAttempts = 0;
            try {
                await ensurePageChatSafe(waClient);
            } catch (e) {}
        });

        waClient.on('disconnected', (reason) => {
            console.log('[WA] Disconnected. Reason:', reason);
            waReady = false;
            qrCodeData = null;

            if (intentionalDisconnect) {
                waState = 'disconnected';
                lastError = null;
                return;
            }

            if (reason === 'LOGOUT') {
                waState = 'auth_failure';
                lastError = 'Session was logged out from mobile device. Please scan QR code again.';
                return;
            }

            // Automatic reconnection with exponential backoff
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                waState = 'reconnecting';
                const backoffMs = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 15000);
                lastError = `Disconnected (${reason}). Reconnecting attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(backoffMs / 1000)}s...`;
                console.log(`[WA] Scheduling reconnect attempt ${reconnectAttempts} in ${backoffMs}ms`);

                reconnectTimer = setTimeout(() => {
                    initWhatsApp(true).catch(e => {
                        console.error('[WA] Reconnect attempt failed:', e.message);
                    });
                }, backoffMs);
            } else {
                waState = 'disconnected';
                lastError = `Disconnected (${reason}). Maximum reconnect attempts reached. Please connect manually.`;
            }
        });

        // Opt-out / STOP message handler (Compliance & Consent)
        waClient.on('message', async (msg) => {
            try {
                if (!msg || !msg.body) return;
                const body = String(msg.body).trim();
                if (optOutService.isOptOutMessage(body)) {
                    const senderNumber = (msg.from || '').replace(/@.*$/, '').replace(/\D/g, '');
                    if (senderNumber) {
                        optOutService.addOptOut(senderNumber, `User replied "${body}"`);
                        console.log(`[OptOut] Registered STOP request from +${senderNumber}`);
                        try {
                            await msg.reply('You have been unsubscribed and will not receive further promotional messages. Reply START to resubscribe.');
                        } catch (replyErr) {}
                    }
                } else if (body.toLowerCase() === 'start') {
                    const senderNumber = (msg.from || '').replace(/@.*$/, '').replace(/\D/g, '');
                    if (senderNumber && optOutService.isOptedOut(senderNumber)) {
                        optOutService.removeOptOut(senderNumber);
                        console.log(`[OptOut] Number +${senderNumber} opted back in via START.`);
                        try {
                            await msg.reply('You have been resubscribed.');
                        } catch (replyErr) {}
                    }
                }
            } catch (e) {
                console.error('[OptOut] Incoming message processing error:', e.message);
            }
        });

        waClient.on('message_ack', (msg, ack) => {
            const status = ack >= 3 ? 'read' : ack === 2 ? 'delivered' : ack === 1 ? 'sent' : null;
            if (!status) return;
            const id = msg && msg.id ? msg.id._serialized : null;
            if (!id) return;
            let updated = false;

            const idx = messageLogs.findIndex(l => l.messageId === id);
            if (idx !== -1) { messageLogs[idx].deliveryStatus = status; updated = true; }

            const hIdx = allHistory.findIndex(l => l.messageId === id);
            if (hIdx !== -1) { allHistory[hIdx].deliveryStatus = status; updated = true; }

            if (updated) scheduleHistorySave();
        });

        waState = 'connecting';
        await waClient.initialize();
    } catch (err) {
        console.error('[WA] Initialize error:', err.message || err);
        waReady = false;
        waState = 'auth_failure';
        lastError = 'Browser or WhatsApp initialization failed: ' + (err.message || String(err));
        qrCodeData = null;
    } finally {
        isInitializing = false;
    }
}

// Global exception handling: Log without blindly wiping active state
process.on('uncaughtException', (err) => {
    console.error('[!] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[!] Unhandled rejection:', err && err.message ? err.message : err);
});

// Interruptible sleep checking cancellation signal
function interruptibleSleep(ms, checkInterval = 250) {
    return new Promise(resolve => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (cancelRequested || Date.now() - start >= ms) {
                clearInterval(timer);
                resolve();
            }
        }, checkInterval);
    });
}

function isCommsNotReadyError(err) {
    const message = err && err.message ? err.message : String(err || '');
    return /sendIq called before startComms|Comms::sendIq|Cannot read propert(?:y|ies) of undefined \(reading 'id'\)/i.test(message);
}

async function waitForWhatsAppComms(timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (!waClient || !waReady) {
            await interruptibleSleep(500);
            continue;
        }

        try {
            const state = await waClient.getState();
            if (state === 'CONNECTED') {
                await interruptibleSleep(1000);
                return true;
            }
        } catch (e) {
            if (!isCommsNotReadyError(e)) {
                console.log('[WA] State check warning:', e.message || e);
            }
        }

        await interruptibleSleep(500);
    }
    return waReady;
}

function extractMessageId(msg) {
    if (!msg) return null;
    try {
        if (typeof msg === 'string') return msg;
        if (msg.id) {
            if (typeof msg.id === 'string') return msg.id;
            if (typeof msg.id._serialized === 'string') return msg.id._serialized;
            if (typeof msg.id.id === 'string') return msg.id.id;
        }
        if (typeof msg._serialized === 'string') return msg._serialized;
    } catch (e) {}
    return null;
}

async function canSendToRecipient(chatId) {
    try {
        const isRegistered = await waClient.isRegisteredUser(chatId);
        return { ok: isRegistered, error: isRegistered ? '' : 'Number not registered on WhatsApp' };
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (isCommsNotReadyError(err) || msg.includes("it's how we memoize") || msg.includes('include an id property')) {
            console.log(`[WA] Registration check fallback for ${chatId}; trying direct send.`);
            return { ok: true, error: '' };
        }
        throw err;
    }
}

async function sendWhatsAppMessage(chatId, text, media) {
    if (!waClient || !waReady) {
        throw new Error('WhatsApp connection lost. Please reconnect.');
    }

    await ensurePageChatSafe(waClient);

    const sentAtSec = Math.floor(Date.now() / 1000);
    const sendOptions = media
        ? { caption: text, waitUntilMsgSent: true }
        : { waitUntilMsgSent: true };

    const sendMessageFn = () => media
        ? waClient.sendMessage(chatId, media, sendOptions)
        : waClient.sendMessage(chatId, text, sendOptions);

    return confirmMessageSend({
        waClient,
        chatId,
        text,
        media,
        sentAtSec,
        sendMessageFn,
        verifyLastMessageFn: (c, t, m, s) => verifyMessageDelivered(waClient, c, t, m, s, interruptibleSleep),
        verifyFetchMessagesFn: (c, t, m, s) => verifyViaFetchMessages(waClient, c, t, m, s, interruptibleSleep),
    });
}

async function sendBulkMessages(contacts, messageTemplate, mediaPath, options) {
    const { delayMin, delayMax, batchSize, batchCooldown } = options;

    sendingStatus.isSending = true;
    sendingStatus.total = contacts.length;
    sendingStatus.sent = 0;
    sendingStatus.failed = 0;
    sendingStatus.pending = contacts.length;
    cancelRequested = false;

    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    await waitForWhatsAppComms();

    let media = null;
    if (mediaPath && fs.existsSync(mediaPath)) {
        try {
            media = MessageMedia.fromFilePath(mediaPath);
        } catch (e) {
            console.error('[WA] Media load error:', e);
        }
    }

    try {
        for (let i = 0; i < contacts.length; i++) {
            if (cancelRequested) {
                console.log('[WA] Campaign sending cancelled by user');
                break;
            }

            const contact = contacts[i];
            const chatId = contact.chatId || `${contact.number}@c.us`;

            // Personalized template variables + Spin syntax
            const personalized = processTemplateVars(messageTemplate || '', contact.variables || {});
            const processedMsg = processSpinSyntax(personalized);

            const log = {
                number: '+' + contact.number,
                name: contact.name || '',
                message: processedMsg && processedMsg.length > 80 ? processedMsg.slice(0, 80) + '...' : processedMsg,
                fullMessage: processedMsg,
                status: 'sending',
                deliveryStatus: 'pending',
                timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
                batchId,
                error: '',
                hasMedia: !!media,
                messageId: null,
            };

            try {
                const recipient = await canSendToRecipient(chatId);
                if (!recipient.ok) {
                    throw new Error(recipient.error);
                }

                const sentMsg = await sendWhatsAppMessage(chatId, processedMsg, media);

                log.status = 'sent';
                log.deliveryStatus = 'sent';
                log.messageId = extractMessageId(sentMsg);
                sendingStatus.sent++;
            } catch (err) {
                log.status = 'failed';
                log.error = (err.message || String(err)).slice(0, 150);
                sendingStatus.failed++;
            }

            sendingStatus.pending--;
            messageLogs.push(log);
            allHistory.push(log);

            // Delay between messages
            if (i < contacts.length - 1 && !cancelRequested) {
                const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
                await interruptibleSleep(delay * 1000);

                // Batch cooldown
                if (batchSize && (i + 1) % batchSize === 0 && !cancelRequested) {
                    console.log(`[WA] Batch cooldown: ${batchCooldown}s`);
                    await interruptibleSleep(batchCooldown * 1000);
                }
            }
        }
    } finally {
        sendingStatus.isSending = false;
        saveHistory();

        if (mediaPath && fs.existsSync(mediaPath)) {
            try { fs.unlinkSync(mediaPath); } catch (e) {}
        }
    }
}

// ─── Group Messaging Helpers & Engine ───

async function sendBulkGroupMessages(groups, messageTemplate, mediaPath, options) {
    const { delayMin, delayMax, batchSize, batchCooldown } = options;

    sendingStatus.isSending = true;
    sendingStatus.total = groups.length;
    sendingStatus.sent = 0;
    sendingStatus.failed = 0;
    sendingStatus.pending = groups.length;
    cancelRequested = false;

    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    await waitForWhatsAppComms();

    let media = null;
    if (mediaPath && fs.existsSync(mediaPath)) {
        try {
            media = MessageMedia.fromFilePath(mediaPath);
        } catch (e) {
            console.error('[WA] Media load error for group campaign:', e);
        }
    }

    try {
        for (let i = 0; i < groups.length; i++) {
            if (cancelRequested) {
                console.log('[WA] Group campaign sending cancelled by user');
                break;
            }

            const group = groups[i];
            const processedMsg = processSpinSyntax(messageTemplate || '');

            let resolvedGroupName = group.name || group.id;

            const log = {
                recipientType: 'group',
                groupId: group.id,
                groupName: resolvedGroupName,
                number: group.id,
                name: resolvedGroupName,
                message: processedMsg && processedMsg.length > 80 ? processedMsg.slice(0, 80) + '...' : processedMsg,
                fullMessage: processedMsg,
                status: 'sending',
                deliveryStatus: 'pending',
                timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
                batchId,
                error: '',
                hasMedia: !!media,
                messageId: null,
            };

            try {
                if (waClient && waClient.pupPage && typeof waClient.pupPage.evaluate === 'function') {
                    try {
                        const chatMeta = await waClient.pupPage.evaluate((targetId) => {
                            try {
                                const wid = typeof window.require === 'function' ? window.require('WAWebWidFactory').createWid(targetId) : null;
                                const chatColl = typeof window.require === 'function' ? window.require('WAWebCollections')?.Chat : (window.Store?.Chat);
                                const chat = wid && chatColl && typeof chatColl.get === 'function' ? chatColl.get(wid) : null;
                                if (!chat) return null;
                                return {
                                    name: chat.name || chat.formattedTitle || targetId,
                                    isReadOnly: Boolean(chat.isReadOnly || (chat.groupMetadata && chat.groupMetadata.announce) || chat.announce),
                                };
                            } catch (e) {
                                return null;
                            }
                        }, group.id);

                        if (chatMeta) {
                            if (chatMeta.name && chatMeta.name !== group.id) {
                                resolvedGroupName = chatMeta.name;
                                log.groupName = chatMeta.name;
                                log.name = chatMeta.name;
                            }
                            if (chatMeta.isReadOnly) {
                                throw new Error('Group is read-only (only admins can send messages)');
                            }
                        }
                    } catch (metaErr) {
                        if (metaErr.message && metaErr.message.includes('read-only')) {
                            throw metaErr;
                        }
                    }
                } else if (waClient && typeof waClient.getChatById === 'function') {
                    try {
                        const chat = await waClient.getChatById(group.id);
                        if (!chat) {
                            throw new Error('Group chat not found on WhatsApp account');
                        }
                        if (chat.name && chat.name !== group.id) {
                            resolvedGroupName = chat.name;
                            log.groupName = chat.name;
                            log.name = chat.name;
                        }
                        if (chat.isReadOnly) {
                            throw new Error('Group is read-only (only admins can send messages)');
                        }
                    } catch (chatErr) {
                        if (!isCommsNotReadyError(chatErr)) {
                            throw chatErr;
                        }
                    }
                }

                const sentMsg = await sendWhatsAppMessage(group.id, processedMsg, media);

                log.status = 'sent';
                log.deliveryStatus = 'sent';
                log.messageId = extractMessageId(sentMsg);
                sendingStatus.sent++;
            } catch (err) {
                log.status = 'failed';
                log.deliveryStatus = 'failed';
                log.error = (err.message || String(err)).slice(0, 150);
                sendingStatus.failed++;
            }

            sendingStatus.pending--;
            messageLogs.push(log);
            allHistory.push(log);

            if (i < groups.length - 1 && !cancelRequested) {
                const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
                await interruptibleSleep(delay * 1000);

                if (batchSize && (i + 1) % batchSize === 0 && !cancelRequested) {
                    console.log(`[WA] Group campaign batch cooldown: ${batchCooldown}s`);
                    await interruptibleSleep(batchCooldown * 1000);
                }
            }
        }
    } finally {
        sendingStatus.isSending = false;
        saveHistory();

        if (mediaPath && fs.existsSync(mediaPath)) {
            try { fs.unlinkSync(mediaPath); } catch (e) {}
        }
    }
}

// ─── API Routes ───
// Health Check Endpoint
app.get(['/health', '/api/health'], (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        version: '2.0.2',
        waState,
        waReady,
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

// Connection state & QR
app.post('/api/connect', async (req, res) => {
    if (waReady) {
        return res.json({ success: true, message: 'Already connected', state: waState, ready: waReady });
    }
    if (waState === 'connecting' || waState === 'waiting_for_qr' || waState === 'qr_available' || waState === 'authenticated') {
        return res.json({ success: true, message: 'Initialization in progress...', state: waState, ready: waReady });
    }
    initWhatsApp().catch(err => console.error('[WA] Start error:', err.message));
    res.json({ success: true, message: 'Initializing WhatsApp...', state: 'connecting', ready: false });
});

app.get('/api/qr', async (req, res) => {
    if (waClient && !waReady && waState === 'authenticated') {
        try {
            const state = await waClient.getState();
            if (state === 'CONNECTED') {
                waReady = true;
                waState = 'connected';
            }
        } catch (e) {}
    }
    res.json({
        qr: qrCodeData,
        state: waState,
        ready: waReady,
        error: lastError,
        reconnectAttempts,
    });
});

app.post('/api/disconnect', async (req, res) => {
    intentionalDisconnect = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    await destroyWhatsAppClient();
    waState = 'disconnected';
    lastError = null;
    reconnectAttempts = 0;
    res.json({ success: true, message: 'Disconnected successfully', state: waState });
});

app.post('/api/cancel', (req, res) => {
    cancelRequested = true;
    res.json({ success: true, message: 'Cancellation requested' });
});

// Contact Validation & Preview Endpoint
app.post('/api/contacts/preview', (req, res) => {
    let rawContent = '';
    let ext = '.txt';

    if (req.files && req.files.numbers_file) {
        const file = req.files.numbers_file;
        ext = path.extname(file.name).toLowerCase();
        const allowedExts = ['.txt', '.csv', '.xlsx', '.xls'];
        if (!allowedExts.includes(ext)) {
            return res.status(400).json({ error: 'Unsupported file format. Please upload .txt, .csv, or .xlsx' });
        }
        const tempPath = path.join(UPLOAD_DIR, `preview_${Date.now()}${ext}`);
        try {
            fs.writeFileSync(tempPath, file.data);
            const parsed = parseContacts(tempPath, ext, { defaultCountryCode: req.body.default_country_code });
            try { fs.unlinkSync(tempPath); } catch (e) {}

            const { allowed, suppressed } = optOutService.filterSuppressed(parsed.contacts);
            return res.json({
                totalRows: parsed.totalRows,
                validCount: allowed.length,
                duplicateCount: parsed.duplicates.length,
                invalidCount: parsed.invalid.length,
                suppressedCount: suppressed.length,
                sample: allowed.slice(0, 5),
                invalid: parsed.invalid.slice(0, 10),
                suppressed: suppressed.slice(0, 10),
            });
        } catch (e) {
            if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch (e2) {}
            return res.status(400).json({ error: 'Failed to parse contacts file: ' + e.message });
        }
    } else if (req.body.numbers_text) {
        rawContent = req.body.numbers_text;
        const parsed = parseContacts(rawContent, '.txt', { defaultCountryCode: req.body.default_country_code });
        const { allowed, suppressed } = optOutService.filterSuppressed(parsed.contacts);
        return res.json({
            totalRows: parsed.totalRows,
            validCount: allowed.length,
            duplicateCount: parsed.duplicates.length,
            invalidCount: parsed.invalid.length,
            suppressedCount: suppressed.length,
            sample: allowed.slice(0, 5),
            invalid: parsed.invalid.slice(0, 10),
            suppressed: suppressed.slice(0, 10),
        });
    }

    res.status(400).json({ error: 'No contact file or text provided.' });
});

// Campaign Send Endpoint
app.post('/api/send', async (req, res) => {
    if (sendingStatus.isSending) {
        return res.status(400).json({ error: 'Another campaign is already in progress. Please wait or cancel it.' });
    }
    if (!waReady) {
        return res.status(400).json({ error: 'WhatsApp is not connected. Please scan the QR code first.' });
    }

    let message = '';
    if (req.files && req.files.message_file) {
        message = req.files.message_file.data.toString('utf-8').trim();
    } else if (req.body.message_text) {
        message = req.body.message_text.trim();
    }

    let mediaPath = null;
    if (req.files && req.files.media_file) {
        const mediaFile = req.files.media_file;
        const safeBase = path.basename(mediaFile.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        const safeName = `media_${Date.now()}_${safeBase}`;
        mediaPath = path.join(UPLOAD_DIR, safeName);
        try {
            await mediaFile.mv(mediaPath);
        } catch (e) {
            if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e2) {}
            return res.status(400).json({ error: 'Could not save media attachment: ' + (e.message || String(e)) });
        }
    }

    if (!message && !mediaPath) {
        return res.status(400).json({ error: 'Please provide a message text, media file, or both.' });
    }

    let parsedResult;
    const defaultCountryCode = req.body.default_country_code || '';

    if (req.files && req.files.numbers_file) {
        const numFile = req.files.numbers_file;
        const ext = path.extname(numFile.name).toLowerCase();
        const allowedExts = ['.txt', '.csv', '.xlsx', '.xls'];
        if (!allowedExts.includes(ext)) {
            if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e) {}
            return res.status(400).json({ error: 'Unsupported contact file format. Use .txt, .csv, or .xlsx.' });
        }

        const numPath = path.join(UPLOAD_DIR, `nums_${Date.now()}${ext}`);
        try {
            await numFile.mv(numPath);
            parsedResult = parseContacts(numPath, ext, { defaultCountryCode });
        } catch (e) {
            if (numPath && fs.existsSync(numPath)) try { fs.unlinkSync(numPath); } catch (e) {}
            if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e) {}
            return res.status(400).json({ error: 'Could not read contacts file: ' + (e.message || String(e)) });
        } finally {
            if (numPath && fs.existsSync(numPath)) try { fs.unlinkSync(numPath); } catch (e) {}
        }
    } else if (req.body.numbers_text) {
        parsedResult = parseContacts(req.body.numbers_text, '.txt', { defaultCountryCode });
    } else {
        if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e) {}
        return res.status(400).json({ error: 'Please provide recipients via text or file upload.' });
    }

    // Filter out opted-out (STOP) contacts
    const { allowed: validContacts, suppressed } = optOutService.filterSuppressed(parsedResult.contacts);

    if (validContacts.length === 0) {
        if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e) {}
        let msg = 'No valid phone numbers found.';
        if (suppressed.length > 0) {
            msg += ` (${suppressed.length} numbers skipped because they previously opted out)`;
        }
        return res.status(400).json({ error: msg });
    }

    const options = {
        delayMin: Math.max(1, parseInt(req.body.delay_min, 10) || 5),
        delayMax: Math.max(1, parseInt(req.body.delay_max, 10) || 12),
        batchSize: Math.max(0, parseInt(req.body.batch_size, 10) || 0),
        batchCooldown: Math.max(5, parseInt(req.body.batch_cooldown, 10) || 60),
    };

    messageLogs = [];
    sendBulkMessages(validContacts, message, mediaPath, options).catch(err => {
        console.error('[WA] Bulk send pipeline error:', err && err.message ? err.message : err);
        sendingStatus.isSending = false;
        if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e) {}
    });

    res.json({
        success: true,
        message: `Campaign started for ${validContacts.length} valid contacts`,
        total: validContacts.length,
        duplicatesRemoved: parsedResult.duplicates.length,
        invalidCount: parsedResult.invalid.length,
        suppressedCount: suppressed.length,
    });
});

// Group Messaging Endpoints
app.get('/api/groups', async (req, res) => {
    if (!waClient || !waReady) {
        return res.status(400).json({ error: 'WhatsApp is not connected. Please connect WhatsApp first.' });
    }
    try {
        let chats = [];

        // Direct in-page extraction to avoid WAWebLidMigrationUtils/groupMetadata crash on pinned WhatsApp Web
        if (waClient.pupPage && typeof waClient.pupPage.evaluate === 'function') {
            try {
                const evaluated = await waClient.pupPage.evaluate(() => {
                    try {
                        let models = [];
                        if (typeof window.require === 'function') {
                            try {
                                const collections = window.require('WAWebCollections');
                                if (collections && collections.Chat) {
                                    models = typeof collections.Chat.getModelsArray === 'function'
                                        ? collections.Chat.getModelsArray()
                                        : (collections.Chat.models || []);
                                }
                            } catch (e) {}
                        }
                        if ((!models || models.length === 0) && window.Store && window.Store.Chat) {
                            models = window.Store.Chat.models || (typeof window.Store.Chat.getModelsArray === 'function' ? window.Store.Chat.getModelsArray() : []);
                        }
                        if (!Array.isArray(models)) return null;

                        return models
                            .filter(c => {
                                if (!c) return false;
                                const id = c.id && c.id._serialized ? c.id._serialized : (typeof c.id === 'string' ? c.id : '');
                                return c.isGroup === true || id.endsWith('@g.us');
                            })
                            .map(c => {
                                const id = c.id && c.id._serialized ? c.id._serialized : (typeof c.id === 'string' ? c.id : String(c.id || ''));
                                return {
                                    id,
                                    name: c.name || c.formattedTitle || (c.contact && (c.contact.name || c.contact.pushname)) || id,
                                    unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
                                    timestamp: typeof c.t === 'number' ? c.t : (typeof c.timestamp === 'number' ? c.timestamp : 0),
                                    isReadOnly: Boolean(c.isReadOnly || (c.groupMetadata && c.groupMetadata.announce) || c.announce),
                                    archived: Boolean(c.archive || c.archived),
                                    pinned: Boolean(c.pin || c.pinned),
                                    isGroup: true,
                                };
                            });
                    } catch (e) {
                        return null;
                    }
                });
                if (Array.isArray(evaluated) && evaluated.length > 0) {
                    chats = evaluated;
                }
            } catch (evalErr) {
                console.warn('[WA] pupPage evaluate for groups fallback:', evalErr.message || evalErr);
            }
        }

        if (chats.length === 0 && typeof waClient.getChats === 'function') {
            chats = await waClient.getChats();
        }

        const groups = filterGroupChats(chats);
        res.json({
            success: true,
            groups,
            count: groups.length,
        });
    } catch (err) {
        console.error('[WA] Failed to fetch groups:', err && err.message ? err.message : err);
        res.status(500).json({ error: 'Failed to retrieve WhatsApp groups: ' + (err.message || String(err)) });
    }
});

app.post('/api/groups/send', async (req, res) => {
    if (!waClient || !waReady) {
        return res.status(400).json({ error: 'WhatsApp is not connected. Please link WhatsApp first.' });
    }

    if (sendingStatus.isSending) {
        return res.status(400).json({ error: 'Another campaign is currently in progress. Please wait or cancel it first.' });
    }

    let message = (req.body.message_text || '').trim();

    if (req.files && req.files.message_file) {
        try {
            message = req.files.message_file.data.toString('utf-8').trim();
        } catch (e) {
            return res.status(400).json({ error: 'Could not read message template file.' });
        }
    }

    let mediaPath = null;
    if (req.files && req.files.media_file) {
        const mediaFile = req.files.media_file;
        if (mediaFile.size > 50 * 1024 * 1024) {
            return res.status(400).json({ error: 'Media file exceeds 50MB limit.' });
        }
        const safeBase = path.basename(mediaFile.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        const safeName = `media_${Date.now()}_${safeBase}`;
        mediaPath = path.join(UPLOAD_DIR, safeName);
        try {
            await mediaFile.mv(mediaPath);
        } catch (e) {
            if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e2) {}
            return res.status(400).json({ error: 'Could not save media attachment: ' + (e.message || String(e)) });
        }
    }

    if (!message && !mediaPath) {
        return res.status(400).json({ error: 'Please provide a message text, media file, or both.' });
    }

    const { validIds, duplicatesRemoved, invalidCount } = validateGroupIds(req.body.group_ids);

    if (validIds.length === 0) {
        if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e) {}
        return res.status(400).json({ error: 'Please select at least one valid WhatsApp group.' });
    }

    let groupNamesMap = {};
    if (req.body.group_names) {
        try {
            groupNamesMap = typeof req.body.group_names === 'string'
                ? JSON.parse(req.body.group_names)
                : req.body.group_names;
        } catch (e) {}
    }

    const validGroups = validIds.map(id => ({
        id,
        name: groupNamesMap[id] || id,
    }));

    const options = {
        delayMin: Math.max(1, parseInt(req.body.delay_min, 10) || 5),
        delayMax: Math.max(1, parseInt(req.body.delay_max, 10) || 12),
        batchSize: Math.max(0, parseInt(req.body.batch_size, 10) || 0),
        batchCooldown: Math.max(5, parseInt(req.body.batch_cooldown, 10) || 60),
    };

    messageLogs = [];
    sendBulkGroupMessages(validGroups, message, mediaPath, options).catch(err => {
        console.error('[WA] Group send pipeline error:', err && err.message ? err.message : err);
        sendingStatus.isSending = false;
        if (mediaPath && fs.existsSync(mediaPath)) try { fs.unlinkSync(mediaPath); } catch (e) {}
    });

    res.json({
        success: true,
        message: `Group campaign started for ${validGroups.length} groups`,
        total: validGroups.length,
        duplicatesRemoved,
        invalidCount,
    });
});

app.get('/api/status', async (req, res) => {
    if (waClient && !waReady && waState === 'authenticated') {
        try {
            const state = await waClient.getState();
            if (state === 'CONNECTED') {
                waReady = true;
                waState = 'connected';
            }
        } catch (e) {}
    }
    res.json({
        ...sendingStatus,
        logs: messageLogs,
        waState,
        waReady,
        error: lastError,
        reconnectAttempts,
    });
});

// Opt-out management API
app.get('/api/optouts', (req, res) => {
    res.json(optOutService.getAllOptOuts());
});

app.post('/api/optouts/remove', (req, res) => {
    const num = req.body.number;
    if (!num) return res.status(400).json({ error: 'Number is required' });
    const success = optOutService.removeOptOut(num);
    res.json({ success, message: success ? 'Number removed from opt-out list' : 'Number not found' });
});

app.post('/api/optouts/add', (req, res) => {
    const num = req.body.number;
    const reason = req.body.reason || 'Manually added via dashboard';
    if (!num) return res.status(400).json({ error: 'Number is required' });
    const success = optOutService.addOptOut(num, reason);
    res.json({ success, message: success ? 'Number added to suppression list' : 'Failed to add number' });
});

// History Endpoints
app.get('/api/history', (req, res) => {
    res.json(allHistory.slice(-500));
});

app.post('/api/history/clear', (req, res) => {
    allHistory = [];
    saveHistory();
    res.json({ success: true });
});

app.get('/api/history/export', (req, res) => {
    if (allHistory.length === 0) {
        return res.status(400).json({ error: 'No history to export' });
    }
    const ws = xlsx.utils.json_to_sheet(allHistory);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'History');
    const exportPath = path.join(UPLOAD_DIR, 'history_export.xlsx');
    xlsx.writeFile(wb, exportPath);
    res.download(exportPath, 'whatsapp_history.xlsx');
});

// Settings Endpoints with strict input validation
app.get('/api/settings', (req, res) => {
    res.json({
        port: PORT,
        delayMin: parseInt(process.env.DELAY_MIN, 10) || 5,
        delayMax: parseInt(process.env.DELAY_MAX, 10) || 12,
        batchSize: parseInt(process.env.BATCH_SIZE, 10) || 0,
        batchCooldown: parseInt(process.env.BATCH_COOLDOWN, 10) || 60,
    });
});

app.post('/api/settings/save', (req, res) => {
    const port = parseInt(req.body.port, 10);
    const delayMin = parseInt(req.body.delayMin, 10);
    const delayMax = parseInt(req.body.delayMax, 10);
    const batchSize = parseInt(req.body.batchSize, 10);
    const batchCooldown = parseInt(req.body.batchCooldown, 10);

    if (isNaN(port) || port < 1024 || port > 65535) {
        return res.status(400).json({ error: 'Port must be an integer between 1024 and 65535.' });
    }
    if (isNaN(delayMin) || delayMin < 1 || delayMin > 300) {
        return res.status(400).json({ error: 'Min Delay must be an integer between 1 and 300 seconds.' });
    }
    if (isNaN(delayMax) || delayMax < delayMin || delayMax > 600) {
        return res.status(400).json({ error: 'Max Delay must be greater than or equal to Min Delay (up to 600s).' });
    }
    if (isNaN(batchSize) || batchSize < 0 || batchSize > 1000) {
        return res.status(400).json({ error: 'Batch Size must be between 0 and 1000.' });
    }
    if (isNaN(batchCooldown) || batchCooldown < 5 || batchCooldown > 3600) {
        return res.status(400).json({ error: 'Batch Cooldown must be between 5 and 3600 seconds.' });
    }

    const envContent = `# WhatsApp Bulk Sender Configuration
PORT=${port}
DELAY_MIN=${delayMin}
DELAY_MAX=${delayMax}
BATCH_SIZE=${batchSize}
BATCH_COOLDOWN=${batchCooldown}
`;
    try {
        fs.writeFileSync(dataEnvPath, envContent, 'utf-8');
        res.json({ success: true, message: 'Settings saved! Restart app to apply port changes.' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to write settings: ' + e.message });
    }
});

app.post('/api/clear-logs', (req, res) => {
    messageLogs = [];
    res.json({ success: true });
});

// Clean shutdown
app.post('/api/quit', async (req, res) => {
    res.json({ success: true, message: 'Shutting down...' });
    setTimeout(async () => {
        console.log('\n[*] Quit requested from dashboard. Shutting down...');
        await destroyWhatsAppClient();
        saveHistory();
        process.exit(0);
    }, 500);
});

// ─── System Tray ───
function setupSystemTray() {
    let SysTray;
    try {
        SysTray = require('systray').default;
    } catch (e) {
        console.log('[*] systray not available, skipping tray icon');
        return;
    }

    const iconPath = path.join(ASSETS_DIR, 'icon.ico');
    let icon = '';
    try {
        if (fs.existsSync(iconPath)) {
            icon = fs.readFileSync(iconPath).toString('base64');
        }
    } catch (e) {}

    const safePort = parseInt(PORT, 10) || 5000;
    const systray = new SysTray({
        menu: {
            icon: icon,
            title: 'BulkSender',
            tooltip: 'BulkSender - WhatsApp Bulk Messenger',
            items: [
                { title: 'Open Dashboard', tooltip: 'Open in browser', checked: false, enabled: true },
                { title: 'Restart Server', tooltip: 'Restart', checked: false, enabled: true },
                { title: '__SEPARATOR__', tooltip: '', checked: false, enabled: false },
                { title: `Running on port ${safePort}`, tooltip: '', checked: false, enabled: false },
                { title: '__SEPARATOR__', tooltip: '', checked: false, enabled: false },
                { title: 'Quit BulkSender', tooltip: 'Shutdown the server', checked: false, enabled: true },
            ],
        },
        debug: false,
        copyDir: true,
    });

    systray.onClick(action => {
        if (action.seq_id === 0) {
            exec(`start http://localhost:${safePort}`);
        } else if (action.seq_id === 1) {
            console.log('[*] Restart requested');
            process.exit(0);
        } else if (action.seq_id === 5) {
            console.log('[*] Quit requested from tray');
            systray.kill(false);
            setTimeout(async () => {
                await destroyWhatsAppClient();
                saveHistory();
                process.exit(0);
            }, 200);
        }
    });

    systray.onError(err => {
        console.log('[*] Tray error:', err.message);
    });

    return systray;
}

// Start server
const httpServer = app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('  BulkSender v2.0.2 (Production Ready)');
    console.log(`  Open: http://localhost:${PORT}`);
    console.log('='.repeat(50) + '\n');

    if (process.env.BULKSENDER_DESKTOP !== 'true') {
        try { setupSystemTray(); } catch (e) { console.log('[*] Tray setup skipped'); }
    }

    // Auto-connect if previous authenticated session exists
    if (process.env.BULKSENDER_NO_AUTOCONNECT !== 'true' && process.env.NODE_ENV !== 'test' && fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0) {
        console.log('[*] Existing session found, auto-connecting...');
        autoConnectTimer = setTimeout(() => {
            initWhatsApp().catch(e => console.error('[*] Auto-connect failed:', e.message));
        }, 1000);
    }
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n[ERROR] Port ${PORT} is already in use.`);
        console.error('Either close the other instance or change PORT in .env\n');
        process.exit(1);
    }
    throw err;
});
app.server = httpServer;

// Graceful shutdown signals
process.on('SIGINT', async () => {
    console.log('\n[*] Received SIGINT. Shutting down gracefully...');
    await destroyWhatsAppClient();
    saveHistory();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n[*] Received SIGTERM. Shutting down gracefully...');
    await destroyWhatsAppClient();
    saveHistory();
    process.exit(0);
});

app.confirmMessageSend = confirmMessageSend;
app.isMatchingOutgoingMessage = isMatchingOutgoingMessage;
app.destroyWhatsAppClient = destroyWhatsAppClient;
app.clearTimers = () => {
    if (autoConnectTimer) {
        clearTimeout(autoConnectTimer);
        autoConnectTimer = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (historySaveTimer) {
        clearTimeout(historySaveTimer);
        historySaveTimer = null;
    }
};
app.filterGroupChats = filterGroupChats;
app.validateGroupIds = validateGroupIds;
app.sendBulkGroupMessages = sendBulkGroupMessages;
app.setWhatsAppClient = (client) => { waClient = client; };
app.setWhatsAppReady = (ready) => {
    waReady = ready;
    waState = ready ? 'connected' : 'disconnected';
};
app.getSendingStatus = () => sendingStatus;
app.getMessageLogs = () => messageLogs;
app.requestCancel = () => { cancelRequested = true; };

module.exports = app;
