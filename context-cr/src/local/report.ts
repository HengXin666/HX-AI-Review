import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_DIR, UTF8 } from "../constants.ts";
import { renderMarkdown } from "../contract/report.ts";
import type { ReviewReport } from "../contract/report.ts";

export type WrittenReport = { md: string; json: string };

/** Write the markdown and json pair of one report under the shared quality report directory. */
export function writeNamedReport(root: string, name: string, report: ReviewReport): WrittenReport {
    const dir = join(root, REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    const json = join(dir, name + ".json");
    const md = join(dir, name + ".md");
    writeFileSync(json, JSON.stringify(report, null, 4) + "\n", UTF8);
    writeFileSync(md, renderMarkdown(report), UTF8);
    return { md, json };
}
