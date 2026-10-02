// lib/messageConfirmation.js
// Multi-tier outgoing WhatsApp message confirmation to eliminate false-failures

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractIdString(val) {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
        if (typeof val._serialized === 'string') return val._serialized;
        if (typeof val.user === 'string') {
            const server = typeof val.server === 'string' ? val.server : 'c.us';
            return `${val.user}@${server}`;
        }
        if (typeof val.id === 'string') return val.id;
    }
    return String(val);
}

function normalizeDigits(str) {
    return String(str || '').replace(/@.*$/, '').replace(/\D/g, '');
}

function normalizeText(str) {
    if (str == null) return '';
    return String(str)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

/**
 * Validates whether an incoming or fetched message matches the outgoing send intent
 */
function isMatchingOutgoingMessage(msg, targetChatId, text, media, sentAtSec) {
    if (!msg) return false;

    // Must be sent from the current user
    const isFromMe = msg.fromMe === true || (msg.id && msg.id.fromMe === true);
    if (!isFromMe) return false;

    // Chat ID match check
    const targetStr = extractIdString(targetChatId);
    const targetClean = normalizeDigits(targetStr);

    const msgToStr = extractIdString(msg.to);
    const msgRemoteStr = extractIdString(msg.id && msg.id.remote);

    const toClean = normalizeDigits(msgToStr);
    const remoteClean = normalizeDigits(msgRemoteStr);

    const matchesChat = (
        (msgToStr && (msgToStr === targetStr || (targetClean && toClean === targetClean))) ||
        (msgRemoteStr && (msgRemoteStr === targetStr || (targetClean && remoteClean === targetClean)))
    );
    if (!matchesChat) return false;

    // Timestamp check: allow 2 minutes before send for clock drift
    if (typeof msg.timestamp === 'number' && typeof sentAtSec === 'number' && sentAtSec > 0) {
        if (msg.timestamp < sentAtSec - 120) return false;
    }

    // Media message
    if (media) {
        if (text && msg.body) {
            const sentNorm = normalizeText(text);
            const gotNorm = normalizeText(msg.body);
            if (gotNorm === sentNorm) return true;
        }
        return true;
    }

    // Text message
    if (text) {
        const sentNorm = normalizeText(text);
        const gotNorm = normalizeText(msg.body);
        return gotNorm === sentNorm;
    }

    return true;
}

/**
 * Ensures getChatModel inside WhatsApp Web does not throw IndexedDB DataError on invalid lastReceivedKey
 */
async function ensurePageChatSafe(waClient) {
    if (!waClient || !waClient.pupPage) return;
    try {
        await waClient.pupPage.evaluate(() => {
            if (window.WWebJS && !window.WWebJS._lastReceivedKeyPatched) {
                const origGetChatModel = window.WWebJS.getChatModel;
                if (typeof origGetChatModel === 'function') {
                    window.WWebJS.getChatModel = async function (chat, opts) {
                        if (chat && chat.lastReceivedKey && !chat.lastReceivedKey._serialized) {
                            chat.lastReceivedKey = null;
                        }
                        return origGetChatModel.call(this, chat, opts);
                    };
                }
                window.WWebJS._lastReceivedKeyPatched = true;
            }
        });
    } catch (e) {}
}

/**
 * Fallback Tier 3: Verify delivery through chat.lastMessage
 */
async function verifyMessageDelivered(waClient, chatId, text, media, sentAtSec, sleepFn = sleep) {
    if (!waClient) return null;
    await ensurePageChatSafe(waClient);

    for (let i = 0; i < 3; i++) {
        await sleepFn(1000);
        try {
            if (typeof waClient.getChatById === 'function') {
                const chat = await waClient.getChatById(chatId);
                const last = chat && chat.lastMessage;
                if (isMatchingOutgoingMessage(last, chatId, text, media, sentAtSec)) {
                    return last;
                }
            }
        } catch (e) {}

        // Fallback: check recent message from page
        if (waClient.pupPage) {
            try {
                const last = await waClient.pupPage.evaluate(async (targetId) => {
                    const chatWid = window.require('WAWebWidFactory').createWid(targetId);
                    const rawChat = window.require('WAWebCollections').Chat.get(chatWid) ||
                        (await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid))?.chat;
                    if (!rawChat || !rawChat.msgs) return null;
                    const msgs = rawChat.msgs.getModelsArray();
                    const m = msgs[msgs.length - 1];
                    if (!m) return null;
                    const idObj = m.id || {};
                    return {
                        id: {
                            fromMe: idObj.fromMe !== false,
                            remote: idObj.remote ? (idObj.remote._serialized || idObj.remote) : targetId,
                            _serialized: idObj._serialized || `true_${targetId}_${idObj.id || 'sent'}`,
                            id: idObj.id || 'sent',
                        },
                        fromMe: idObj.fromMe !== false,
                        to: targetId,
                        body: m.body || m.caption || '',
                        timestamp: m.t || Math.floor(Date.now() / 1000),
                    };
                }, chatId);

                if (isMatchingOutgoingMessage(last, chatId, text, media, sentAtSec)) {
                    return last;
                }
            } catch (e) {}
        }
    }
    return null;
}

/**
 * Fallback Tier 4: Verify delivery by fetching recent chat messages
 */
