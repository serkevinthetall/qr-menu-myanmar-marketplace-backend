export function normalizeMyanmarPhone(number) {
    if (!number) {
        return '';
    }
    let clean = '';
    const raw = String(number);
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if ((ch >= '0' && ch <= '9') || ch === '+') {
            clean += ch;
        }
    }
    if (clean.startsWith('+959')) {
        clean = `09${clean.substring(4)}`;
    }
    else if (clean.startsWith('959')) {
        clean = `09${clean.substring(3)}`;
    }
    else if (clean.startsWith('+950')) {
        clean = `0${clean.substring(4)}`;
    }
    else if (clean.startsWith('950')) {
        clean = `0${clean.substring(3)}`;
    }
    return clean;
}
export function lastPhoneDigits(phone, count) {
    const normalized = normalizeMyanmarPhone(phone);
    if (normalized.length <= count) {
        return normalized;
    }
    return normalized.substring(normalized.length - count);
}
export function validateMyanmarPhone(number, fieldName = 'Phone number') {
    if (!number) {
        throw new Error(`${fieldName} is required.`);
    }
    const phone = normalizeMyanmarPhone(number);
    if (phone.startsWith('+95')) {
        throw new Error(`${fieldName} must use Myanmar local format starting with 0, not +95.`);
    }
    if (!/^[0-9]+$/.test(phone)) {
        throw new Error(`${fieldName} must contain digits only.`);
    }
    if (!phone.startsWith('0')) {
        throw new Error(`${fieldName} must start with 0.`);
    }
    if (phone.length < 8) {
        throw new Error(`${fieldName} must be at least 8 digits.`);
    }
    return phone;
}
export function splitTagNames(tagText) {
    return String(tagText || '')
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);
}
