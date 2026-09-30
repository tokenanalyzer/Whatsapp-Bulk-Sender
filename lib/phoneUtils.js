// lib/phoneUtils.js
// Robust phone number parsing, normalization, validation, deduplication, and template rendering

const fs = require('fs');
const xlsx = require('xlsx');

/**
 * Normalizes a raw phone number string into E.164-compatible digit string without '+'
 * @param {string|number} raw
 * @param {string} defaultCountryCode (optional, e.g. "91")
 * @returns {{ valid: boolean, formatted: string, raw: string, error?: string }}
 */
function normalizePhoneNumber(raw, defaultCountryCode = '') {
    if (raw === undefined || raw === null) {
        return { valid: false, formatted: '', raw: '', error: 'Empty number' };
    }

    const originalStr = String(raw).trim();
    if (!originalStr) {
        return { valid: false, formatted: '', raw: '', error: 'Empty number' };
    }

    let str = originalStr;

    // Handle excel float formatting (e.g. 919876543210.0)
    if (str.endsWith('.0')) {
        str = str.slice(0, -2);
    }

    // Strip leading international prefix 00
    if (str.startsWith('00')) {
        str = str.slice(2);
    }

    // Strip all non-digit characters except leading plus
    let digitsOnly = str.replace(/[^\d+]/g, '');
    if (digitsOnly.startsWith('+')) {
        digitsOnly = digitsOnly.slice(1);
    }

    // Strip leading zero if defaultCountryCode is provided and number looks like local trunk number
    // e.g. UK 07123456789 with country code 44 -> 447123456789
    // e.g. India 09876543210 with country code 91 -> 919876543210
    const cleanDefaultCC = String(defaultCountryCode || '').replace(/\D/g, '');
    if (cleanDefaultCC) {
        if (digitsOnly.startsWith('0') && !digitsOnly.startsWith(cleanDefaultCC)) {
            digitsOnly = cleanDefaultCC + digitsOnly.slice(1);
        } else if (digitsOnly.length === 10 && !digitsOnly.startsWith(cleanDefaultCC)) {
            // Standard 10-digit mobile number missing country code
            digitsOnly = cleanDefaultCC + digitsOnly;
        }
    }

    // Validate length: E.164 requires 7 to 15 digits
    if (!/^\d{7,15}$/.test(digitsOnly)) {
        return {
            valid: false,
            formatted: digitsOnly,
            raw: originalStr,
            error: `Invalid length (${digitsOnly.length} digits). Standard is 7-15 digits.`,
        };
    }

    return {
        valid: true,
        formatted: digitsOnly,
        raw: originalStr,
    };
}

/**
 * Parses contacts from a text string, CSV, or Excel file
 * Returns structured contact records with variable metadata
 * @param {string} contentOrPath
 * @param {string} fileExt (e.g. '.csv', '.xlsx', '.txt')
 * @param {object} options { defaultCountryCode: string }
 */
