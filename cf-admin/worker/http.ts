import type { BlobStore, Store } from "./store/port.ts";

/** Worker bindings. Provider api keys are extra secrets named by providers.key_secret. */
export type Env = {
    DB: D1Database;
    BLOBS: R2Bucket;
    /** Cloudflare Access application audience tag; admin API fails closed without it. */
    ACCESS_AUD?: string;
    /** Access team domain, for example myteam.cloudflareaccess.com. */
    ACCESS_TEAM_DOMAIN?: string;
    /** Overview login. Both must be set; they are Worker vars, not a Pages secret. */
    ADMIN_USER?: string;
    ADMIN_PASSWORD?: string;
    /** Public overview Pages URL used in links written back to GitHub. */
    OVERVIEW_URL?: string;
    /** Written by the deploy workflow so the overview page can show what is running. */
    DEPLOY_SHA?: string;
    DEPLOYED_AT?: string;
    DEPLOY_RUN_URL?: string;
    [secret: string]: unknown;
};

export type Deps = {
    store: Store;
    blobs: BlobStore;
    secret(name: string): string | undefined;
    /** Returns the Access identity (email) or null when the request is not authenticated. */
    admin(request: Request): Promise<string | null>;
    /** Hardcoded console login from Worker vars. Absent means password login is off. */
    credentials?: Credentials;
    overviewUrl?: string;
    deployment: Deployment;
    now(): Date;
    id(): string;
};

export type Deployment = {
    sha?: string;
    deployedAt?: string;
    runUrl?: string;
    accessConfigured: boolean;
    /** True when ADMIN_USER and ADMIN_PASSWORD are set on the Worker. */
    passwordLogin?: boolean;
};

export type Credentials = { user: string; password: string };

export class HttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
    try {
        const body = (await request.json()) as unknown;
        if (body && typeof body === "object" && !Array.isArray(body)) {
            return body as Record<string, unknown>;
        }
    } catch {
        // fall through to the 400 below
    }
    throw new HttpError(400, "request body must be a JSON object");
}

export function field(body: Record<string, unknown>, name: string): string {
    const value = body[name];
    if (typeof value !== "string" || !value) {
        throw new HttpError(400, `${name} must be a nonempty string`);
    }
    return value;
}

export function month(now: Date): string {
    return now.toISOString().slice(0, 7);
}
