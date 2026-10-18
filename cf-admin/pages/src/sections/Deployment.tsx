import { Badge, Card, CardContent, CardHeader, CardTitle } from "@hx/ui";
import { commitUrl, deployWorkflowUrl } from "../api.ts";
import type { Deployment as DeploymentInfo } from "../api.ts";

/** What is running on Cloudflare right now, and where to redeploy it. */
export function Deployment({ info }: { info: DeploymentInfo }) {
    const workflow = deployWorkflowUrl(info.runUrl);
    const commit = info.sha ? commitUrl(info.runUrl, info.sha) : undefined;
    return (
        <Card className="my-4">
            <CardHeader>
                <CardTitle>Deployment</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 pb-4 text-sm">
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
                    {info.accessConfigured ? (
                        <Badge variant="success">configured</Badge>
                    ) : (
                        <Badge variant="warning">not configured</Badge>
                    )}
                    {info.passwordLogin ? " Password login is enabled." : " Password login is off."}
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
            </CardContent>
        </Card>
    );
}
