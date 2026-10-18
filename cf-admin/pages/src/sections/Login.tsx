import type { FormEvent } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@hx/ui";

type Props = { error: string | null; onSubmit: (user: string, password: string) => void };

/** Password comes from Worker vars. The form never stores a default password in the bundle. */
export function Login({ error, onSubmit }: Props) {
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit(String(data.get("user") ?? ""), String(data.get("password") ?? ""));
    };
    return (
        <main className="mx-auto max-w-md p-6">
            <Card>
                <CardHeader>
                    <CardTitle>hx-context-review</CardTitle>
                </CardHeader>
                <CardContent>
                    <form onSubmit={submit} className="flex flex-col gap-3">
                        <Input name="user" placeholder="user" autoComplete="username" required />
                        <Input
                            name="password"
                            type="password"
                            placeholder="password"
                            autoComplete="current-password"
                            required
                        />
                        <Button type="submit" variant="primary">
                            log in
                        </Button>
                    </form>
                    {error ? <p className="mt-3 text-sm text-danger-fg">{error}</p> : null}
                </CardContent>
            </Card>
        </main>
    );
}
