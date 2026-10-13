import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("Pages reruns upload and deploy a run-attempt-scoped artifact", () => {
  const job = parse(readFileSync(".github/workflows/pages.yml", "utf8")).jobs.deploy as {
    env: Record<string, string>;
    steps: Array<{ uses?: string; with?: Record<string, string> }>;
  };
  assert.equal(job.env.PAGES_ARTIFACT_NAME, "github-pages-${{ github.run_attempt }}");
  const name = "${{ env.PAGES_ARTIFACT_NAME }}";
  const upload = job.steps.find(
    (step) =>
      step.uses === "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
  );
  const deploy = job.steps.find(
    (step) => step.uses === "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346",
  );
  assert.equal(upload?.with?.name, name);
  assert.equal(deploy?.with?.artifact_name, name);
});
