// BulkSender Client Logic (Production Ready)
// XSS-Safe rendering, 8-state connection manager, live preview, contact validation, opt-out management

// ─── Security: HTML Sanitizer ───
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Navigation ───
function navigateTo(page) {
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('page-' + page);
    if (target) target.classList.add('active');

    document.querySelectorAll('.sidebar-nav a').forEach(a => {
        a.classList.toggle('active', a.dataset.page === page);
    });

    if (page === 'history') loadHistory();
    if (page === 'settings') loadSettings();
    if (page === 'dashboard') refreshDashboard();
    if (page === 'send') updateSendWarning();
    if (page === 'optouts') loadOptOuts();
}

document.querySelectorAll('.sidebar-nav a').forEach(a => {
    a.addEventListener('click', e => {
        e.preventDefault();
        navigateTo(a.dataset.page);
    });
});

// ─── Toast Notifications ───
function showToast(msg, type = 'success') {
    const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'circle-exclamation' : 'circle-info';
    const color = type === 'success' ? 'var(--accent)' : type === 'error' ? 'var(--danger)' : 'var(--warning)';
    const el = document.createElement('div');
    el.className = 'toast-msg';
    el.innerHTML = `<i class="fas fa-${icon}" style="color:${color}"></i> <span>${escapeHtml(msg)}</span>`;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// ─── 8-State WhatsApp Connection Manager ───
let waConnected = false;
let currentWaState = 'disconnected';
let qrPollTimer = null;

const STATE_CONFIG = {
    disconnected: { label: 'Disconnected', badgeClass: 'disconnected', icon: 'circle', color: '#6b7280' },
    connecting: { label: 'Connecting...', badgeClass: 'connecting', icon: 'spinner fa-spin', color: '#f59e0b' },
    waiting_for_qr: { label: 'Waiting for QR...', badgeClass: 'waiting_for_qr', icon: 'hourglass-half', color: '#0ea5e9' },
    qr_available: { label: 'QR Available', badgeClass: 'qr_available', icon: 'qrcode', color: '#2563eb' },
    authenticated: { label: 'Authenticated', badgeClass: 'authenticated', icon: 'sync fa-spin', color: '#6366f1' },
    connected: { label: 'Connected', badgeClass: 'connected', icon: 'check-circle', color: '#16a34a' },
    reconnecting: { label: 'Reconnecting...', badgeClass: 'reconnecting', icon: 'arrows-rotate fa-spin', color: '#ea580c' },
    auth_failure: { label: 'Auth Failed', badgeClass: 'auth_failure', icon: 'triangle-exclamation', color: '#dc2626' },
};

function setConnectionStateUI(state, qrData = null, errorMsg = null, reconnectAttempts = 0) {
    currentWaState = state || 'disconnected';
    waConnected = (currentWaState === 'connected');

    const cfg = STATE_CONFIG[currentWaState] || STATE_CONFIG.disconnected;

    // Update Sidebar & Header Badges
    const sbStatus = document.getElementById('sidebarStatus');
    if (sbStatus) {
        sbStatus.innerHTML = `<small style="color:${cfg.color}; font-size:.75rem; font-weight:600;"><i class="fas fa-${cfg.icon}"></i> ${escapeHtml(cfg.label)}</small>`;
    }

    const navBadge = document.getElementById('navConnectBadge');
    if (navBadge) {
        navBadge.textContent = waConnected ? 'Online' : cfg.label;
        navBadge.style.background = cfg.color;
    }

    const headerBadge = document.getElementById('connectionBadgeHeader');
    if (headerBadge) {
        headerBadge.className = `state-badge ${cfg.badgeClass}`;
        headerBadge.innerHTML = `<i class="fas fa-${cfg.icon}"></i> ${escapeHtml(cfg.label)}`;
    }

    // Hide all state panels
    const statePanels = [
        'stateDisconnected', 'stateConnecting', 'stateWaitingQR',
        'stateQRAvailable', 'stateAuthenticated', 'stateConnected',
        'stateReconnecting', 'stateAuthFailure',
    ];
    statePanels.forEach(id => {
        const p = document.getElementById(id);
        if (p) p.style.display = 'none';
    });

    // Show appropriate panel
    if (currentWaState === 'disconnected') {
        const p = document.getElementById('stateDisconnected');
        if (p) p.style.display = 'block';
        const btn = document.getElementById('connectBtn');
        if (btn) btn.disabled = false;
    } else if (currentWaState === 'connecting') {
        const p = document.getElementById('stateConnecting');
        if (p) p.style.display = 'block';
    } else if (currentWaState === 'waiting_for_qr') {
        const p = document.getElementById('stateWaitingQR');
        if (p) p.style.display = 'block';
    } else if (currentWaState === 'qr_available') {
        const p = document.getElementById('stateQRAvailable');
        if (p) {
            p.style.display = 'block';
            if (qrData) {
                document.getElementById('qrImage').src = qrData;
            }
        }
    } else if (currentWaState === 'authenticated') {
        const p = document.getElementById('stateAuthenticated');
        if (p) p.style.display = 'block';
    } else if (currentWaState === 'connected') {
        const p = document.getElementById('stateConnected');
        if (p) p.style.display = 'block';
    } else if (currentWaState === 'reconnecting') {
        const p = document.getElementById('stateReconnecting');
        if (p) {
            p.style.display = 'block';
            const txt = document.getElementById('reconnectStatusText');
            if (txt) {
                txt.textContent = errorMsg || `Reconnecting attempt ${reconnectAttempts}/5...`;
            }
        }
    } else if (currentWaState === 'auth_failure') {
        const p = document.getElementById('stateAuthFailure');
        if (p) {
            p.style.display = 'block';
            const errEl = document.getElementById('authErrorMessage');
            if (errEl) {
                errEl.textContent = errorMsg || 'WhatsApp session expired or disconnected by phone. Please scan QR code again.';
            }
        }
    }

    updateSendWarning();
}

async function connectWA() {
    setConnectionStateUI('connecting');
    try {
        const resp = await fetch('/api/connect', { method: 'POST' });
        const data = await resp.json();
        setConnectionStateUI(data.state || 'connecting', null, data.error);
        startQrPoll();
        showToast(data.message || 'Connecting to WhatsApp...', 'info');
    } catch (e) {
        setConnectionStateUI('auth_failure', null, 'Failed to request connection: ' + e.message);
        showToast('Connection error: ' + e.message, 'error');
    }
}

async function disconnectWA() {
    try {
        await fetch('/api/disconnect', { method: 'POST' });
        setConnectionStateUI('disconnected');
        showToast('Disconnected from WhatsApp', 'info');
    } catch (e) {
        showToast('Disconnect error: ' + e.message, 'error');
    }
}

function startQrPoll() {
    if (qrPollTimer) clearInterval(qrPollTimer);
    qrPollTimer = setInterval(checkQrStatus, 2000);
    checkQrStatus();
}

async function checkQrStatus() {
    try {
        const resp = await fetch('/api/qr');
        const data = await resp.json();

        setConnectionStateUI(data.state, data.qr, data.error, data.reconnectAttempts);

        if (data.ready) {
            // Fully connected, slow down poll
            if (qrPollTimer) clearInterval(qrPollTimer);
            qrPollTimer = setInterval(checkQrStatus, 5000);
        } else if (data.state === 'auth_failure' || data.state === 'disconnected') {
            if (qrPollTimer) {
                clearInterval(qrPollTimer);
                qrPollTimer = null;
            }
        }
    } catch (e) {
        console.warn('QR poll error:', e);
    }
}

function updateSendWarning() {
    const warn = document.getElementById('sendWarning');
    if (warn) warn.style.display = waConnected ? 'none' : 'block';
}

// ─── File Uploads UI & Live Preview ───
document.getElementById('numbersFile').addEventListener('change', function() {
    if (this.files[0]) {
        document.getElementById('numFileName').textContent = this.files[0].name;
        document.getElementById('numUploadZone').classList.add('has-file');
        previewContacts();
    }
});

document.getElementById('numbersText').addEventListener('input', () => {
    debounce(previewContacts, 500)();
});

document.getElementById('messageFile').addEventListener('change', function() {
    const file = this.files[0];
    if (file) {
        document.getElementById('msgFileName').textContent = file.name;
        document.getElementById('msgUploadZone').classList.add('has-file');
        const reader = new FileReader();
        reader.onload = e => {
            document.getElementById('messageText').value = e.target.result;
            updateLivePreview();
        };
        reader.readAsText(file);
    }
});

document.getElementById('messageText').addEventListener('input', function() {
    document.getElementById('charCount').textContent = this.value.length;
    updateLivePreview();
});

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// ─── Live Chat Preview ───
function updateLivePreview() {
    const raw = document.getElementById('messageText').value || '';
    const previewEl = document.getElementById('liveMsgPreview');
    const timeEl = document.getElementById('livePreviewTime');

    if (!raw.trim()) {
        previewEl.innerHTML = `Type your message above to see preview... <span class="chat-time">${getFormattedTime()}</span>`;
        return;
    }

    // Replace spin syntax
    let rendered = raw.replace(/\{([^{}]+)\}/g, (match, group) => {
        const options = group.split('|');
        return options[0] || match;
    });

    // Replace template variables with sample values
    rendered = rendered
        .replace(/\{\{\s*name\s*\}\}/gi, 'John Doe')
        .replace(/\{\{\s*company\s*\}\}/gi, 'Acme Corp')
        .replace(/\{\{\s*order\s*\}\}/gi, '#12345')
        .replace(/\{\{\s*([^{}]+)\s*\}\}/g, '$1');

    previewEl.innerHTML = `${escapeHtml(rendered)} <span class="chat-time">${getFormattedTime()}</span>`;
}

function getFormattedTime() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
}

