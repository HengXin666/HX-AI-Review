#!/usr/bin/env node
// Entry for the reusable workflow. Each subcommand is one step of the v0.3 pipeline.
import { resolve } from "node:path";
import { git } from "./git.ts";
import { isBlocking } from "./contract/report.ts";
import { stepInit, stepL0, stepPublish, stepReview, stepScope } from "./steps.ts";

const USAGE = `usage: hx-context-review <command> [--root <dir>] [--format findings]
commands:
  init      GET /init, mask api_key, export it to the job env
  l0        deterministic L0 checks; exit 1 on new Error findings
  scope     diff -> ancestor AGENTS chain + reverse references; output empty=true|false
  review    pi finder -> verifier on the scope (skipped when empty or L0-only)
  publish   write MD/JSON, POST /runs, push patch branch, commit/PR comment
  run       init, l0, scope, review and publish in one process`;

type Args = { command: string; root: string; format?: string };

function parseArgs(argv: string[]): Args {
    const [command, ...rest] = argv;
    const args: Args = { command: command ?? "", root: "." };
    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (flag === "--root" && value) {
            args.root = value;
        } else if (flag === "--format" && value === "findings") {
            args.format = value;
        } else {
            throw new Error(`unknown option ${flag}`);
        }
        i++;
    }
    args.root = git(resolve(args.root), ["rev-parse", "--show-toplevel"]).trim();
    return args;
}

async function main(argv: string[]): Promise<number> {
    const args = parseArgs(argv);
    switch (args.command) {
        case "init":
            await stepInit(args.root);
            return 0;
        case "l0": {
            const findings = stepL0(args.root);
            if (args.format) {
                process.stdout.write(JSON.stringify(findings) + "\n");
            } else {
                process.stdout.write(
                    `L0: ${findings.length} finding(s), ${findings.filter(isBlocking).length} blocking\n`,
                );
            }
            return findings.some(isBlocking) ? 1 : 0;
        }
        case "scope": {
            const scope = stepScope(args.root);
            process.stdout.write(`scope: ${scope.changed.length} changed, ${scope.contexts.length} context file(s)\n`);
            return 0;
        }
        case "review": {
            const ai = await stepReview(args.root);
            const summary = ai ? `${ai.findings.length} confirmed, ${ai.rejected} rejected` : "skipped";
            process.stdout.write(`review: ${summary}\n`);
            return 0;
        }
        case "publish": {
            const blocking = await stepPublish(args.root);
            process.stdout.write(`publish: ${blocking} blocking finding(s)\n`);
            return 0;
        }
        case "run": {
            await stepInit(args.root);
            const l0 = stepL0(args.root);
            stepScope(args.root);
            await stepReview(args.root);
            await stepPublish(args.root);
            return l0.some(isBlocking) ? 1 : 0;
        }
        default:
            process.stderr.write(USAGE + "\n");
            return 2;
    }
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
        process.stderr.write(`hx-context-review: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(2);
    },
);
