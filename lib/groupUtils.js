// lib/groupUtils.js
// Safe group discovery filtering and group ID validation for WhatsApp groups

/**
 * Filter WhatsApp chats to only valid group chats.
 * Strips all participant/member details for privacy and safety.
 *
 * @param {Array} chats - List of raw WhatsApp chat objects
 * @returns {Array} List of sanitized group objects
 */
function filterGroupChats(chats) {
    if (!Array.isArray(chats)) return [];
    return chats
        .filter(c => {
            if (!c) return false;
            if (c.isGroup === true) return true;
            const idStr = c.id && typeof c.id._serialized === 'string'
                ? c.id._serialized
                : (typeof c.id === 'string' ? c.id : '');
            return idStr.endsWith('@g.us');
        })
        .map(c => {
            const id = c.id && c.id._serialized
                ? c.id._serialized
                : (typeof c.id === 'string' ? c.id : String(c.id || ''));
            return {
                id,
                name: c.name || c.formattedTitle || 'Unnamed Group',
                unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
                timestamp: typeof c.timestamp === 'number' ? c.timestamp : 0,
                isReadOnly: Boolean(c.isReadOnly),
                archived: Boolean(c.archived),
                pinned: Boolean(c.pinned),
            };
        })
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/**
 * Validate and deduplicate WhatsApp group IDs.
 * Accepts arrays, JSON array strings, comma-separated or newline-separated strings.
 *
 * @param {string|Array} input - Raw group ID input
 * @returns {{ validIds: string[], duplicatesRemoved: number, invalidCount: number }}
 */
function validateGroupIds(input) {
    let rawIds = [];
    if (Array.isArray(input)) {
        rawIds = input;
    } else if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawIds = parsed;
                else rawIds = [trimmed];
            } catch (e) {
                rawIds = trimmed.split(/[,\n\r]+/);
            }
        } else {
            rawIds = trimmed.split(/[,\n\r]+/);
        }
    }

    const seen = new Set();
    const validIds = [];
    let duplicatesRemoved = 0;
    let invalidCount = 0;

    for (const item of rawIds) {
        if (!item) continue;
        const id = typeof item === 'object' && item
            ? (item.id || item._serialized || '')
            : String(item).trim();
        if (!id) continue;

        if (!/^[a-zA-Z0-9_\-\.]+@g\.us$/.test(id)) {
            invalidCount++;
            continue;
        }

        if (seen.has(id)) {
            duplicatesRemoved++;
        } else {
            seen.add(id);
            validIds.push(id);
        }
    }

    return { validIds, duplicatesRemoved, invalidCount };
}

module.exports = {
    filterGroupChats,
    validateGroupIds,
};