async function verifyViaFetchMessages(waClient, chatId, text, media, sentAtSec, sleepFn = sleep) {
    if (!waClient) return null;
    await ensurePageChatSafe(waClient);

    for (let attempt = 0; attempt < 3; attempt++) {
        await sleepFn(1000);
        let messages = [];

        // Primary: chat.fetchMessages({ limit: 10, fromMe: true })
        if (typeof waClient.getChatById === 'function') {
            try {
                const chat = await waClient.getChatById(chatId);
                if (chat && typeof chat.fetchMessages === 'function') {
                    messages = await chat.fetchMessages({ limit: 10, fromMe: true });
                }
            } catch (err) {}
        }

        // Secondary fallback: inspect raw chat messages directly from page
        if ((!Array.isArray(messages) || messages.length === 0) && waClient.pupPage) {
            try {
                const rawMsgs = await waClient.pupPage.evaluate(async (targetId) => {
                    const chatWid = window.require('WAWebWidFactory').createWid(targetId);
                    const rawChat = window.require('WAWebCollections').Chat.get(chatWid) ||
                        (await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid))?.chat;
                    if (!rawChat || !rawChat.msgs) return [];
                    return rawChat.msgs.getModelsArray().map(m => {
                        const idObj = m.id || {};
                        return {
                            id: {
                                fromMe: idObj.fromMe !== false,
                                remote: idObj.remote ? (idObj.remote._serialized || idObj.remote) : targetId,
                                _serialized: idObj._serialized || `true_${targetId}_${idObj.id || 'sent'}`,
                                id: idObj.id || 'sent',
                            },
                            fromMe: idObj.fromMe !== false,
                            to: targetId,
                            body: m.body || m.caption || '',
                            timestamp: m.t || Math.floor(Date.now() / 1000),
                        };
                    });
                }, chatId);

                if (Array.isArray(rawMsgs)) {
                    messages = rawMsgs;
                }
            } catch (evalErr) {}
        }

        if (Array.isArray(messages) && messages.length > 0) {
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if (isMatchingOutgoingMessage(m, chatId, text, media, sentAtSec)) {
                    return m;
                }
            }
        }
    }
    return null;
}

/**
 * Multi-tier send confirmation:
 * 1. Direct sendMessage response
 * 2. Temporary message_create listener
 * 3. chat.lastMessage inspection
 * 4. chat.fetchMessages inspection
 */
async function confirmMessageSend({
    waClient,
    chatId,
    text,
    media,
    sentAtSec,
    sendMessageFn,
    verifyLastMessageFn = (c, t, m, s) => verifyMessageDelivered(waClient, c, t, m, s),
    verifyFetchMessagesFn = (c, t, m, s) => verifyViaFetchMessages(waClient, c, t, m, s),
    sleepFn = sleep,
    messageCreateTimeoutMs = 3000,
}) {
    let capturedMsg = null;
    let notifyMessageCreate = null;
    const messagePromise = new Promise(resolve => {
        notifyMessageCreate = resolve;
    });

    const onMessageCreate = (msg) => {
        try {
            if (isMatchingOutgoingMessage(msg, chatId, text, media, sentAtSec)) {
                capturedMsg = msg;
                if (notifyMessageCreate) notifyMessageCreate(msg);
            }
        } catch (e) {}
    };

    if (waClient && typeof waClient.on === 'function') {
        waClient.on('message_create', onMessageCreate);
    }

    try {
        let sendResult = null;
        let sendError = null;

        try {
            sendResult = await sendMessageFn();
        } catch (err) {
            sendError = err;
        }

        // Tier 1: Valid Message object returned directly by sendMessage
        if (sendResult && sendResult.id && (sendResult.id._serialized || sendResult.id.id)) {
            return sendResult;
        }

        // Tier 2: Check captured message from message_create listener
        // If not already captured, wait up to messageCreateTimeoutMs (defaults to 3s)
        if (!capturedMsg) {
            const timer = sleepFn(messageCreateTimeoutMs);
            await Promise.race([messagePromise, timer]);
        }

        if (capturedMsg && capturedMsg.id && (capturedMsg.id._serialized || capturedMsg.id.id)) {
            console.log(`[WA] Message confirmed via message_create event for ${chatId}`);
            return capturedMsg;
        }

        // Tier 3: Verified via chat.lastMessage
        const lastMsgVerified = await verifyLastMessageFn(chatId, text, media, sentAtSec);
        if (lastMsgVerified && lastMsgVerified.id && (lastMsgVerified.id._serialized || lastMsgVerified.id.id)) {
            console.log(`[WA] Message confirmed via chat.lastMessage for ${chatId}`);
            return lastMsgVerified;
        }

        // Tier 4: Verified via chat.fetchMessages
        const fetchedMsg = await verifyFetchMessagesFn(chatId, text, media, sentAtSec);
        if (fetchedMsg && fetchedMsg.id && (fetchedMsg.id._serialized || fetchedMsg.id.id)) {
            console.log(`[WA] Message confirmed via chat.fetchMessages for ${chatId}`);
            return fetchedMsg;
        }

        // If unconfirmed and send failed with an error, rethrow that error
        if (sendError) {
            throw sendError;
        }

        throw new Error('WhatsApp returned no message confirmation (chat not ready)');
    } finally {
        // Requirement 5: The listener must always be removed on success, failure, and timeout. No EventEmitter listener leaks.
        if (waClient && typeof waClient.removeListener === 'function') {
            waClient.removeListener('message_create', onMessageCreate);
        }
    }
}

module.exports = {
    isMatchingOutgoingMessage,
    verifyMessageDelivered,
    verifyViaFetchMessages,
    confirmMessageSend,
};
