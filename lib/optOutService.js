// lib/optOutService.js
// Handles opt-out (STOP/UNSUBSCRIBE) compliance and persistent suppression list

const fs = require('fs');
const path = require('path');

const OPT_OUT_KEYWORDS = new Set([
    'stop',
    'unsubscribe',
    'quit',
    'cancel',
    'optout',
    'opt-out',
    'end',
    'block',
]);

class OptOutService {
    constructor(dataDir = process.cwd()) {
        this.filePath = path.join(dataDir, 'opt_outs.json');
        this.optOuts = new Map(); // number -> { number, timestamp, reason }
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                if (Array.isArray(data)) {
                    data.forEach(item => {
                        if (item && item.number) {
                            this.optOuts.set(item.number, item);
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('[OptOut] Could not load opt_outs.json:', e.message);
        }
    }

    save() {
        try {
            const list = Array.from(this.optOuts.values());
            const tempPath = `${this.filePath}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(list, null, 2), 'utf-8');
            fs.renameSync(tempPath, this.filePath);
        } catch (e) {
            console.error('[OptOut] Could not save opt_outs.json:', e.message);
        }
    }

    isOptOutMessage(body) {
        if (!body || typeof body !== 'string') return false;
        const cleaned = body.trim().toLowerCase();
        return OPT_OUT_KEYWORDS.has(cleaned);
    }

    isOptedOut(phoneNumber) {
        if (!phoneNumber) return false;
        const cleaned = String(phoneNumber).replace(/\D/g, '');
        return this.optOuts.has(cleaned);
    }

    addOptOut(phoneNumber, reason = 'User requested via message') {
        const cleaned = String(phoneNumber).replace(/\D/g, '');
        if (!cleaned) return false;

        const entry = {
            number: cleaned,
            timestamp: new Date().toISOString(),
            reason,
        };
        this.optOuts.set(cleaned, entry);
        this.save();
        console.log(`[OptOut] Registered opt-out for +${cleaned} (${reason})`);
        return true;
    }

    removeOptOut(phoneNumber) {
        const cleaned = String(phoneNumber).replace(/\D/g, '');
        if (this.optOuts.has(cleaned)) {
            this.optOuts.delete(cleaned);
            this.save();
            return true;
        }
        return false;
    }

    getAllOptOuts() {
        return Array.from(this.optOuts.values());
    }

    filterSuppressed(contacts) {
        const allowed = [];
        const suppressed = [];

        for (const contact of contacts) {
            const num = contact.number || contact;
            if (this.isOptedOut(num)) {
                suppressed.push(contact);
            } else {
                allowed.push(contact);
            }
        }

        return { allowed, suppressed };
    }
}

module.exports = OptOutService;