// ─── Contact Validation & Preview ───
async function previewContacts() {
    const form = document.getElementById('sendForm');
    const formData = new FormData(form);

    try {
        const resp = await fetch('/api/contacts/preview', { method: 'POST', body: formData });
        const data = await resp.json();

        if (data.error) {
            return;
        }

        const summaryCard = document.getElementById('contactPreviewSummary');
        summaryCard.style.display = 'block';

        document.getElementById('cpValid').textContent = `${data.validCount} Valid`;
        document.getElementById('cpDup').textContent = `${data.duplicateCount} Duplicates Removed`;
        document.getElementById('cpInvalid').textContent = `${data.invalidCount} Invalid`;
        document.getElementById('cpSuppressed').textContent = `${data.suppressedCount} Opted Out`;

        const listEl = document.getElementById('contactPreviewList');
        if (data.sample && data.sample.length > 0) {
            let html = '<div class="mt-1"><strong>Sample Valid Recipients:</strong></div>';
            data.sample.forEach(c => {
                const nameStr = c.name ? ` (${escapeHtml(c.name)})` : '';
                html += `<div>• +<code>${escapeHtml(c.number)}</code>${nameStr}</div>`;
            });
            if (data.validCount > data.sample.length) {
                html += `<div class="text-muted">+ ${data.validCount - data.sample.length} more</div>`;
            }
            listEl.innerHTML = html;
        } else {
            listEl.innerHTML = '<span class="text-danger">No valid phone numbers found in input.</span>';
        }
    } catch (e) {
        console.warn('Contact preview failed:', e);
    }
}

