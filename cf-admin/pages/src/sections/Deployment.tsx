import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@hx/ui";
import { commitUrl, deployWorkflowUrl } from "../api.ts";
import type { Deployment as DeploymentInfo } from "../api.ts";
import { dateTime, shortSha } from "../format.ts";

/** What is running on Cloudflare right now, and where to redeploy it. */
export function Deployment({ info }: { info: DeploymentInfo }) {
    const workflow = deployWorkflowUrl(info.runUrl);
    const commit = info.sha ? commitUrl(info.runUrl, info.sha) : undefined;
    return (
        <Card>
            <CardHeader>
                <CardTitle>部署</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-[length:var(--fs-xs)]">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">当前提交</span>
                    {info.sha ? (
                        commit ? (
                            <a
                                className="font-mono text-link underline-offset-4 hover:underline"
                                href={commit}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {shortSha(info.sha)}
                            </a>
                        ) : (
                            <span className="font-mono">{shortSha(info.sha)}</span>
                        )
                    ) : (
                        <span>未由工作流部署 (手动或本地)</span>
                    )}
                    {info.deployedAt ? (
                        <span className="text-muted-foreground">部署于 {dateTime(info.deployedAt)}</span>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Cloudflare Access</span>
                    <Badge variant={info.accessConfigured ? "success" : "warning"}>
                        {info.accessConfigured ? "已配置" : "未配置"}
                    </Badge>
                    <span className="text-muted-foreground">
                        {info.passwordLogin ? "口令登录已开启" : "口令登录已关闭"}
                    </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {info.runUrl ? (
                        <a
                            className="text-link underline-offset-4 hover:underline"
                            href={info.runUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            部署运行日志
                        </a>
                    ) : null}
                    {workflow ? (
                        <Button type="button" variant="outline" size="xs" asChild>
                            <a href={workflow} target="_blank" rel="noreferrer">
                                重新部署 (Run workflow)
                            </a>
                        </Button>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}
