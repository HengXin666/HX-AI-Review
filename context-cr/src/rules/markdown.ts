const FENCE = /^(`{3,}|~{3,})/;

/**
 * Strip fenced blocks so examples never count as links or headings; line numbers are preserved.
 * A fence closes only with the same character at least as long as its opener.
 */
export function withoutFences(text: string): string {
    let open: string | undefined;
    return text
        .split(/\r?\n/)
        .map((line) => {
            const marker = FENCE.exec(line.trim())?.[1];
            if (!open && marker) {
                open = marker;
                return "";
            }
            if (open) {
                const closes =
                    marker && marker[0] === open[0] && marker.length >= open.length && line.trim() === marker;
                if (closes) {
                    open = undefined;
                }
                return "";
            }
            return line;
        })
        .join("\n");
}

export type Heading = { level: number; line: number };

/** ATX headings outside fenced blocks, in file order. */
export function headings(text: string): Heading[] {
    const result: Heading[] = [];
    withoutFences(text)
        .split("\n")
        .forEach((line, index) => {
            const match = /^(#{1,6})\s+\S/.exec(line);
            if (match) {
                result.push({ level: match[1].length, line: index + 1 });
            }
        });
    return result;
}
