import { COMMENT_MARKER, DETAIL_LIMIT, TOOL_NAME, TOOL_VERSION } from "../constants.ts";
import { escapeMd } from "../contract/report.ts";
import type { ReviewReport } from "../contract/report.ts";

export type CommentLinks = { patchUrl?: string; overviewUrl?: string; runUrl?: string };

/**
 * Visual identity for the PR comment. Every badge is an inline SVG data URI so the comment renders the
 * same on github.com, in mail, and offline: no external host can go down, and no request leaks the
 * repository name to a third party. Each badge carries a dark and a light variant because GitHub
 * switches themes with prefers-color-scheme, and one fixed colour vanishes on one of them.
 */
const COLORS = {
    good: { dark: "#3fb950", light: "#1a7f37" },
    warn: { dark: "#d29922", light: "#9a6700" },
    bad: { dark: "#f85149", light: "#cf222e" },
} as const;

type Tone = keyof typeof COLORS;

const FONT = "-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif";

/** Grade letters map onto three tones so the badge colour alone carries the severity. */
function gradeOf(report: ReviewReport): { letter: string; tone: Tone } {
    if (report.counts.blocking > 0 || report.counts.error > 0) {
        return { letter: report.counts.blocking > 0 ? "F" : "D", tone: "bad" };
    }
    if (report.counts.warning === 0) {
        return { letter: "A", tone: "good" };
    }
    return { letter: report.counts.warning <= 3 ? "B" : "C", tone: "warn" };
}

/**
 * Findings come from a model reading an untrusted repository, and this string lands in raw HTML rather
 * than Markdown, so every angle bracket and quote has to be neutralised: escapeMd only handles Markdown
 * metacharacters and would let a finding inject an img with an onerror handler.
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Wrap two SVG data URIs in a picture element so the client picks the variant matching its theme.
 * GitHub strips svg elements out of comments but keeps img, so the artwork has to travel as a data URI
 * on an img rather than as inline markup.
 */
