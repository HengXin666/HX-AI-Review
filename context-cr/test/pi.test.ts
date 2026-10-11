// Integration: the real pi SDK adapter talks to a local OpenAI-compatible endpoint and calls our tool.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { InitConfig } from "../src/init/client.ts";
import { createPiRunner } from "../src/review/pi.ts";
import { reportFindingTool } from "../src/review/tools.ts";
import type { Candidate } from "../src/review/tools.ts";

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
        enabled: true,
        l0Only: false,
        apiUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        models: { finder: "finder-model", verifier: "verifier-model" },
        limits: { contextWindow: 32000, maxTokens: 1024, maxCandidates: 3 },
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
        });
        assert.equal(sink.length, 1);
        assert.equal(sink[0].path, "AGENTS.md");
        assert.equal(seen[0].auth, "Bearer sk-test");
        assert.ok(seen[0].tools.includes("report_finding"));
        assert.ok(
            !seen[0].tools.includes("bash") && !seen[0].tools.includes("write") && !seen[0].tools.includes("edit"),
        );
        assert.ok(result.transcript.length >= 3);
    } finally {
        server.close();
    }
});
