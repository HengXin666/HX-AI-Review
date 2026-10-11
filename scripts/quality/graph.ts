// Impact graph for hx-agent-code test selection. The two packages share no imports, so the graph is static.
const graph = {
    complete: true,
    inputs: {},
    global: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "scripts/quality"],
    modules: {
        "context-cr": { paths: ["context-cr"], tests: ["context-cr:unit"], dependsOn: [], contracts: [] },
        "cf-admin": {
            paths: ["cf-admin"],
            tests: ["cf-admin:unit"],
            dependsOn: [],
            contracts: ["docs/reference/api/cf-admin.yaml"],
        },
    },
};

process.stdout.write(JSON.stringify(graph) + "\n");
