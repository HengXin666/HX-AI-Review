// Integration: the real pi SDK adapter talks to a local OpenAI-compatible endpoint and calls our tool.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Type } from "typebox";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { CONTEXT_KIND } from "../src/contract/kind.ts";
import type { InitConfig } from "../src/init/client.ts";
import { join } from "node:path";
import { SessionError } from "../src/review/agent.ts";
import { createPiRunner, failureOf } from "../src/review/pi.ts";
import { repoTools, reportFindingTool } from "../src/review/tools.ts";
import type { Candidate } from "../src/review/tools.ts";

/**
 * Bounds a promise so a regression fails the test instead of hanging the CI job until its own timeout.
 * The timer is always cleared, so a passing test leaves no pending handle behind.
 */
async function within<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
    const body = {
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return "data: " + JSON.stringify(body) + "\n\n";
}

test("pi runner reaches api_url directly and executes report_finding", async () => {
    const seen: { auth?: string; tools: string[] }[] = [];
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (part) => (raw += part));
        req.on("end", () => {
            const body = JSON.parse(raw) as { messages: { role: string }[]; tools?: { function: { name: string } }[] };
            seen.push({ auth: req.headers.authorization, tools: (body.tools ?? []).map((item) => item.function.name) });
            res.writeHead(200, { "content-type": "text/event-stream" });
            if (!body.messages.some((item) => item.role === "tool")) {
                const args = JSON.stringify({
                    path: "AGENTS.md",
                    line: 2,
                    title: "stale",
                    message: "m",
                    evidence: "e",
                });
                const call = {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "report_finding", arguments: args },
                };
                res.write(chunk({ role: "assistant", tool_calls: [call] }));
                res.write(chunk({}, "tool_calls"));
                const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
                res.write(
                    "data: " +
                        JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [], usage }) +
                        "\n\n",
                );
            } else {
                res.write(chunk({ role: "assistant", content: "no more findings" }));
                res.write(chunk({}, "stop"));
            }
            res.end("data: [DONE]\n\n");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const config: InitConfig = {
        repo: "o/r",
        kind: CONTEXT_KIND,
        enabled: true,
        l0Only: false,
        apiUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        models: { finder: "finder-model", verifier: "verifier-model" },
        limits: { contextWindow: 32000, maxTokens: 1024, maxCandidates: 3, maxRunUsd: null },
        pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        suppressions: [],
    };
    try {
        const run = await createPiRunner(process.cwd(), config, "sk-test");
        const sink: Candidate[] = [];
        const result = await run({
            role: "finder",
            model: "finder-model",
            system: "test system",
            prompt: "review",
            tools: [reportFindingTool(sink, 3)],
            timeoutMs: 60000,
        });
        assert.equal(sink.length, 1);
        assert.equal(sink[0].path, "AGENTS.md");
        assert.equal(seen[0].auth, "Bearer sk-test");
        assert.ok(seen[0].tools.includes("report_finding"));
        assert.ok(
            !seen[0].tools.includes("bash") && !seen[0].tools.includes("write") && !seen[0].tools.includes("edit"),
        );
        assert.ok(result.transcript.length >= 3);
        // Pricing from /init reaches pi, so reported cost is real and the monthly budget can trip.
        assert.ok(result.usage.cost > 0, `cost ${result.usage.cost}`);
    } finally {
        server.close();
    }
});

test("a provider error ends the session with a SessionError that keeps the transcript", async () => {
    const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "upstream down" } }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const config: InitConfig = {
        repo: "o/r",
        kind: CONTEXT_KIND,
        enabled: true,
        l0Only: false,
        apiUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        models: { finder: "m", verifier: "m" },
        limits: { contextWindow: 32000, maxTokens: 1024, maxCandidates: 3, maxRunUsd: null },
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        suppressions: [],
    };
    try {
        const run = await createPiRunner(process.cwd(), config, "sk-test");
        const request = { role: "finder" as const, model: "m", system: "s", prompt: "p", tools: [], timeoutMs: 60000 };
        await assert.rejects(run(request), (error: unknown) => {
            assert.ok(error instanceof SessionError);
            assert.match(error.message, /ended with error/);
            assert.ok(error.partial.transcript.length >= 1);
            return true;
        });
    } finally {
        server.close();
    }
});