// ─── Media Upload ───
document.getElementById('mediaFile').addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
        showToast('File size exceeds 50MB limit', 'error');
        this.value = '';
        return;
    }

    document.getElementById('mediaFileName').textContent = file.name;
    document.getElementById('mediaUploadZone').classList.add('has-file');
    document.getElementById('mediaPreview').style.display = 'block';

    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    document.getElementById('mediaSize').textContent = `${file.name} (${sizeMB} MB)`;

    const url = URL.createObjectURL(file);
    document.getElementById('mediaPreviewImg').style.display = 'none';
    document.getElementById('mediaPreviewVid').style.display = 'none';
    document.getElementById('mediaPreviewDoc').style.display = 'none';

    if (file.type.startsWith('video/')) {
        const vid = document.getElementById('mediaPreviewVid');
        vid.style.display = 'inline-block';
        vid.src = url;
    } else if (file.type.startsWith('image/')) {
        const img = document.getElementById('mediaPreviewImg');
        img.style.display = 'inline-block';
        img.src = url;
    } else {
        document.getElementById('mediaPreviewDoc').style.display = 'inline-block';
    }
});

function clearMedia() {
    document.getElementById('mediaFile').value = '';
    document.getElementById('mediaFileName').textContent = 'Click to upload Image, Video, or Document';
    document.getElementById('mediaUploadZone').classList.remove('has-file');
    document.getElementById('mediaPreview').style.display = 'none';
}

