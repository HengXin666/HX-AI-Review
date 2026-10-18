import { useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Textarea } from "@hx/ui";
import { api } from "../api.ts";
import type { PromptNote, PromptVersion } from "../api.ts";

type Props = {
    prompts: PromptVersion[];
    notes: PromptNote[];
    onDone: () => void;
    onError: (error: Error) => void;
};

/** Operator addenda. Publishing never replaces the runner system prompt, and cannot create Errors. */
export function Prompts({ prompts, notes, onDone, onError }: Props) {
    const [role, setRole] = useState<"finder" | "verifier">("finder");
    const publish = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const body = String(data.get("body") ?? "");
        const note = String(data.get("note") ?? "");
        api.publishPrompt(role, body, note).then(() => {
            form.reset();
            onDone();
        }, onError);
    };
    const open = notes.filter((item) => item.foldedInto === null);
    return (
        <Card className="my-4">
            <CardHeader>
                <CardTitle>Prompt addenda</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pb-4">
                {prompts
                    .filter((item) => item.active)
                    .map((item) => (
                        <p key={item.id} className="text-sm">
                            <Badge>{item.role}</Badge> v{item.version} {item.note}
                        </p>
                    ))}
                <form onSubmit={publish} className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-2">
                        <select
                            className="h-8 rounded-lg border border-border bg-transparent px-2 text-sm"
                            value={role}
                            onChange={(event) => setRole(event.target.value as "finder" | "verifier")}
                        >
                            <option value="finder">finder</option>
                            <option value="verifier">verifier</option>
                        </select>
                        <Input name="note" placeholder="version note" className="w-48" />
                    </div>
                    <Textarea name="body" placeholder="Addendum appended to the built-in system prompt" required />
                    <div className="flex gap-2">
                        <Button type="submit" variant="primary">
                            publish
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => api.foldNotes(role).then(onDone, onError)}
                        >
                            fold {open.length} rejection note(s)
                        </Button>
                    </div>
                </form>
            </CardContent>
        </Card>
    );
}