function picture(darkSvg: string, lightSvg: string, alt: string, width: number, height: number): string {
    // Percent-encoding keeps the SVG readable in the raw comment and avoids a base64 dependency; only
    // the characters that would end the attribute or confuse the data URI parser need escaping.
    const uri = (svg: string) =>
        "data:image/svg+xml," +
        svg
            .replace(/%/g, "%25")
            .replace(/#/g, "%23")
            .replace(/</g, "%3C")
            .replace(/>/g, "%3E")
            .replace(/"/g, "%22")
            .replace(/\n/g, "");
    return (
        "<picture>" +
        `<source media="(prefers-color-scheme: dark)" srcset="${uri(darkSvg)}"/>` +
        `<img src="${uri(lightSvg)}" width="${width}" height="${height}" alt="${escapeHtml(alt)}"/>` +
        "</picture>"
    );
}

/** A rounded grade chip. The glyph is a text node, so it stays crisp without any font subsetting. */
function gradeSvg(letter: string, tone: Tone): string {
    const color = COLORS[tone];
    const svg = (fill: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="20" viewBox="0 0 64 20">` +
        `<rect width="64" height="20" rx="10" fill="${fill}" opacity="0.16"/>` +
        `<rect x="0.5" y="0.5" width="63" height="19" rx="9.5" fill="none" stroke="${fill}" stroke-opacity="0.45"/>` +
        `<text x="32" y="14" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${fill}">${letter}</text>` +
        "</svg>";
    return picture(svg(color.dark), svg(color.light), `等级 ${letter}`, 64, 20);
}

/** A filled counter pill. Width follows the digit count so a two-digit count never clips. */
function countSvg(value: number, tone: Tone, label: string): string {
    const color = COLORS[tone];
    const width = Math.max(34, 20 + String(value).length * 8);
    const svg = (fill: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20">` +
        `<rect width="${width}" height="20" rx="10" fill="${fill}" opacity="0.16"/>` +
        `<text x="${width / 2}" y="14" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${fill}">${value}</text>` +
        "</svg>";
    return picture(svg(color.dark), svg(color.light), `${label} ${value}`, width, 20);
}

/** A text pill for a severity name. Width follows the label so "warning" is not clipped to "w". */
function labelSvg(text: string, tone: Tone): string {
    const color = COLORS[tone];
    const width = 14 + text.length * 6.2;
    const svg = (fill: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20">` +
        `<rect width="${width}" height="20" rx="10" fill="${fill}" opacity="0.16"/>` +
        `<text x="${width / 2}" y="14" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${fill}">${text}</text>` +
        "</svg>";
    return picture(svg(color.dark), svg(color.light), text, Math.round(width), 20);
}

/** One summary row: label, badge, and the plain number so it survives a client that drops images. */
function metricRow(label: string, value: number, tone: Tone, note: string): string {
    return `<tr><td><strong>${label}</strong></td><td align="right">${countSvg(value, tone, label)} ${value}</td><td>${note}</td></tr>`;
}

/**
 * The PR comment. Structure first, colour second: a reader without images still gets every number, and
 * a reader without Markdown still gets a legible table.
 */
export function renderComment(report: ReviewReport, links: CommentLinks, note?: string): string {
    const grade = gradeOf(report);
    const kindLabel = report.kind === "code" ? "代码 CR" : "上下文 CR";
    const scope =
        report.kind === "code"
            ? "审 diff 新增与修改的行: 逻辑错误, 边界条件, 错误处理, 并发与资源, 安全边界"
            : "审 AGENTS.md / README.md / docs 是否与代码一致";
    const range = report.base && report.head ? `${report.base.slice(0, 7)}...${report.head.slice(0, 7)}` : "";
    const verdict = report.counts.blocking
        ? `${report.counts.blocking} 个阻断错误`
        : report.counts.error
          ? `${report.counts.error} 个错误`
          : report.findings.length
            ? `${report.counts.warning} 个告警, 无阻断`
            : "无发现";

    const out: string[] = [COMMENT_MARKER];
    out.push(
        `<h3>${gradeSvg(grade.letter, grade.tone)} ${TOOL_NAME} · ${kindLabel}</h3>`,
        "",
        `<p>${escapeHtml(scope)}${range ? ` · <code>${escapeHtml(range)}</code>` : ""}</p>`,
        "",
    );
    if (note) {
        out.push(`> ${escapeMd(note)}`, "");
    }
    // Note stays Markdown (it is operator text in a blockquote); findings are HTML table cells and are
    // escaped by escapeHtml at the point they are interpolated.

    // Report card: the same four figures the hosted overview shows, so the two never disagree.
    out.push(
        "<table>",
        "<tr>",
        `<td valign="top"><strong>结论</strong><br/><br/>${escapeHtml(verdict)}</td>`,
        `<td valign="top"><strong>发现</strong><br/><br/>${report.findings.length} 条 / ${new Set(report.findings.map((item) => item.ruleId)).size} 个规则</td>`,
        `<td valign="top"><strong>耗时</strong><br/><br/>${(report.durationMs / 1000).toFixed(1)}s</td>`,
        `<td valign="top"><strong>用量</strong><br/><br/>${report.usage.input + report.usage.output} tokens</td>`,
        "</tr>",
        "</table>",
        "",
        "<table>",
        '<tr><th align="left">等级</th><th align="right">数量</th><th align="left">说明</th></tr>',
        metricRow("Error", report.counts.error, report.counts.error ? "bad" : "good", "只来自 L0 确定性检查"),
        metricRow("Warning", report.counts.warning, report.counts.warning ? "warn" : "good", "AI 阶段产出"),
        metricRow("阻断", report.counts.blocking, report.counts.blocking ? "bad" : "good", "只有 new Error 阻断"),
        "</table>",
        "",
    );

    // Findings: inline detail up to the display limit, counts beyond it, exactly as the MD report does.
    if (report.findings.length === 0) {
        out.push(`<p>没有发现。${report.kind === "code" ? "diff 未命中任何缺陷模式。" : "上下文文件与代码一致。"}</p>`);
    } else if (report.findings.length <= DETAIL_LIMIT) {
        out.push(
            "<table>",
            '<tr><th align="left">等级</th><th align="left">规则</th><th align="left">位置</th><th align="left">说明</th></tr>',
            ...report.findings.map((item) => {
                const tone: Tone = item.severity === "error" ? "bad" : "warn";
                return (
                    `<tr><td>${labelSvg(item.severity, tone)}</td>` +
                    `<td><code>${escapeHtml(item.ruleId)}</code></td>` +
                    `<td><code>${escapeHtml(item.path)}:${item.line}</code></td>` +
                    `<td>${escapeHtml(item.message)}</td></tr>`
                );
            }),
            "</table>",
            "",
        );
    } else {
        const byRule = new Map<string, { severity: string; count: number }>();
        for (const item of report.findings) {
            const seen = byRule.get(item.ruleId);
            if (seen) {
                seen.count += 1;
            } else {
                byRule.set(item.ruleId, { severity: item.severity, count: 1 });
            }
        }
        out.push(
            `<p>${report.findings.length} 条发现超过 ${DETAIL_LIMIT} 条明细上限, 这里只按规则汇总; 完整列表见报告。</p>`,
            "",
            "<table>",
            '<tr><th align="left">规则</th><th align="right">数量</th></tr>',
            ...[...byRule.entries()]
                .sort((a, b) => b[1].count - a[1].count)
                .map(
                    ([ruleId, meta]) =>
                        `<tr><td><code>${escapeHtml(ruleId)}</code></td><td align="right">${countSvg(meta.count, meta.severity === "error" ? "bad" : "warn", ruleId)} ${meta.count}</td></tr>`,
                ),
            "</table>",
            "",
        );
    }

    const applying = report.patches.filter((item) => item.applies).length;
    const foot: string[] = [];
    if (links.patchUrl && applying) {
        foot.push(`[建议的上下文补丁](${links.patchUrl}) (${applying} 处改动)`);
    }
    if (links.runUrl) {
        foot.push(`[完整 MD / JSON 报告](${links.runUrl})`);
    }
    if (links.overviewUrl) {
        foot.push(`[总览与反馈](${links.overviewUrl})`);
    }
    if (foot.length) {
        out.push(foot.join(" · "), "");
    }
    out.push(`<sub>${TOOL_NAME} v${TOOL_VERSION} · 错误只来自 L0, AI 只产出告警</sub>`);
    return out.join("\n").trim() + "\n";
}
