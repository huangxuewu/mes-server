const MILITARY_PATTERN = /^([01]\d|2[0-3])([0-5]\d)$/;

const parseMilitaryTime = (value) => {
    const text = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
    if (!text) return null;

    if (MILITARY_PATTERN.test(text)) return text;

    const colonMatch = text.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
    if (colonMatch) {
        let hour = parseInt(colonMatch[1], 10);
        const minute = parseInt(colonMatch[2], 10);
        const meridiem = colonMatch[3];
        if (minute > 59) return null;
        if (meridiem) {
            if (hour < 1 || hour > 12) return null;
            if (meridiem === "pm" && hour !== 12) hour += 12;
            if (meridiem === "am" && hour === 12) hour = 0;
        } else if (hour > 23) return null;
        return `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
    }

    const ampmMatch = text.match(/^(\d{1,2})(am|pm)$/);
    if (ampmMatch) {
        let hour = parseInt(ampmMatch[1], 10);
        if (hour < 1 || hour > 12) return null;
        if (ampmMatch[2] === "pm" && hour !== 12) hour += 12;
        if (ampmMatch[2] === "am" && hour === 12) hour = 0;
        return `${String(hour).padStart(2, "0")}00`;
    }

    return null;
};

const formatMilitaryTime = (value, { compact = false } = {}) => {
    const military = parseMilitaryTime(value);
    if (!military) return String(value ?? "").trim();

    const hour = parseInt(military.slice(0, 2), 10);
    const minute = parseInt(military.slice(2), 10);
    const period = hour >= 12 ? (compact ? "p" : "pm") : (compact ? "a" : "am");
    const hour12 = hour % 12 || 12;

    return minute
        ? `${hour12}:${String(minute).padStart(2, "0")}${period}`
        : `${hour12}${period}`;
};

module.exports = {
    MILITARY_PATTERN,
    parseMilitaryTime,
    formatMilitaryTime,
};
