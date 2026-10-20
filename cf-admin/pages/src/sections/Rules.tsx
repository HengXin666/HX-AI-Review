import { Badge, Card, CardContent, CardHeader, CardTitle, DataTable } from "@hx/ui";
import type { RuleStats } from "../api.ts";

/** Rule and severity totals over recorded rule results, most frequent rule first. */
export function Rules({ stats }: { stats: RuleStats | null }) {
    if (!stats) {
        return (
            <Card className="my-4">
                <CardHeader>
                    <CardTitle>Rules</CardTitle>
                </CardHeader>
                <CardContent className="pb-4 text-sm text-muted-foreground">
                    Rule aggregates are unavailable.
                </CardContent>
            </Card>
        );
    }
    return (
        <Card className="my-4">
            <CardHeader>
                <CardTitle>Rules ({stats.total} hits)</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pb-4">
                <p className="text-sm text-muted-foreground">
                    {stats.topRule ? `Most triggered: ${stats.topRule}. ` : "No rule hits yet. "}
                    {stats.waived} waived. {stats.repo ? `Repository: ${stats.repo}.` : "All repositories."}
                </p>
                <p className="flex flex-wrap gap-2 text-sm">
                    {stats.bySeverity.map((item) => (
                        <Badge key={item.severity} variant={item.severity === "error" ? "destructive" : "warning"}>
                            {item.severity} {item.total} in {item.rules} rule(s)
                        </Badge>
                    ))}
                </p>
                <DataTable
                    bare
                    emptyText="No rule results yet"
                    rowKey={(row) => row.ruleId}
                    rows={stats.byRule}
                    columns={[
                        { key: "rule", header: "Rule", render: (row) => row.ruleId },
                        {
                            key: "severity",
                            header: "Severity",
                            render: (row) => (
                                <span className="flex gap-1">
                                    {row.errors ? <Badge variant="destructive">error {row.errors}</Badge> : null}
                                    {row.warnings ? <Badge variant="warning">warning {row.warnings}</Badge> : null}
                                </span>
                            ),
                        },
                        { key: "total", header: "Hits" },
                        { key: "open", header: "Open" },
                        { key: "waived", header: "Waived" },
                        { key: "runs", header: "Runs" },
                        { key: "files", header: "Files" },
                    ]}
                />
            </CardContent>
        </Card>
    );
}
