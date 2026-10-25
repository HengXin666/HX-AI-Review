// GET /api/rules: rule and severity totals over the rule dimension table.
import { HttpError, json } from "../http.ts";
import type { Deps } from "../http.ts";
import type { Kind, RuleFilter, RuleSeverity } from "../store/port.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Omitted means the default; a present value outside 1..200 is a 400. */
function limitOf(value: string | null): number {
    if (value === null || value === "") {
        return DEFAULT_LIMIT;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw new HttpError(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    return parsed;
}

/** Omitted means every severity; any other value is a 400. */
function severityOf(value: string | null): RuleSeverity | undefined {
    if (value === null || value === "") {
        return undefined;
    }
    if (value !== "error" && value !== "warning") {
        throw new HttpError(400, 'severity must be "error" or "warning"');
    }
    return value;
}

/** Unknown names are a 404, so a typo never looks like a repo with no rule hits. */
async function repoIdOf(deps: Deps, value: string | null): Promise<number | undefined> {
    if (!value) {
        return undefined;
    }
    const repo = await deps.store.repoByName(value);
    if (!repo) {
        throw new HttpError(404, "unknown repository");
    }
    return repo.id;
}

/** Omitted means both kinds, so an operator who never filters still sees every rule hit. */
function kindOf(value: string | null): Kind | undefined {
    if (value === null || value === "") {
        return undefined;
    }
    if (value !== "context" && value !== "code") {
        throw new HttpError(400, 'kind must be "context" or "code"');
    }
    return value;
}

export async function handleRules(request: Request, deps: Deps): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const repo = params.get("repo");
    const severity = severityOf(params.get("severity"));
    const kind = kindOf(params.get("kind"));
    const limit = limitOf(params.get("limit"));
    const filter: RuleFilter = { repoId: await repoIdOf(deps, repo), severity, kind };
    const stats = await deps.store.ruleStats(filter, limit);
    return json({ repo: repo || null, severity: severity ?? null, kind: kind ?? null, limit, ...stats });
}
