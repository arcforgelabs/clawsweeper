import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Pages reruns upload and deploy a run-attempt-scoped artifact", () => {
  const workflow = readFileSync(".github/workflows/pages.yml", "utf8").replace(/\r\n/g, "\n");

  assert.match(workflow, /PAGES_ARTIFACT_NAME: github-pages-\$\{\{ github\.run_attempt \}\}/);
  assert.equal(workflow.match(/\$\{\{ env\.PAGES_ARTIFACT_NAME \}\}/g)?.length, 2);
  assert.match(
    workflow,
    /uses: actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5\n\s+with:\n\s+name: \$\{\{ env\.PAGES_ARTIFACT_NAME \}\}/,
  );
  assert.match(
    workflow,
    /uses: actions\/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5\n\s+with:\n\s+artifact_name: \$\{\{ env\.PAGES_ARTIFACT_NAME \}\}/,
  );
});
