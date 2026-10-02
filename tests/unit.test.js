// tests/unit.test.js
// Comprehensive unit tests for phone normalization, contact parsing, opt-out suppression, and browser resolution

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
    normalizePhoneNumber,
    parseContacts,
    processSpinSyntax,
    processTemplateVars,
} = require('../lib/phoneUtils');
const OptOutService = require('../lib/optOutService');
const { resolveBrowserExecutable } = require('../lib/browserResolver');
const {
    confirmMessageSend,
    isMatchingOutgoingMessage,
} = require('../lib/messageConfirmation');

test('normalizePhoneNumber handles various formats correctly', () => {
    // Standard international
    assert.deepEqual(normalizePhoneNumber('+919876543210'), {
        valid: true,
        formatted: '919876543210',
        raw: '+919876543210',
    });

    // Formatting with dashes and spaces
    assert.deepEqual(normalizePhoneNumber('+1 (555) 234-5678'), {
        valid: true,
        formatted: '15552345678',
        raw: '+1 (555) 234-5678',
    });

    // Leading 00 international prefix
    assert.deepEqual(normalizePhoneNumber('00919876543210'), {
        valid: true,
        formatted: '919876543210',
        raw: '00919876543210',
    });

    // Excel decimal artifact (.0)
    assert.deepEqual(normalizePhoneNumber('919876543210.0'), {
        valid: true,
        formatted: '919876543210',
        raw: '919876543210.0',
    });

    // Local 10-digit number with default country code 91
    assert.deepEqual(normalizePhoneNumber('9876543210', '91'), {
        valid: true,
        formatted: '919876543210',
        raw: '9876543210',
    });

    // UK local number starting with 0 with default country code 44
    assert.deepEqual(normalizePhoneNumber('07123456789', '44'), {
        valid: true,
        formatted: '447123456789',
        raw: '07123456789',
    });

    // Invalid numbers: too short
    const shortRes = normalizePhoneNumber('12345');
    assert.equal(shortRes.valid, false);
    assert.ok(shortRes.error.includes('Invalid length'));

    // Empty number
    const emptyRes = normalizePhoneNumber('');
    assert.equal(emptyRes.valid, false);
});

test('parseContacts deduplicates and extracts variables', () => {
    const rawText = `+919876543210\n+919876543210\n919876543211\ninvalid_num\n00919876543210`;
    const res = parseContacts(rawText, '.txt');

    assert.equal(res.contacts.length, 2);
    assert.equal(res.contacts[0].number, '919876543210');
    assert.equal(res.contacts[1].number, '919876543211');
    assert.equal(res.duplicates.length, 2); // second 919876543210 and 00919876543210
    assert.equal(res.invalid.length, 1); // invalid_num
});

test('processSpinSyntax randomizes options correctly', () => {
    const template = '{Hello|Hi|Greetings} there!';
    const results = new Set();
    for (let i = 0; i < 50; i++) {
        results.add(processSpinSyntax(template));
    }
    assert.ok(results.has('Hello there!') || results.has('Hi there!') || results.has('Greetings there!'));
    assert.ok(!results.has('{Hello|Hi|Greetings} there!'));
});

test('processTemplateVars replaces variables case-insensitively', () => {
    const text = 'Hi {{Name}}, your order {{OrderID}} is ready!';
    const vars = { name: 'John Doe', orderid: 'ORD-999' };
    const rendered = processTemplateVars(text, vars);
    assert.equal(rendered, 'Hi John Doe, your order ORD-999 is ready!');
});

