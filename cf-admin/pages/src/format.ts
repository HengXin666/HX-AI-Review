// Display helpers. Everything here is presentation only: no API field is renamed or reinterpreted.

/** USD with a fixed number of decimals, so a column of numbers keeps one width. */
export function usd(value: number, digits = 2): string {
    return "$" + value.toFixed(digits);
}

/** First 10 characters of a commit sha, which is what every other surface shows. */
export function shortSha(sha: string): string {
    return sha.slice(0, 10);
}

/** Run duration: seconds under a minute, minutes and seconds above it. */
export function duration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) {
        return "0s";
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
        return seconds.toFixed(1) + "s";
    }
    const minutes = Math.floor(seconds / 60);
    return minutes + "m " + Math.round(seconds - minutes * 60) + "s";
}

const TIME = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
});

/** Local date and time for a stored ISO timestamp; an unparsable value is shown as is. */
export function dateTime(iso: string | undefined): string {
    if (!iso) {
        return "-";
    }
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : TIME.format(at);
}

/** Token counts: exact under 10k, one decimal in thousands above it. */
export function tokens(value: number): string {
    return value < 10000 ? String(value) : (value / 1000).toFixed(1) + "k";
}
