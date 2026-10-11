import { patchBranchUrl } from "../api.ts";
import type { Finding, Run } from "../api.ts";
import { box, cell, table } from "./style.ts";

type Props = {
    findings: Finding[];
    runs: Run[];
    onVerdict: (id: string, verdict: "accepted" | "rejected") => void;
};

/** Pending findings with accept/reject, then the recent runs with their one-click patch merge links. */
export function Activity({ findings, runs, onVerdict }: Props) {
    return (
        <>
            <section style={box}>
                <h2>Pending findings ({findings.length})</h2>
                <table style={table}>
                    <tbody>
                        {findings.map((finding) => (
                            <tr key={finding.id}>
                                <td style={cell}>{finding.repo}</td>
                                <td style={cell}>
                                    {finding.severity} {finding.ruleId}
                                </td>
                                <td style={cell}>
                                    {finding.path}:{finding.line}
                                </td>
                                <td style={cell}>{finding.message}</td>
                                <td style={cell}>
                                    {finding.patchKey ? (
                                        <a href={`/api/findings/${finding.id}/patch`} target="_blank" rel="noreferrer">
                                            patch
                                        </a>
                                    ) : (
                                        "-"
                                    )}
                                </td>
                                <td style={cell}>
                                    <button onClick={() => onVerdict(finding.id, "accepted")}>accept</button>{" "}
                                    <button onClick={() => onVerdict(finding.id, "rejected")}>reject</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
            <section style={box}>
                <h2>Recent runs</h2>
                <ul>
                    {runs.map((run) => (
                        <li key={run.id} id={"runs/" + run.id}>
                            {run.repo} {run.sha.slice(0, 10)} {run.event}
                            {run.prNumber ? ` #${run.prNumber}` : ""}: {run.status}, {run.errors}E/{run.warnings}W,{" "}
                            {run.costUsd.toFixed(3)} USD, {Math.round(run.durationMs / 1000)}s{" "}
                            {run.patchBranch ? (
                                <a href={patchBranchUrl(run.repo, run.patchBranch)} target="_blank" rel="noreferrer">
                                    merge patch
                                </a>
                            ) : null}
                        </li>
                    ))}
                </ul>
            </section>
        </>
    );
}
