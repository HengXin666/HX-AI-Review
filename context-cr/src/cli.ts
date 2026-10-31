#!/usr/bin/env node
// Entry for the reusable workflow. Each subcommand is one step of the v0.3 pipeline.
import { resolve } from "node:path";
import { ENV, INIT_FILE } from "./constants.ts";
import { git } from "./git.ts";
import { parseKind } from "./contract/kind.ts";
import type { CrKind } from "./contract/kind.ts";
import { isBlocking } from "./contract/report.ts";
import { runRulesStep } from "./rules/run.ts";
import { runEvalCommand } from "./eval/run.ts";
import { runLocal } from "./local/run.ts";
import { runSuite } from "./local/suite/run.ts";
import { load } from "./state.ts";
import { stepInit, stepL0, stepPublish, stepReview, stepScope } from "./steps.ts";

const USAGE = `usage: hx-context-review <command> [--root <dir>] [--base <ref>] [--kind context|code] [--format findings]
commands:
  init      GET /init, mask api_key, export it to the job env
  l0        deterministic L0 checks; exit 1 on new Error findings
  local     diff-only local checks against the worktree; exit 1 on blocking findings
  scope     context: diff -> ancestor AGENTS chain + reverse references; code: added and removed lines
  review    pi finder -> verifier on the scope (skipped when empty or L0-only)
  publish   write MD/JSON, POST /runs, push patch branch, commit/PR comment
  rules     run the deterministic rule registry; exit 1 on blocking findings
  run       init, l0, rules, scope, review and publish in one process
  test      run one test category/tier from the local suite
  eval      replay the code reviewer on the versioned golden set and print metrics

--kind defaults to the /init answer; without /init (local runs) it defaults to context.`;

type Args = { command: string; root: string; format?: string; base?: string; kind?: CrKind };

/**
 * The kind this invocation performs. An explicit --kind wins; otherwise the state written by init, and
 * only then the contract default. Reading state rather than the environment keeps local runs, where
 * there is no /init, on the same path as CI.
 */
function runKind(root: string, explicit: CrKind | undefined): CrKind {
    if (explicit) {
        return explicit;
    }
    // init saves the whole InitState under INIT_FILE, so the kind sits one level down at config.kind.
    const state = load<{ config?: { kind?: unknown } }>(root, INIT_FILE);
    return state?.config?.kind === "code" ? "code" : "context";
}

function parseArgs(argv: string[]): Args {
    const [command, ...rest] = argv;
    const args: Args = { command: command ?? "", root: "." };
    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (flag === "--root" && value) {
            args.root = value;
        } else if (flag === "--base" && value) {
            args.base = value;
        } else if (flag === "--format" && value === "findings") {
            args.format = value;
        } else if (flag === "--kind") {
            args.kind = parseKind(value);
        } else {
            throw new Error(`unknown option ${flag}`);
        }
        i++;
    }
    args.root = git(resolve(args.root), ["rev-parse", "--show-toplevel"]).trim();
    if (args.kind) {
        // Local runs have no /init: the flag is the only way to pick a kind before the state file exists.
        process.env[ENV.kind] = args.kind;
    }
    return args;
}

async function main(argv: string[]): Promise<number> {
    if (argv[0] === "test") {
        return runSuite(argv.slice(1));
    }
    if (argv[0] === "eval") {
        return runEvalCommand();
    }
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
        case "local": {
            const result = runLocal(args.root, args.base);
            if (args.format) {
                process.stdout.write(JSON.stringify(result.report.findings) + "\n");
            } else {
                process.stdout.write(
                    `local: ${result.report.findings.length} finding(s), ` +
                        `${result.report.counts.blocking} blocking, ${result.changes} changed; ` +
                        `base ${result.label}; report ${result.written.md}\n`,
                );
            }
            return result.report.findings.some(isBlocking) ? 1 : 0;
        }
        case "scope": {
            const scope = stepScope(args.root);
            const what =
                scope.kind === "code"
                    ? `${scope.hunks.length} diff hunk(s)`
                    : `${scope.contexts.length} context file(s)`;
            process.stdout.write(`scope: ${scope.changed.length} changed, ${what}\n`);
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
        case "rules": {
            // The rule registry judges whether the context files still match the code, so it belongs to a
            // context CR. Running it under kind=code would file HC-*/CX-* findings against a diff review.
            if (runKind(args.root, args.kind) === "code") {
                process.stdout.write("rules: skipped (code CR has no deterministic stage)\n");
                return 0;
            }
            const rulesRun = runRulesStep(args.root);
            const counts = rulesRun.report.counts;
            process.stdout.write(
                `rules: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.blocking} blocking\n`,
            );
            return counts.blocking > 0 ? 1 : 0;
        }
        case "run": {
            await stepInit(args.root);
            const l0 = stepL0(args.root);
            const codeRun = runKind(args.root, args.kind) === "code";
            const rulesRun = codeRun ? { report: { counts: { blocking: 0 } } } : runRulesStep(args.root);
            stepScope(args.root);
            await stepReview(args.root);
            await stepPublish(args.root);
            return l0.some(isBlocking) || rulesRun.report.counts.blocking > 0 ? 1 : 0;
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
