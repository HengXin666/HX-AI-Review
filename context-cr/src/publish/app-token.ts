// Ask the Worker for an installation token of the product GitHub App. Comments then show up as
// that app (hx-ai-review[bot]), the same way Qodo and DeepSource post, instead of github-actions[bot].
import { ENV } from "../constants.ts";

export type GithubActor = { login: string; via: "app" | "actions" };

const ACTIONS_BOT = "github-actions[bot]";

/**
 * When the overview has a GitHub App installed on this repository, replace GITHUB_TOKEN for this
 * process. A missing app is not a failure: the workflow token (usually the Actions bot) still posts,
 * and the comment says which account spoke.
 */
export async function adoptGithubActor(): Promise<GithubActor> {
    const endpoint = process.env[ENV.endpoint]?.replace(/\/+$/, "");
    const hx = process.env[ENV.token];
    if (endpoint && hx) {
        try {
            const response = await fetch(endpoint + "/github/token", {
                headers: { authorization: "Bearer " + hx, accept: "application/json" },
            });
            if (response.ok) {
                const body = (await response.json()) as { token?: unknown; bot?: unknown };
                if (typeof body.token === "string" && body.token) {
                    process.env[ENV.githubToken] = body.token;
                    const login = typeof body.bot === "string" && body.bot ? body.bot : "github-app[bot]";
                    process.env[ENV.githubActor] = login;
                    process.env[ENV.githubActorVia] = "app";
                    process.stderr.write(`github actor: ${login} (app)\n`);
                    return { login, via: "app" };
                }
            } else {
                process.stderr.write(`github app token unavailable (${response.status}); using the workflow token\n`);
            }
        } catch (error) {
            process.stderr.write(
                `github app token skipped: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
    }
    process.env[ENV.githubActor] = ACTIONS_BOT;
    process.env[ENV.githubActorVia] = "actions";
    return { login: ACTIONS_BOT, via: "actions" };
}
