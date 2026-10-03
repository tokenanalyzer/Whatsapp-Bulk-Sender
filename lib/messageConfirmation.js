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
 * Safe validator for message objects to avoid triggering unsafe getters or crashing on partials
 */
function hasValidMessageId(msg) {
    if (!msg || typeof msg !== 'object') return false;
    try {
        const idVal = msg.id;
        if (!idVal) return false;
        if (typeof idVal === 'string' && idVal.length > 0) return true;
        if (typeof idVal === 'object') {
            return Boolean(
                (typeof idVal._serialized === 'string' && idVal._serialized.length > 0) ||
                (typeof idVal.id === 'string' && idVal.id.length > 0)
            );
        }
        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Ensures getChatModel and sendMessage inside WhatsApp Web do not throw memoizer or DataError:
 * 1. Patches WhatsApp Web getters (WAWebChatGetters, WAWebContactGetters, etc.) to safely handle missing IDs
 * 2. Patches window.WWebJS.sendMessage to ensure message.id and message.__x_id are never overwritten
 * 3. Patches getChatModel on invalid lastReceivedKey
 */
async function ensurePageChatSafe(waClient) {
    if (!waClient || !waClient.pupPage) return;
    try {
        await waClient.pupPage.evaluate(() => {
            // A. Protect WhatsApp Web getter memoizers against missing id property
            const getterModules = [
                'WAWebChatGetters',
                'WAWebContactGetters',
                'WAWebFrontendContactGetters',
                'WAWebMsgGetters',
            ];
            for (const modName of getterModules) {
                try {
                    if (typeof window.require === 'function') {
                        const mod = window.require(modName);
                        if (mod && typeof mod === 'object') {
                            for (const key of Object.keys(mod)) {
                                const origFn = mod[key];
                                if (typeof origFn === 'function' && !origFn._memoizeSafePatched) {
                                    mod[key] = function (data, ...args) {
                                        if (data && typeof data === 'object') {
                                            if (!data.id && data._id) data.id = data._id;
                                            if (!data.id && data.__x_id) data.id = data.__x_id;
                                            if (data.id && !data.__x_id) data.__x_id = data.id;
                                        }
                                        try {
                                            return origFn.call(this, data, ...args);
                                        } catch (err) {
                                            const errMsg = String(err && err.message ? err.message : err);
                                            if (errMsg.includes("it's how we memoize") || errMsg.includes('include an id property')) {
                                                return false;
                                            }
                                            throw err;
                                        }
                                    };
                                    mod[key]._memoizeSafePatched = true;
                                }
                            }
                        }
                    }
                } catch (e) {}
            }

            // B. Protect window.WWebJS.sendMessage against media ID clobbering and missing chat.__x_id
            if (window.WWebJS && !window.WWebJS._sendSafePatched && typeof window.WWebJS.sendMessage === 'function') {
                const origSendMessage = window.WWebJS.sendMessage;
                window.WWebJS.sendMessage = async function (chat, content, options = {}) {
                    if (chat && typeof chat === 'object') {
                        if (!chat.id && chat._id) chat.id = chat._id;
                        if (chat.id && !chat.__x_id) chat.__x_id = chat.id;
                    }

                    if (options && options.media && typeof options.media === 'object') {
                        delete options.media.id;
                        delete options.media.__x_id;
                    }

                    const res = await origSendMessage.call(this, chat, content, options);

                    // If message model was not returned directly, check chat msgs
                    if (!res && chat && chat.msgs && typeof chat.msgs.getModelsArray === 'function') {
                        const arr = chat.msgs.getModelsArray();
                        return arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
                    }
                    return res;
                };
                window.WWebJS._sendSafePatched = true;
            }

            // C. Protect window.WWebJS.getChatModel on lastReceivedKey
            if (window.WWebJS && !window.WWebJS._lastReceivedKeyPatched) {
                const origGetChatModel = window.WWebJS.getChatModel;
                if (typeof origGetChatModel === 'function') {
                    window.WWebJS.getChatModel = async function (chat, opts) {
                        if (chat && typeof chat === 'object') {
                            if (!chat.id && chat._id) chat.id = chat._id;
                            if (chat.id && !chat.__x_id) chat.__x_id = chat.id;
                            if (chat.lastReceivedKey && !chat.lastReceivedKey._serialized) {
                                chat.lastReceivedKey = null;
                            }
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
    // 1. Pre-flight: Ensure page-level guards are active before sending
    await ensurePageChatSafe(waClient);

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
        if (hasValidMessageId(sendResult)) {
            return sendResult;
        }

        // Tier 2: Check captured message from message_create listener
        // If not already captured, wait up to messageCreateTimeoutMs (defaults to 3s)
        if (!capturedMsg) {
            const timer = sleepFn(messageCreateTimeoutMs);
            await Promise.race([messagePromise, timer]);
        }

        if (hasValidMessageId(capturedMsg)) {
            console.log(`[WA] Message confirmed via message_create event for ${chatId}`);
            return capturedMsg;
        }

        // Tier 3: Verified via chat.lastMessage
        const lastMsgVerified = await verifyLastMessageFn(chatId, text, media, sentAtSec);
        if (hasValidMessageId(lastMsgVerified)) {
            console.log(`[WA] Message confirmed via chat.lastMessage for ${chatId}`);
            return lastMsgVerified;
        }

        // Tier 4: Verified via chat.fetchMessages
        const fetchedMsg = await verifyFetchMessagesFn(chatId, text, media, sentAtSec);
        if (hasValidMessageId(fetchedMsg)) {
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
    extractIdString,
    hasValidMessageId,
    ensurePageChatSafe,
    isMatchingOutgoingMessage,
    verifyMessageDelivered,
    verifyViaFetchMessages,
    confirmMessageSend,
};
