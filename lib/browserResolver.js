// lib/browserResolver.js
// Resolves the Chromium/Chrome executable on Windows and other platforms

const fs = require('fs');
const path = require('path');

function findExecutableInDir(dir, maxDepth = 4, currentDepth = 0) {
    if (!dir || currentDepth > maxDepth || !fs.existsSync(dir)) return null;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile()) {
                const lower = entry.name.toLowerCase();
                if (lower === 'chrome.exe' || lower === 'msedge.exe' || lower === 'chromium.exe') {
                    return fullPath;
                }
            } else if (entry.isDirectory()) {
                const found = findExecutableInDir(fullPath, maxDepth, currentDepth + 1);
                if (found) return found;
            }
        }
    } catch (e) {}
    return null;
}

function resolveBrowserExecutable(appRoot = process.cwd()) {
    // 1. Explicit environment variable override
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return { path: process.env.PUPPETEER_EXECUTABLE_PATH, source: 'PUPPETEER_EXECUTABLE_PATH' };
    }

    // 2. Puppeteer native resolution
    try {
        const puppeteer = require('puppeteer');
        const pPath = puppeteer.executablePath();
        if (pPath && fs.existsSync(pPath)) {
            return { path: pPath, source: 'puppeteer_default' };
        }
    } catch (e) {}

    // 3. Local bundled cache in project (.puppeteer-cache)
    const localCache = path.join(appRoot, '.puppeteer-cache');
    const localExe = findExecutableInDir(localCache);
    if (localExe) {
        return { path: localExe, source: 'bundled_project_cache' };
    }

    // 4. User profile cache (~/.cache/puppeteer)
    if (process.env.USERPROFILE) {
        const userCache = path.join(process.env.USERPROFILE, '.cache', 'puppeteer');
        const userExe = findExecutableInDir(userCache);
        if (userExe) {
            return { path: userExe, source: 'user_profile_cache' };
        }
    }

    // 5. System Google Chrome paths on Windows
    const systemChromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    ].filter(Boolean);

    for (const p of systemChromePaths) {
        if (fs.existsSync(p)) {
            return { path: p, source: 'system_chrome' };
        }
    }

    // 6. Microsoft Edge fallback on Windows (Chromium-based)
    const edgePaths = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    ].filter(Boolean);

    for (const p of edgePaths) {
        if (fs.existsSync(p)) {
            return { path: p, source: 'system_edge_fallback' };
        }
    }

    return null;
}

module.exports = {
    resolveBrowserExecutable,
    findExecutableInDir,
};