// ─── Campaign Send Form ───
document.getElementById('sendForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    if (!waConnected) {
        showToast('Please connect WhatsApp first!', 'error');
        navigateTo('connect');
        return;
    }

    const btn = document.getElementById('sendBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing Campaign...';
    document.getElementById('cancelBtn').style.display = 'inline-block';

    try {
        const resp = await fetch('/api/send', { method: 'POST', body: new FormData(this) });
        const data = await resp.json();

        if (data.error) {
            showToast(data.error, 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="fab fa-whatsapp"></i> Start Campaign';
            document.getElementById('cancelBtn').style.display = 'none';
            return;
        }

        showToast(data.message || `Started sending to ${data.total} contacts...`, 'info');
        document.getElementById('sendProgress').style.display = 'block';
        document.getElementById('sendLogs').style.display = 'block';
        document.getElementById('liveProgress').style.display = 'block';
        document.getElementById('spTotal').textContent = data.total;
        startStatusPoll();
    } catch (err) {
        showToast('Send request failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fab fa-whatsapp"></i> Start Campaign';
        document.getElementById('cancelBtn').style.display = 'none';
    }
});

async function cancelSending() {
    await fetch('/api/cancel', { method: 'POST' });
    showToast('Cancellation requested. Halting queue...', 'info');
}

let statusTimer = null;
function startStatusPoll() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(fetchStatus, 1500);
}

async function fetchStatus() {
    try {
        const resp = await fetch('/api/status');
        const data = await resp.json();
        const done = (data.sent || 0) + (data.failed || 0);
        const total = data.total || 0;
        const pct = total ? Math.round((done / total) * 100) : 0;

        document.getElementById('spSent').textContent = data.sent || 0;
        document.getElementById('spFailed').textContent = data.failed || 0;
        document.getElementById('spPending').textContent = data.pending || 0;
        document.getElementById('spTotal').textContent = total;
        document.getElementById('spBar').style.width = pct + '%';
        document.getElementById('sendProgressCount').textContent = `${done}/${total}`;
        document.getElementById('liveBar').style.width = pct + '%';
        document.getElementById('liveCount').textContent = `${done}/${total}`;

        if (data.isSending) {
            document.getElementById('spText').textContent = `Sending... ${done} of ${total} processed (${pct}%)`;
            document.getElementById('liveText').textContent = `Processing message ${done + 1} of ${total}...`;
        } else if (done > 0 || total > 0) {
            document.getElementById('spText').textContent = `Completed: ${data.sent} sent, ${data.failed} failed`;
            document.getElementById('liveProgress').style.display = 'none';
            clearInterval(statusTimer);
            statusTimer = null;

            const btn = document.getElementById('sendBtn');
            btn.disabled = false;
            btn.innerHTML = '<i class="fab fa-whatsapp"></i> Start Campaign';
            document.getElementById('cancelBtn').style.display = 'none';
            showToast(`Campaign finished: ${data.sent} delivered, ${data.failed} failed`);
            refreshDashboard();
        }
        updateSendLogs(data.logs || []);
    } catch (e) {}
}