test('OptOutService manages STOP keywords and suppression', () => {
    const testDir = path.join(__dirname, '..', '.test_opt_out');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    try {
        const optOut = new OptOutService(testDir);
        assert.ok(optOut.isOptOutMessage('STOP'));
        assert.ok(optOut.isOptOutMessage('unsubscribe'));
        assert.ok(optOut.isOptOutMessage('  quit  '));
        assert.ok(!optOut.isOptOutMessage('Hello please send me more info'));

        optOut.addOptOut('919876543210', 'Received STOP');
        assert.ok(optOut.isOptedOut('+919876543210'));
        assert.ok(!optOut.isOptedOut('+919876543211'));

        const contacts = [
            { number: '919876543210', name: 'Opted Out User' },
            { number: '919876543211', name: 'Active User' },
        ];
        const { allowed, suppressed } = optOut.filterSuppressed(contacts);
        assert.equal(allowed.length, 1);
        assert.equal(allowed[0].number, '919876543211');
        assert.equal(suppressed.length, 1);
        assert.equal(suppressed[0].number, '919876543210');
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test('resolveBrowserExecutable locates an available Chromium browser', () => {
    const browser = resolveBrowserExecutable(path.join(__dirname, '..'));
    assert.ok(browser !== null, 'Browser should be resolvable');
    assert.ok(fs.existsSync(browser.path), `Browser path ${browser.path} must exist`);
});

test('confirmMessageSend resolves with confirmed message when sendMessage returns undefined (false-failure regression)', async () => {
    const EventEmitter = require('events');
    const mockClient = new EventEmitter();

    const targetChatId = '919876543210@c.us';
    const messageText = 'Hello Test Confirmation';
    const sentAtSec = Math.floor(Date.now() / 1000);

    const mockDeliveredMsg = {
        id: { _serialized: 'true_919876543210@c.us_ABC123', remote: targetChatId },
        fromMe: true,
        to: targetChatId,
        body: messageText,
        timestamp: sentAtSec,
    };

    // sendMessage resolves to undefined (reproducing the pinned WhatsApp Web bug)
    const sendMessageFn = async () => {
        // While sending is in flight, WhatsApp fires message_create event
        mockClient.emit('message_create', mockDeliveredMsg);
        return undefined; // no Message object returned by sendMessage
    };

    const result = await confirmMessageSend({
        waClient: mockClient,
        chatId: targetChatId,
        text: messageText,
        media: null,
        sentAtSec,
        sendMessageFn,
    });

    assert.ok(result !== null);
    assert.equal(result.id._serialized, 'true_919876543210@c.us_ABC123');
    assert.equal(mockClient.listenerCount('message_create'), 0, 'Listener must be cleaned up');
});

test('confirmMessageSend resolves when sendMessage throws but fetchMessages verifies delivered message', async () => {
    const EventEmitter = require('events');
    const mockClient = new EventEmitter();

    const targetChatId = '919876543210@c.us';
    const messageText = 'Hello Fetch Fallback';
    const sentAtSec = Math.floor(Date.now() / 1000);

    const mockDeliveredMsg = {
        id: { _serialized: 'true_919876543210@c.us_XYZ999', remote: targetChatId },
        fromMe: true,
        to: targetChatId,
        body: messageText,
        timestamp: sentAtSec,
    };

    const sendMessageFn = async () => {
        throw new Error("Cannot read properties of undefined (reading 'id')");
    };

    const result = await confirmMessageSend({
        waClient: mockClient,
        chatId: targetChatId,
        text: messageText,
        media: null,
        sentAtSec,
        sendMessageFn,
        verifyLastMessageFn: async () => null,
        verifyFetchMessagesFn: async () => mockDeliveredMsg,
        messageCreateTimeoutMs: 50,
    });

    assert.ok(result !== null);
    assert.equal(result.id._serialized, 'true_919876543210@c.us_XYZ999');
    assert.equal(mockClient.listenerCount('message_create'), 0, 'Listener must be cleaned up on error');
});

test('confirmMessageSend resolves when message_create arrives asynchronously after sendMessage finishes', async () => {
    const EventEmitter = require('events');
    const mockClient = new EventEmitter();

    const targetChatId = '919876543210@c.us';
    const messageText = 'Hello Async Confirmation';
    const sentAtSec = Math.floor(Date.now() / 1000);

    const mockDeliveredMsg = {
        id: { _serialized: 'true_919876543210@c.us_ASYNC123', remote: { _serialized: targetChatId } },
        fromMe: true,
        to: targetChatId,
        body: messageText,
        timestamp: sentAtSec,
    };

    const sendMessageFn = async () => {
        // Simulates Puppeteer IPC delay: event arrives 50ms AFTER sendMessage returns
        setTimeout(() => {
            mockClient.emit('message_create', mockDeliveredMsg);
        }, 50);
        return undefined;
    };

    const result = await confirmMessageSend({
        waClient: mockClient,
        chatId: targetChatId,
        text: messageText,
        media: null,
        sentAtSec,
        sendMessageFn,
        messageCreateTimeoutMs: 500,
    });

    assert.ok(result !== null);
    assert.equal(result.id._serialized, 'true_919876543210@c.us_ASYNC123');
    assert.equal(mockClient.listenerCount('message_create'), 0, 'Listener must be cleaned up');
});

test('isMatchingOutgoingMessage handles object remote, newlines, and media matching', () => {
    const { isMatchingOutgoingMessage } = require('../lib/messageConfirmation');
    const sentAtSec = 1700000000;

    // Object-based id.remote and to
    const msg1 = {
        id: { fromMe: true, remote: { _serialized: '919876543210@c.us' } },
        fromMe: true,
        to: '919876543210@c.us',
        body: 'Hello World\r\nTest',
        timestamp: sentAtSec + 1,
    };
    assert.ok(isMatchingOutgoingMessage(msg1, '919876543210@c.us', 'Hello World\nTest', null, sentAtSec));
    assert.ok(!isMatchingOutgoingMessage(msg1, '919876543211@c.us', 'Hello World\nTest', null, sentAtSec));

    // Media matching
    const mediaMsg = {
        id: { fromMe: true, remote: '919876543210@c.us' },
        fromMe: true,
        to: '919876543210@c.us',
        body: 'Media Caption',
        timestamp: sentAtSec + 1,
    };
    assert.ok(isMatchingOutgoingMessage(mediaMsg, '919876543210@c.us', 'Media Caption', {}, sentAtSec));
    assert.ok(isMatchingOutgoingMessage(mediaMsg, '919876543210@c.us', null, {}, sentAtSec));
});

test('filterGroupChats filters only actual WhatsApp group chats and never returns member/participant lists', () => {
    const { filterGroupChats } = require('../lib/groupUtils');

    const sampleChats = [
        {
            id: { _serialized: '120363025111111111@g.us' },
            isGroup: true,
            name: 'Dev Community',
            unreadCount: 3,
            timestamp: 1700000000,
            isReadOnly: false,
            participants: [{ id: '919876543210@c.us', isAdmin: true }],
            groupMetadata: { participants: [{ id: '919876543210@c.us' }] },
        },
        {
            id: '120363025222222222@g.us',
            isGroup: true,
            name: 'Announcement Group',
            unreadCount: 0,
            timestamp: 1700000500,
            isReadOnly: true,
            participants: [{ id: '918888888888@c.us' }],
        },
        {
            id: { _serialized: '919876543210@c.us' },
            isGroup: false,
            name: 'Direct Contact',
            unreadCount: 1,
            timestamp: 1700000100,
            participants: [],
        },
        {
            id: 'status@broadcast',
            isGroup: false,
            name: 'Status',
            timestamp: 1700000050,
        },
        null,
        undefined,
    ];

    const result = filterGroupChats(sampleChats);

    // Only the 2 groups should be returned
    assert.equal(result.length, 2);
    assert.equal(result[0].id, '120363025222222222@g.us'); // sorted by timestamp desc
    assert.equal(result[0].name, 'Announcement Group');
    assert.equal(result[0].isReadOnly, true);
    assert.equal(result[1].id, '120363025111111111@g.us');
    assert.equal(result[1].name, 'Dev Community');
    assert.equal(result[1].unreadCount, 3);
    assert.equal(result[1].isReadOnly, false);

    // CRITICAL: Verify participant and member lists are strictly absent
    for (const group of result) {
        assert.strictEqual(group.participants, undefined, 'Must not expose participants');
        assert.strictEqual(group.groupMetadata, undefined, 'Must not expose groupMetadata');
        assert.strictEqual(group.members, undefined, 'Must not expose members');
    }

    // Handles empty or invalid inputs
    assert.deepEqual(filterGroupChats(null), []);
    assert.deepEqual(filterGroupChats([]), []);
    assert.deepEqual(filterGroupChats('invalid'), []);
});

test('validateGroupIds deduplicates, validates format, and handles multiple input types', () => {
    const { validateGroupIds } = require('../lib/groupUtils');

    // 1. Array input with duplicates and invalid IDs
    const arrInput = [
        '120363025111111111@g.us',
        '120363025111111111@g.us', // duplicate
        '120363025222222222@g.us',
        '919876543210@c.us',       // invalid (direct number, not group)
        'invalid_id',              // invalid
        'group@broadcast',         // invalid
        '',
        null,
    ];
    const res1 = validateGroupIds(arrInput);
    assert.deepEqual(res1.validIds, ['120363025111111111@g.us', '120363025222222222@g.us']);
    assert.equal(res1.duplicatesRemoved, 1);
    assert.equal(res1.invalidCount, 3);

    // 2. JSON array string input
    const jsonInput = '["120363025111111111@g.us", "120363025111111111@g.us", "120363025333333333@g.us"]';
    const res2 = validateGroupIds(jsonInput);
    assert.deepEqual(res2.validIds, ['120363025111111111@g.us', '120363025333333333@g.us']);
    assert.equal(res2.duplicatesRemoved, 1);
    assert.equal(res2.invalidCount, 0);

    // 3. Comma / newline separated string input
    const strInput = '120363025111111111@g.us, 120363025444444444@g.us\n120363025444444444@g.us';
    const res3 = validateGroupIds(strInput);
    assert.deepEqual(res3.validIds, ['120363025111111111@g.us', '120363025444444444@g.us']);
    assert.equal(res3.duplicatesRemoved, 1);

    // 4. Empty / invalid input
    assert.deepEqual(validateGroupIds(''), { validIds: [], duplicatesRemoved: 0, invalidCount: 0 });
    assert.deepEqual(validateGroupIds([]), { validIds: [], duplicatesRemoved: 0, invalidCount: 0 });
    assert.deepEqual(validateGroupIds(null), { validIds: [], duplicatesRemoved: 0, invalidCount: 0 });
});

test('confirmMessageSend confirms outgoing group message with @g.us remote JID', async () => {
    const EventEmitter = require('events');
    const mockClient = new EventEmitter();

    const targetGroupId = '120363025999999999@g.us';
    const messageText = 'Important Group Announcement';
    const sentAtSec = Math.floor(Date.now() / 1000);

    const mockDeliveredMsg = {
        id: { _serialized: 'true_120363025999999999@g.us_GRP123', remote: targetGroupId },
        fromMe: true,
        to: targetGroupId,
        body: messageText,
        timestamp: sentAtSec,
    };

    let sendMessageCallCount = 0;
    const sendMessageFn = async () => {
        sendMessageCallCount++;
        mockClient.emit('message_create', mockDeliveredMsg);
        return undefined; // simulate pinned web undefined return
    };

    const result = await confirmMessageSend({
        waClient: mockClient,
        chatId: targetGroupId,
        text: messageText,
        media: null,
        sentAtSec,
        sendMessageFn,
    });

    assert.ok(result !== null);
    assert.equal(result.id._serialized, 'true_120363025999999999@g.us_GRP123');
    assert.equal(sendMessageCallCount, 1, 'Must send exactly once to the group');
    assert.equal(mockClient.listenerCount('message_create'), 0, 'Listener must be cleaned up');
});

test('confirmMessageSend throws and does not retry when group message send fails without confirmation', async () => {
    const EventEmitter = require('events');
    const mockClient = new EventEmitter();

    const targetGroupId = '120363025999999999@g.us';
    const messageText = 'Failing Group Message';
    const sentAtSec = Math.floor(Date.now() / 1000);

    let sendCallCount = 0;
    const sendMessageFn = async () => {
        sendCallCount++;
        throw new Error('Evaluation failed: group admin restricted');
    };

    await assert.rejects(
        async () => {
            await confirmMessageSend({
                waClient: mockClient,
                chatId: targetGroupId,
                text: messageText,
                media: null,
                sentAtSec,
                sendMessageFn,
                verifyLastMessageFn: async () => null,
                verifyFetchMessagesFn: async () => null,
                messageCreateTimeoutMs: 50,
            });
        },
        /group admin restricted/
    );

    assert.equal(sendCallCount, 1, 'Must never blindly retry on failure');
    assert.equal(mockClient.listenerCount('message_create'), 0, 'Listener must be cleaned up on error');
});
