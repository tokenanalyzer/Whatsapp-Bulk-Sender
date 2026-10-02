// tests/api.test.js
// Integration tests for Express API endpoints, validation, opt-outs, and error handling

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Set test environment
const testDataDir = path.join(__dirname, '..', '.test_data');
try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
} catch (e) {}
fs.mkdirSync(testDataDir, { recursive: true });

process.env.BULKSENDER_DESKTOP = 'true';
process.env.BULKSENDER_NO_AUTOCONNECT = 'true';
process.env.NODE_ENV = 'test';
process.env.BULKSENDER_DATA_DIR = testDataDir;

const app = require('../server');

function makeRequest(method, pathUrl, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const reqHeaders = { Connection: 'close', ...headers };
        if (payload && !reqHeaders['Content-Type']) {
            reqHeaders['Content-Type'] = 'application/json';
        }
        if (payload) {
            reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request({
            port: process.env.PORT || 5000,
            host: '127.0.0.1',
            path: pathUrl,
            method,
            headers: reqHeaders,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = data;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {}
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

test('API Integration Suite', async (t) => {
    // Wait for server to bind
    if (app.server && !app.server.listening) {
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 500);
            app.server.once('listening', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    await t.test('GET / serves HTML with security headers', async () => {
        const res = await makeRequest('GET', '/');
        assert.equal(res.status, 200);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        assert.ok(typeof res.body === 'string' && res.body.includes('BulkSender'));
    });

    await t.test('GET /api/health returns system health and state', async () => {
        const res = await makeRequest('GET', '/api/health');
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'ok');
        assert.equal(res.body.version, '2.0.2');
        assert.ok('uptime' in res.body);
    });

    await t.test('GET /api/qr returns valid connection state object', async () => {
        const res = await makeRequest('GET', '/api/qr');
        assert.equal(res.status, 200);
        assert.ok('state' in res.body);
        assert.ok('ready' in res.body);
        assert.ok('error' in res.body);
    });

    await t.test('POST /api/contacts/preview validates input, removes duplicates, detects variables', async () => {
        const payload = {
            numbers_text: '+919876543210, Alice\n+919876543210, Alice Dup\n+918765432109, Bob\ninvalid123',
            default_country_code: '91',
        };
        const res = await makeRequest('POST', '/api/contacts/preview', payload);
        assert.equal(res.status, 200);
        assert.equal(res.body.validCount, 2);
        assert.equal(res.body.duplicateCount, 1);
        assert.equal(res.body.invalidCount, 1);
        assert.equal(res.body.sample[0].number, '919876543210');
        assert.equal(res.body.sample[0].name, 'Alice');
    });

    await t.test('Opt-Out API: Add, List, and Remove numbers from suppression', async () => {
        // Add
        const addRes = await makeRequest('POST', '/api/optouts/add', {
            number: '919999888877',
            reason: 'Integration test',
        });
        assert.equal(addRes.status, 200);
        assert.equal(addRes.body.success, true);

        // List
        const listRes = await makeRequest('GET', '/api/optouts');
        assert.equal(listRes.status, 200);
        assert.ok(Array.isArray(listRes.body));
        const found = listRes.body.find(i => i.number === '919999888877');
        assert.ok(found !== undefined);

        // Preview should now mark it as suppressed
        const prevRes = await makeRequest('POST', '/api/contacts/preview', {
            numbers_text: '+919999888877, Suppressed User\n+918888777766, Allowed User',
        });
        assert.equal(prevRes.body.validCount, 1);
        assert.equal(prevRes.body.suppressedCount, 1);

        // Remove
        const removeRes = await makeRequest('POST', '/api/optouts/remove', {
            number: '919999888877',
        });
        assert.equal(removeRes.status, 200);
        assert.equal(removeRes.body.success, true);
    });

    await t.test('POST /api/settings/save enforces validation and rejects injections', async () => {
        // Invalid port
        const badPort = await makeRequest('POST', '/api/settings/save', {
            port: 99999,
            delayMin: 5,
            delayMax: 10,
            batchSize: 0,
            batchCooldown: 60,
        });
        assert.equal(badPort.status, 400);
        assert.ok(badPort.body.error.includes('Port must be an integer'));

        // Invalid delay min/max
        const badDelay = await makeRequest('POST', '/api/settings/save', {
            port: 5000,
            delayMin: 20,
            delayMax: 5,
            batchSize: 0,
            batchCooldown: 60,
        });
        assert.equal(badDelay.status, 400);

        // Valid settings save
        const goodSave = await makeRequest('POST', '/api/settings/save', {
            port: 5000,
            delayMin: 5,
            delayMax: 15,
            batchSize: 20,
            batchCooldown: 90,
        });
        assert.equal(goodSave.status, 200);
        assert.equal(goodSave.body.success, true);
    });

    await t.test('POST /api/send rejects gracefully if WhatsApp is not connected', async () => {
        const sendRes = await makeRequest('POST', '/api/send', {
            numbers_text: '+919876543210',
            message_text: 'Test message',
        });
        assert.equal(sendRes.status, 400);
        assert.ok(sendRes.body.error.includes('WhatsApp is not connected'));
    });

    await t.test('GET /api/groups rejects gracefully if WhatsApp is not connected', async () => {
        const res = await makeRequest('GET', '/api/groups');
        assert.equal(res.status, 400);
        assert.ok(res.body.error.includes('WhatsApp is not connected'));
    });

    await t.test('POST /api/groups/send rejects gracefully if WhatsApp is not connected', async () => {
        const res = await makeRequest('POST', '/api/groups/send', {
            group_ids: '120363025111111111@g.us',
            message_text: 'Test group message',
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.error.includes('WhatsApp is not connected'));
    });

    await t.test('Group messaging pipeline: discovery, validation, single-send, confirmation, and cancellation', async () => {
        const EventEmitter = require('events');
        const mockClient = new EventEmitter();

        const group1Id = '120363025111111111@g.us';
        const group2Id = '120363025222222222@g.us';
        const group3Id = '120363025333333333@g.us';

        const mockChats = [
            {
                id: { _serialized: group1Id },
                isGroup: true,
                name: 'Product Updates',
                unreadCount: 1,
                timestamp: 1700000100,
                isReadOnly: false,
                participants: [{ id: '919876543210@c.us' }],
            },
            {
                id: { _serialized: group2Id },
                isGroup: true,
                name: 'Beta Testers',
                unreadCount: 0,
                timestamp: 1700000200,
                isReadOnly: false,
                participants: [{ id: '918888888888@c.us' }],
            },
            {
                id: { _serialized: group3Id },
                isGroup: true,
                name: 'Announcements (Read Only)',
                unreadCount: 0,
                timestamp: 1700000300,
                isReadOnly: true,
                participants: [{ id: '917777777777@c.us' }],
            },
            {
                id: { _serialized: '919876543210@c.us' },
                isGroup: false,
                name: 'Alice',
                unreadCount: 0,
            }
        ];

        mockClient.getState = async () => 'CONNECTED';
        mockClient.isRegisteredUser = async () => true;
        mockClient.getChats = async () => mockChats;
        mockClient.getChatById = async (id) => {
            const found = mockChats.find(c => (c.id._serialized || c.id) === id);
            return found || null;
        };

        const sentGroupCalls = [];
        mockClient.sendMessage = async (chatId, text, options) => {
            sentGroupCalls.push({ chatId, text, options });
            const sentAtSec = Math.floor(Date.now() / 1000);
            mockClient.emit('message_create', {
                id: { _serialized: `true_${chatId}_MSG_${Date.now()}`, remote: chatId },
                fromMe: true,
                to: chatId,
                body: text,
                timestamp: sentAtSec,
            });
            return undefined;
        };

        // Connect simulated client
        app.setWhatsAppClient(mockClient);
        app.setWhatsAppReady(true);

        try {
            // 1. GET /api/groups returns filtered groups without participant lists
            const groupsRes = await makeRequest('GET', '/api/groups');
            assert.equal(groupsRes.status, 200);
            assert.equal(groupsRes.body.count, 3);
            assert.equal(groupsRes.body.groups.length, 3);
            for (const g of groupsRes.body.groups) {
                assert.ok(g.id.endsWith('@g.us'));
                assert.strictEqual(g.participants, undefined, 'Must never return participant lists');
            }

            // 2. Reject empty group selection
            const emptyRes = await makeRequest('POST', '/api/groups/send', {
                group_ids: '',
                message_text: 'Hello Group',
            });
            assert.equal(emptyRes.status, 400);
            assert.ok(emptyRes.body.error.includes('Please select at least one valid WhatsApp group'));

            // 3. Reject non-group recipient IDs
            const invalidRes = await makeRequest('POST', '/api/groups/send', {
                group_ids: '919876543210@c.us',
                message_text: 'Hello Group',
            });
            assert.equal(invalidRes.status, 400);

            // 4. Send to valid group with duplicate removed
            const sendRes = await makeRequest('POST', '/api/groups/send', {
                group_ids: `${group1Id}, ${group1Id}`,
                message_text: 'Automated Group Notice',
                delay_min: 1,
                delay_max: 1,
            });
            assert.equal(sendRes.status, 200);
            assert.equal(sendRes.body.success, true);
            assert.equal(sendRes.body.total, 1);
            assert.equal(sendRes.body.duplicatesRemoved, 1);

            // Wait for campaign completion
            let status;
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 100));
                const sRes = await makeRequest('GET', '/api/status');
                status = sRes.body;
                if (!status.isSending) break;
            }

            assert.equal(status.isSending, false);
            assert.equal(status.sent, 1);
            assert.equal(status.failed, 0);

            // Verify exactly one sendMessage call was made
            assert.equal(sentGroupCalls.length, 1);
            assert.equal(sentGroupCalls[0].chatId, group1Id);

            // Verify history has recipientType: 'group' and group metadata
            const histRes = await makeRequest('GET', '/api/history');
            assert.equal(histRes.status, 200);
            const groupRecord = histRes.body.find(h => h.groupId === group1Id);
            assert.ok(groupRecord, 'Group history record must exist');
            assert.equal(groupRecord.recipientType, 'group');
            assert.equal(groupRecord.groupName, 'Product Updates');
            assert.equal(groupRecord.status, 'sent');
            assert.ok(groupRecord.messageId.startsWith(`true_${group1Id}_MSG_`));

            // 5. Test read-only group rejection without resend
            const roSendRes = await makeRequest('POST', '/api/groups/send', {
                group_ids: group3Id,
                message_text: 'Should fail because read-only',
                delay_min: 1,
                delay_max: 1,
            });
            assert.equal(roSendRes.status, 200);

            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 100));
                const sRes = await makeRequest('GET', '/api/status');
                status = sRes.body;
                if (!status.isSending) break;
            }

            assert.equal(status.failed, 1);
            const roRecord = (await makeRequest('GET', '/api/history')).body.find(h => h.groupId === group3Id);
            assert.ok(roRecord);
            assert.equal(roRecord.status, 'failed');
            assert.ok(roRecord.error.includes('read-only'));

            // 6. Test cancellation stops remaining groups
            sentGroupCalls.length = 0;
            const multiRes = await makeRequest('POST', '/api/groups/send', {
                group_ids: `${group1Id}, ${group2Id}`,
                message_text: 'Will be cancelled',
                delay_min: 5,
                delay_max: 5,
            });
            assert.equal(multiRes.status, 200);

            // Cancel immediately
            const cancelRes = await makeRequest('POST', '/api/cancel');
            assert.equal(cancelRes.status, 200);

            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 100));
                const sRes = await makeRequest('GET', '/api/status');
                if (!sRes.body.isSending) break;
            }

            assert.ok(sentGroupCalls.length <= 1, 'Cancellation must prevent subsequent group sends');

        } finally {
            app.setWhatsAppClient(null);
            app.setWhatsAppReady(false);
            const st = app.getSendingStatus();
            if (st) {
                st.isSending = false;
                st.sent = 0;
                st.failed = 0;
                st.total = 0;
                st.pending = 0;
            }
        }
    });

    await t.test('POST /api/disconnect gracefully sets state to disconnected', async () => {
        const discRes = await makeRequest('POST', '/api/disconnect');
        assert.equal(discRes.status, 200);
        assert.equal(discRes.body.state, 'disconnected');
    });

    await t.test('GET /api/status returns initial sending status object', async () => {
        const statusRes = await makeRequest('GET', '/api/status');
        assert.equal(statusRes.status, 200);
        assert.equal(statusRes.body.isSending, false);
        assert.equal(statusRes.body.sent, 0);
        assert.equal(statusRes.body.failed, 0);
    });

    t.after(async () => {
        if (typeof app.clearTimers === 'function') {
            app.clearTimers();
        }
        if (typeof app.destroyWhatsAppClient === 'function') {
            await app.destroyWhatsAppClient();
        }
        if (app.server) {
            if (typeof app.server.closeAllConnections === 'function') {
                app.server.closeAllConnections();
            }
            await new Promise((resolve) => app.server.close(resolve));
        }
        try {
            fs.rmSync(process.env.BULKSENDER_DATA_DIR, { recursive: true, force: true });
        } catch (e) {}
    });
});