function getDeliveryBadge(status) {
    const map = {
        pending: { cls: 'badge-pending', icon: 'clock', label: 'Pending' },
        sent: { cls: 'badge-sent', icon: 'check', label: 'Sent' },
        delivered: { cls: 'badge-delivered', icon: 'check-double', label: 'Delivered' },
        read: { cls: 'badge-read', icon: 'eye', label: 'Read' },
    };
    const s = map[status] || map.pending;
    return `<span class="badge-status ${s.cls}"><i class="fas fa-${s.icon}"></i> ${escapeHtml(s.label)}</span>`;
}

function updateSendLogs(logs) {
    const tbody = document.getElementById('sendLogsBody');
    tbody.innerHTML = '';
    logs.forEach((log, i) => {
        const cls = log.status === 'sent' ? 'badge-sent' : log.status === 'failed' ? 'badge-failed' : 'badge-sending';
        const icon = log.status === 'sent' ? 'check-circle' : log.status === 'failed' ? 'circle-xmark' : 'clock';
        const mediaIcon = log.hasMedia ? '<i class="fas fa-paperclip" style="color:var(--accent);margin-left:4px;"></i>' : '';
        const delivery = log.status === 'sent' ? getDeliveryBadge(log.deliveryStatus) : '-';

        tbody.innerHTML += `<tr>
            <td>${i + 1}</td>
            <td><code>${escapeHtml(log.number)}</code></td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(log.message)}${mediaIcon}</td>
            <td><span class="badge-status ${cls}"><i class="fas fa-${icon}"></i> ${escapeHtml(log.status)}</span></td>
            <td>${delivery}</td>
            <td><small>${escapeHtml(log.timestamp)}</small></td>
        </tr>`;
    });
}

async function clearCurrentLogs() {
    await fetch('/api/clear-logs', { method: 'POST' });
    document.getElementById('sendLogsBody').innerHTML = '';
    showToast('Logs cleared');
}

// ─── Dashboard Activity ───
let dashFilter = 'all';
let dashHistoryCache = [];

function setDashFilter(filter) {
    dashFilter = filter;
    document.querySelectorAll('.filter-pill[data-filter]').forEach(b => {
        b.classList.toggle('active', b.dataset.filter === filter);
    });
    document.querySelectorAll('.stat-clickable').forEach(c => {
        c.classList.toggle('active', c.dataset.filter === filter);
    });
    const titleMap = { all: 'Recent Activity', sent: 'Sent Messages', failed: 'Failed Messages' };
    document.getElementById('recentTitle').textContent = titleMap[filter] || 'Recent Activity';
    renderRecentLogs();
}