test("a session timeout aborts an in-flight tool instead of waiting out the git timeout", async () => {
    // The model asks for a slow tool; the session timer fires while it is running. If the abort signal did
    // not reach the tool, the review would sit here for the full git timeout after the session was over.
    let sawAbort = false;
    let aborted: () => void = () => {};
    const reached = new Promise<void>((resolve) => (aborted = resolve));
    const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            const call = {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "slow_tool", arguments: "{}" },
            };
            res.write(chunk({ role: "assistant", tool_calls: [call] }));
            res.write(chunk({}, "tool_calls"));
            res.end("data: [DONE]\n\n");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const config: InitConfig = {
        repo: "o/r",
        kind: CONTEXT_KIND,
        enabled: true,
        l0Only: false,
        apiUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        models: { finder: "m", verifier: "m" },
        limits: { contextWindow: 32000, maxTokens: 1024, maxCandidates: 3, maxRunUsd: null },
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        suppressions: [],
    };
    try {
        const run = await createPiRunner(process.cwd(), config, "sk-test");
        const slow = {
            name: "slow_tool",
            label: "Slow",
            description: "waits until the session is aborted",
            parameters: Type.Object({}),
            execute: (_params: Record<string, unknown>, signal?: AbortSignal) =>
                new Promise<string>((resolve) => {
                    const done = () => {
                        sawAbort = true;
                        aborted();
                        resolve("aborted");
                    };
                    if (signal?.aborted) {
                        done();
                    } else {
                        signal?.addEventListener("abort", done, { once: true });
                    }
                }),
        };
        const started = Date.now();
        await within(
            assert.rejects(
                run({ role: "finder", model: "m", system: "s", prompt: "p", tools: [slow], timeoutMs: 500 }),
                (error: unknown) => {
                    assert.ok(error instanceof SessionError);
                    assert.match(error.message, /timed out/);
                    return true;
                },
            ),
            "the session to time out",
        );
        await within(reached, "the in-flight tool to see the session abort");
        assert.ok(sawAbort, "the tool never saw the session abort");
        assert.ok(Date.now() - started < 5000, "the session waited past its own timeout");
    } finally {
        server.close();
    }
});

test("failureOf: only a normal stop counts as success", () => {
    assert.equal(failureOf([{ role: "assistant", stopReason: "stop" }]), "");
    assert.match(failureOf([{ role: "assistant", stopReason: "length" }]), /token limit/);
    assert.match(failureOf([{ role: "user" }]), /no assistant message/);
});

test("repository tools see only tracked files at HEAD, never .git or paths outside", async () => {
    const tools = Object.fromEntries(repoTools(join(process.cwd(), "..")).map((tool) => [tool.name, tool]));
    assert.match(await tools.read.execute({ path: "AGENTS.md", limit: 2 }), /^1\| /);
    assert.match(await tools.read.execute({ path: ".git/config" }), /Refused/);
    assert.match(await tools.read.execute({ path: "../etc/passwd" }), /Refused/);
    assert.match(await tools.read.execute({ path: "/etc/passwd" }), /Refused/);
    assert.ok((await tools.find.execute({ pattern: "**/AGENTS.md" })).includes("context-cr/AGENTS.md"));
    assert.ok((await tools.ls.execute({})).includes("context-cr/"));
    assert.ok((await tools.grep.execute({ pattern: "hx-context-review", path: "README.md" })).startsWith("README.md:"));
});

test("a grep with no matches is empty, not a git failure", async () => {
    const tools = Object.fromEntries(repoTools(join(process.cwd(), "..")).map((tool) => [tool.name, tool]));
    // git grep exits 1 when nothing matched; execFile reports that as error.code, and treating it as a
    // failure would answer the model with "git error: Command failed" instead of "no matches".
    const out = await tools.grep.execute({ pattern: "zzz-no-such-symbol-anywhere", path: "context-cr/src" });
    assert.equal(out, "No matches.");
});

test("a failing git call is reported, never parsed as an empty file list", async () => {
    const tools = Object.fromEntries(repoTools(join(process.cwd(), "..")).map((tool) => [tool.name, tool]));
    const controller = new AbortController();
    controller.abort();
    // find and ls parse git output as a file list. A cancelled call must surface as an error: parsing the
    // message would answer "No files." or "Empty or not a directory.", i.e. claim the repo has no files.
    for (const name of ["find", "ls"]) {
        const out = await tools[name].execute(name === "find" ? { pattern: "**/*" } : {}, controller.signal);
        assert.doesNotMatch(out, /No files\.|Empty or not a directory/, `${name} hid the failure: ${out}`);
        assert.match(out, /git error/, `${name} did not report the failure: ${out}`);
    }
});

test("a read of a path outside the commit says so, but a git failure is not a missing file", async () => {
    const tools = Object.fromEntries(repoTools(join(process.cwd(), "..")).map((tool) => [tool.name, tool]));
    // git exits 128 with no kill: genuinely absent from the revision.
    assert.match(await tools.read.execute({ path: "context-cr/no-such-file.md" }), /No tracked file/);
    // A cancellation is a tool failure: reporting it as "No tracked file" would hide a real file.
    const controller = new AbortController();
    controller.abort();
    const out = await tools.read.execute({ path: "AGENTS.md" }, controller.signal);
    assert.doesNotMatch(out, /No tracked file/);
    assert.match(out, /cancelled|git error/);
});

test("grep keeps a HEAD: that is part of the matched line, stripping only git's revision prefix", async () => {
    const tools = Object.fromEntries(repoTools(join(process.cwd(), "..")).map((tool) => [tool.name, tool]));
    // publish/github.ts pushes to "HEAD:refs/heads/..."; that inner HEAD: is code, not git's prefix.
    const out = await tools.grep.execute({ pattern: "refs/heads/", path: "context-cr/src/publish/github.ts" });
    assert.ok(out.includes("HEAD:refs/heads/"), out);
});