function parseContacts(contentOrPath, fileExt = '.txt', options = {}) {
    const defaultCC = options.defaultCountryCode || '';
    const ext = (fileExt || '').toLowerCase();
    const rows = [];

    if (ext === '.txt') {
        const text = fs.existsSync(contentOrPath)
            ? fs.readFileSync(contentOrPath, 'utf-8')
            : String(contentOrPath || '');
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Support tab or comma separated format in txt: phone,name
            const parts = trimmed.split(/[\t,]/);
            const num = parts[0].trim();
            const name = parts[1] ? parts[1].trim() : '';
            rows.push({
                phoneRaw: num,
                name: name,
                variables: name ? { name, Name: name } : {},
            });
        }
    } else if (ext === '.csv' || ext === '.xlsx' || ext === '.xls') {
        let workbook;
        if (fs.existsSync(contentOrPath)) {
            workbook = xlsx.readFile(contentOrPath, { cellDates: false, raw: false });
        } else if (Buffer.isBuffer(contentOrPath)) {
            workbook = xlsx.read(contentOrPath, { type: 'buffer' });
        } else {
            throw new Error(`File not found: ${contentOrPath}`);
        }

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) {
            return { contacts: [], invalid: [], duplicates: [], totalRows: 0 };
        }

        const rawData = xlsx.utils.sheet_to_json(sheet, { defval: '' });
        if (rawData.length === 0) {
            return { contacts: [], invalid: [], duplicates: [], totalRows: 0 };
        }

        // Detect phone column
        const sampleRow = rawData[0];
        const cols = Object.keys(sampleRow);
        let phoneCol = cols.find(c => /phone|number|mobile|contact|whatsapp|tel/i.test(c));

        if (!phoneCol) {
            // Find column with most numeric values
            let maxNumericCount = -1;
            for (const col of cols) {
                const numericCount = rawData.slice(0, 10).filter(r => /^\+?[\d\s\-().]{7,}$/.test(String(r[col] || '').trim())).length;
                if (numericCount > maxNumericCount) {
                    maxNumericCount = numericCount;
                    phoneCol = col;
                }
            }
        }
        if (!phoneCol) phoneCol = cols[0];

        // Detect name column
        const nameCol = cols.find(c => /name|first\s*name|contact\s*name/i.test(c));

        for (const row of rawData) {
            const phoneVal = row[phoneCol];
            if (phoneVal === undefined || phoneVal === null || String(phoneVal).trim() === '') {
                continue; // skip completely empty phone rows
            }

            const nameVal = nameCol && row[nameCol] ? String(row[nameCol]).trim() : '';
            const variables = {};
            for (const key of Object.keys(row)) {
                if (row[key] !== undefined && row[key] !== null) {
                    const cleanVal = String(row[key]).trim();
                    variables[key] = cleanVal;
                    variables[key.toLowerCase()] = cleanVal;
                }
            }
            if (nameVal && !variables.name) {
                variables.name = nameVal;
                variables.Name = nameVal;
            }

            rows.push({
                phoneRaw: String(phoneVal).trim(),
                name: nameVal,
                variables,
            });
        }
    }

    // Now normalize, validate, and deduplicate
    const contacts = [];
    const invalid = [];
    const duplicates = [];
    const seenNumbers = new Set();

    for (let i = 0; i < rows.length; i++) {
        const item = rows[i];
        const norm = normalizePhoneNumber(item.phoneRaw, defaultCC);

        if (!norm.valid) {
            invalid.push({
                rowIndex: i + 1,
                raw: item.phoneRaw,
                error: norm.error || 'Invalid phone format',
            });
            continue;
        }

        if (seenNumbers.has(norm.formatted)) {
            duplicates.push({
                rowIndex: i + 1,
                formatted: norm.formatted,
                raw: item.phoneRaw,
            });
            continue;
        }

        seenNumbers.add(norm.formatted);
        contacts.push({
            number: norm.formatted,
            chatId: `${norm.formatted}@c.us`,
            name: item.name || '',
            variables: item.variables || {},
            raw: item.phoneRaw,
        });
    }

    return {
        contacts,
        invalid,
        duplicates,
        totalRows: rows.length,
    };
}

/**
 * Resolves spin syntax: {Hi|Hello|Hey} -> picks one randomly
 */
function processSpinSyntax(text) {
    if (!text) return '';
    return text.replace(/\{([^{}]+)\}/g, (match, group) => {
        const options = group.split('|');
        if (options.length > 1) {
            return options[Math.floor(Math.random() * options.length)];
        }
        return match;
    });
}

/**
 * Resolves template variables: {{Name}} or {{name}}
 */
function processTemplateVars(text, vars = {}) {
    if (!text) return '';
    return text.replace(/\{\{([^{}]+)\}\}/g, (match, key) => {
        const cleanKey = key.trim();
        if (vars[cleanKey] !== undefined) return vars[cleanKey];
        if (vars[cleanKey.toLowerCase()] !== undefined) return vars[cleanKey.toLowerCase()];
        return match;
    });
}

module.exports = {
    normalizePhoneNumber,
    parseContacts,
    processSpinSyntax,
    processTemplateVars,
};