function renderRecentLogs() {
    let filtered = dashHistoryCache;
    if (dashFilter === 'sent') filtered = filtered.filter(h => h.status === 'sent');
    else if (dashFilter === 'failed') filtered = filtered.filter(h => h.status === 'failed');

    const recent = filtered.slice(-15).reverse();
    const tbody = document.getElementById('recentLogs');
    tbody.innerHTML = '';

    if (recent.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><i class="fas fa-inbox"></i><br>No messages yet</div></td></tr>`;
        return;
    }

    recent.forEach(log => {
        const cls = log.status === 'sent' ? 'badge-sent' : 'badge-failed';
        const errorTip = log.error ? ` title="${escapeHtml(log.error)}"` : '';
        tbody.innerHTML += `<tr${errorTip}><td><code>${escapeHtml(log.number)}</code></td><td><span class="badge-status ${cls}">${escapeHtml(log.status)}</span></td><td><small>${escapeHtml(log.timestamp)}</small></td></tr>`;
    });
}

async function refreshDashboard() {
    try {
        const resp = await fetch('/api/history');
        dashHistoryCache = await resp.json();

        const sent = dashHistoryCache.filter(h => h.status === 'sent').length;
        const failed = dashHistoryCache.filter(h => h.status === 'failed').length;
        const total = dashHistoryCache.length;
        const rate = total > 0 ? Math.round((sent / total) * 100) : 0;

        document.getElementById('dashSent').textContent = sent;
        document.getElementById('dashFailed').textContent = failed;
        document.getElementById('dashTotal').textContent = total;
        document.getElementById('dashRate').textContent = rate + '%';

        renderRecentLogs();
    } catch (e) {}

    checkQrStatus();
}

// ─── History ───
let histFilter = 'all';
let histCache = [];

function setHistFilter(filter) {
    histFilter = filter;
    document.querySelectorAll('.filter-pill[data-hist-filter]').forEach(b => {
        b.classList.toggle('active', b.dataset.histFilter === filter);
    });
    renderHistory();
}

function renderHistory() {
    const search = (document.getElementById('histSearch')?.value || '').toLowerCase().trim();
    let filtered = histCache.slice();

    if (histFilter === 'sent') filtered = filtered.filter(h => h.status === 'sent');
    else if (histFilter === 'failed') filtered = filtered.filter(h => h.status === 'failed');
    else if (histFilter === 'delivered') filtered = filtered.filter(h => h.deliveryStatus === 'delivered' || h.deliveryStatus === 'read');
    else if (histFilter === 'read') filtered = filtered.filter(h => h.deliveryStatus === 'read');

    if (search) {
        filtered = filtered.filter(h =>
            (h.number || '').toLowerCase().includes(search) ||
            (h.message || '').toLowerCase().includes(search)
        );
    }

    const tbody = document.getElementById('historyBody');
    tbody.innerHTML = '';

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fas fa-magnifying-glass"></i><br>No messages match this filter</div></td></tr>`;
        return;
    }

    filtered.slice().reverse().forEach((log, i) => {
        const cls = log.status === 'sent' ? 'badge-sent' : 'badge-failed';
        const delivery = log.status === 'sent' ? getDeliveryBadge(log.deliveryStatus) : '-';
        tbody.innerHTML += `<tr>
            <td>${i + 1}</td>
            <td><code>${escapeHtml(log.number)}</code></td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(log.fullMessage || log.message || '')}">${escapeHtml(log.message)}</td>
            <td><span class="badge-status ${cls}">${escapeHtml(log.status)}</span></td>
            <td>${delivery}</td>
            <td><small style="color:var(--danger);">${escapeHtml(log.error || '-')}</small></td>
            <td><small>${escapeHtml(log.timestamp)}</small></td>
        </tr>`;
    });
}

function updateHistCounts() {
    const sent = histCache.filter(h => h.status === 'sent').length;
    const failed = histCache.filter(h => h.status === 'failed').length;
    const delivered = histCache.filter(h => h.deliveryStatus === 'delivered' || h.deliveryStatus === 'read').length;
    const read = histCache.filter(h => h.deliveryStatus === 'read').length;
    document.getElementById('histCountAll').textContent = histCache.length;
    document.getElementById('histCountSent').textContent = sent;
    document.getElementById('histCountFailed').textContent = failed;
    document.getElementById('histCountDelivered').textContent = delivered;
    document.getElementById('histCountRead').textContent = read;
}

async function loadHistory() {
    const resp = await fetch('/api/history');
    histCache = await resp.json();
    updateHistCounts();
    renderHistory();
}

async function clearAllHistory() {
    if (!confirm('Are you sure you want to clear all message history? This action cannot be undone.')) return;
    await fetch('/api/history/clear', { method: 'POST' });
    histCache = [];
    updateHistCounts();
    renderHistory();
    showToast('History cleared');
    refreshDashboard();
}

function exportHistory() {
    window.location.href = '/api/history/export';
}

