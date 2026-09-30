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
