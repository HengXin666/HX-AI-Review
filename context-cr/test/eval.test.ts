import assert from "node:assert/strict";
import { test } from "node:test";
import { configHash, promptHash, runGolden } from "../src/eval/run.ts";

test("the golden replay is stable and the starter set has no critical miss", async () => {
    const first = await runGolden();
    const second = await runGolden();
    assert.equal(first.dataset, "v1");
    assert.equal(first.mode, "replay");
    assert.deepEqual(first.models, { finder: "replay", verifier: "replay" });
    assert.equal(first.promptHash, promptHash());
    assert.equal(
        first.configHash,
        configHash(
            first.dataset,
            first.details.map((item) => item.id),
        ),
    );
    assert.deepEqual(first, second);
    assert.equal(first.cases, 10);
    assert.equal(first.criticalMisses, 0);
    assert.equal(first.precision, 1);
    assert.equal(first.falsePositiveRate, 0);
    assert.equal(first.falsePositives, 0);
    assert.equal(first.truePositives, 9);
    assert.equal(first.findingsPerPr, 0.9);
    assert.equal(first.recallByCategory.intent.recall, 1);
    assert.equal(first.recallByCategory.breaking.recall, 1);
    assert.equal(first.recallByCategory.stability.recall, 1);
    assert.equal(first.recallByCategory.security.recall, 1);
    assert.equal(first.recallByCategory.breaking.expected, 3);
    assert.equal(first.recallByCategory.stability.expected, 4);
    const clean = first.details.find((item) => item.id === "clean-rename");
    assert.equal(clean?.published, 0);
    const flood = first.details.find((item) => item.id === "nit-flood");
    assert.equal(flood?.published, 1);
    assert.equal(flood?.falsePositives, 0);
});