// ─── Opt-Out Suppression Management ───
async function loadOptOuts() {
    try {
        const resp = await fetch('/api/optouts');
        const list = await resp.json();
        const tbody = document.getElementById('optOutsTableBody');
        const countEl = document.getElementById('optOutCount');
        countEl.textContent = list.length;
        tbody.innerHTML = '';

        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><i class="fas fa-shield-check"></i><br>No opted-out numbers yet</div></td></tr>`;
            return;
        }

        list.forEach(item => {
            tbody.innerHTML += `<tr>
                <td><code>+${escapeHtml(item.number)}</code></td>
                <td><small>${escapeHtml(item.timestamp)}</small></td>
                <td><span class="badge bg-secondary">${escapeHtml(item.reason)}</span></td>
                <td><button class="btn btn-sm btn-outline-danger" onclick="removeOptOut('${escapeHtml(item.number)}')"><i class="fas fa-trash"></i> Remove</button></td>
            </tr>`;
        });
    } catch (e) {
        console.warn('Load opt-outs error:', e);
    }
}

async function addManualOptOut(e) {
    e.preventDefault();
    const input = document.getElementById('manualOptOutNumber');
    const num = input.value.trim();
    if (!num) return;

    try {
        const resp = await fetch('/api/optouts/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number: num, reason: 'Manually added via dashboard' }),
        });
        const data = await resp.json();
        if (data.success) {
            input.value = '';
            showToast(`Number ${num} recorded in suppression list`);
            loadOptOuts();
        } else {
            showToast(data.error || 'Failed to record opt-out', 'error');
        }
    } catch (err) {
        showToast('Failed to record opt-out: ' + err.message, 'error');
    }
}

async function removeOptOut(number) {
    if (!confirm(`Allow messages to be sent to +${number} again?`)) return;
    try {
        await fetch('/api/optouts/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number }),
        });
        showToast(`Number +${number} unblocked`);
        loadOptOuts();
    } catch (e) {
        showToast('Error removing opt-out', 'error');
    }
}

// ─── Settings ───
async function loadSettings() {
    try {
        const resp = await fetch('/api/settings');
        const s = await resp.json();
        document.getElementById('setPort').value = s.port;
        document.getElementById('setDelayMin').value = s.delayMin;
        document.getElementById('setDelayMax').value = s.delayMax;
        document.getElementById('setBatchSize').value = s.batchSize;
        document.getElementById('setBatchCooldown').value = s.batchCooldown;
    } catch (e) {}
}

document.getElementById('settingsForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const payload = {
        port: parseInt(document.getElementById('setPort').value, 10),
        delayMin: parseInt(document.getElementById('setDelayMin').value, 10),
        delayMax: parseInt(document.getElementById('setDelayMax').value, 10),
        batchSize: parseInt(document.getElementById('setBatchSize').value, 10),
        batchCooldown: parseInt(document.getElementById('setBatchCooldown').value, 10),
    };

    const resp = await fetch('/api/settings/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.success) {
        showToast(data.message);
    } else {
        showToast(data.error || 'Failed to save settings', 'error');
    }
});

// ─── Quit Application ───
async function quitApp() {
    if (!confirm('Quit BulkSender?\n\nThis will safely disconnect WhatsApp and stop the background server.')) return;

    try {
        await fetch('/api/quit', { method: 'POST' });
    } catch (e) {}

    document.body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:Inter,sans-serif;background:#f0f2f5;text-align:center;padding:20px;">
            <i class="fab fa-whatsapp" style="font-size:4rem;color:#25D366;margin-bottom:20px;"></i>
            <h2 style="font-weight:700;color:#1a1d23;">BulkSender Shut Down Safely</h2>
            <p style="color:#6b7280;max-width:400px;">WhatsApp session saved and server closed. You can close this window.</p>
            <p style="color:#6b7280;font-size:.85rem;margin-top:20px;">To restart BulkSender, launch it from your desktop shortcut or run.bat.</p>
        </div>
    `;
}

// ─── Initial Startup Check ───
refreshDashboard();
startQrPoll();
updateLivePreview();
