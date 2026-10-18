import { useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, DataTable, Input } from "@hx/ui";
import { patchBranchUrl } from "../api.ts";
import type { Finding, Run } from "../api.ts";

type Props = {
    findings: Finding[];
    resolved: Finding[];
    runs: Run[];
    onVerdict: (id: string, verdict: "accepted" | "rejected", reason: string) => void;
};

function tone(status: string): "success" | "warning" | "secondary" | "destructive" {
    if (status === "passed" || status === "resolved" || status === "accepted") {
        return "success";
    }
    if (status === "failed") {
        return "destructive";
    }
    if (status === "warned" || status === "open") {
        return "warning";
    }
    return "secondary";
}

/** Pending findings with accept/reject, resolved rows from later commits, then recent runs. */
export function Activity({ findings, resolved, runs, onVerdict }: Props) {
    const [reasons, setReasons] = useState<Record<string, string>>({});
    return (
        <>
            <Card className="my-4">
                <CardHeader>
                    <CardTitle>Pending findings ({findings.length})</CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                    <DataTable
                        bare
                        emptyText="No pending findings"
                        rowKey={(row) => row.id}
                        rows={findings}
                        columns={[
                            { key: "repo", header: "Repo" },
                            {
                                key: "rule",
                                header: "Rule",
                                render: (row) => (
                                    <>
                                        <Badge variant={row.severity === "error" ? "destructive" : "warning"}>
                                            {row.severity}
                                        </Badge>{" "}
                                        {row.ruleId}
                                    </>
                                ),
                            },
                            { key: "where", header: "Where", render: (row) => `${row.path}:${row.line}` },
                            { key: "message", header: "Message" },
                            {
                                key: "patch",
                                header: "Patch",
                                render: (row) =>
                                    row.patchKey ? (
                                        <a href={`/api/findings/${row.id}/patch`} target="_blank" rel="noreferrer">
                                            patch
                                        </a>
                                    ) : (
                                        "-"
                                    ),
                            },
                            {
                                key: "verdict",
                                header: "Feedback",
                                render: (row) => (
                                    <span className="flex flex-wrap items-center gap-1">
                                        <Input
                                            value={reasons[row.id] ?? ""}
                                            placeholder="reject reason"
                                            className="w-40"
                                            onChange={(event) =>
                                                setReasons((current) => ({ ...current, [row.id]: event.target.value }))
                                            }
                                        />
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() => onVerdict(row.id, "accepted", "")}
                                        >
                                            accept
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="destructive"
                                            onClick={() => onVerdict(row.id, "rejected", reasons[row.id] ?? "")}
                                        >
                                            reject
                                        </Button>
                                    </span>
                                ),
                            },
                        ]}
                    />
                </CardContent>
            </Card>
            <Card className="my-4">
                <CardHeader>
                    <CardTitle>Resolved on a later commit ({resolved.length})</CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                    <DataTable
                        bare
                        emptyText="None yet"
                        rowKey={(row) => row.id}
                        rows={resolved}
                        columns={[
                            { key: "repo", header: "Repo" },
                            { key: "ruleId", header: "Rule" },
                            { key: "where", header: "Where", render: (row) => `${row.path}:${row.line}` },
                            { key: "message", header: "Message" },
                            {
                                key: "status",
                                header: "Status",
                                render: () => <Badge variant="success">resolved</Badge>,
                            },
                        ]}
                    />
                </CardContent>
            </Card>
            <Card className="my-4">
                <CardHeader>
                    <CardTitle>Recent runs</CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                    <ul className="flex flex-col gap-2 text-sm">
                        {runs.map((run) => (
                            <li key={run.id} id={"runs/" + run.id}>
                                {run.repo} {run.sha.slice(0, 10)} {run.event}
                                {run.prNumber ? ` #${run.prNumber}` : ""}{" "}
                                <Badge variant={tone(run.status)}>{run.status}</Badge> {run.errors}E/{run.warnings}W,{" "}
                                {run.costUsd.toFixed(3)} USD, {Math.round(run.durationMs / 1000)}s{" "}
                                {run.patchBranch ? (
                                    <a
                                        href={patchBranchUrl(run.repo, run.patchBranch)}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        merge patch
                                    </a>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </CardContent>
            </Card>
        </>
    );
}
