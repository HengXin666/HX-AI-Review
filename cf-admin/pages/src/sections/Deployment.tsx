import { commitUrl, deployWorkflowUrl } from "../api.ts";
import type { Deployment as DeploymentInfo } from "../api.ts";
import { box } from "./style.ts";

/** What is running on Cloudflare right now, and where to redeploy it. */
export function Deployment({ info }: { info: DeploymentInfo }) {
    const workflow = deployWorkflowUrl(info.runUrl);
    const commit = info.sha ? commitUrl(info.runUrl, info.sha) : undefined;
    return (
        <section style={box}>
            <h2>Deployment</h2>
            <p>
                Commit:{" "}
                {info.sha ? (
                    commit ? (
                        <a href={commit} target="_blank" rel="noreferrer">
                            {info.sha.slice(0, 10)}
                        </a>
                    ) : (
                        info.sha.slice(0, 10)
                    )
                ) : (
                    "not deployed by the workflow (manual or local)"
                )}
                {info.deployedAt ? ` at ${info.deployedAt}` : ""}
            </p>
            <p>
                Cloudflare Access:{" "}
                {info.accessConfigured ? "configured" : <strong>not configured, admin API will answer 403</strong>}
            </p>
            <p>
                {info.runUrl ? (
                    <a href={info.runUrl} target="_blank" rel="noreferrer">
                        deploy run log
                    </a>
                ) : null}
                {workflow ? (
                    <>
                        {" | "}
                        <a href={workflow} target="_blank" rel="noreferrer">
                            redeploy (Run workflow)
                        </a>
                    </>
                ) : null}
            </p>
        </section>
    );
}
