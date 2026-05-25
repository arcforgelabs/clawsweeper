import assert from "node:assert/strict";
import test from "node:test";

import { REPOSITORY_PROFILES, repositoryProfileFor } from "../dist/repository-profiles.js";

test("repositoryProfileFor matches mixed-case input against Arc Forge profiles", () => {
  const profile = repositoryProfileFor("ArcForgeLabs/Arc-Forge-Console");

  assert.equal(profile.targetRepo, "arcforgelabs/arc-forge-console");
  assert.equal(profile.slug, "arcforgelabs-arc-forge-console");
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("repositoryProfileFor supports Arc Forge console reviews", () => {
  const profile = repositoryProfileFor("arcforgelabs/arc-forge-console");

  assert.equal(profile.targetRepo, "arcforgelabs/arc-forge-console");
  assert.equal(profile.slug, "arcforgelabs-arc-forge-console");
  assert.equal(profile.checkoutDir, "arc-forge-console");
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("repositoryProfileFor supports Arc Forge ClawSweeper self-review", () => {
  const profile = repositoryProfileFor("arcforgelabs/clawsweeper");

  assert.equal(profile.targetRepo, "arcforgelabs/clawsweeper");
  assert.equal(profile.slug, "arcforgelabs-clawsweeper");
  assert.equal(profile.checkoutDir, "clawsweeper");
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("generic Arc Forge fallback supports conservative event-only onboarding", () => {
  const profile = repositoryProfileFor("arcforgelabs/example-tool");

  assert.equal(profile.targetRepo, "arcforgelabs/example-tool");
  assert.equal(profile.slug, "arcforgelabs-example-tool");
  assert.equal(profile.displayName, "example-tool");
  assert.equal(profile.checkoutDir, "example-tool");
  assert.match(profile.promptNote, /conservative Arc Forge onboarding profile/);
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("generic IAMSamuelRodda fallback supports conservative event-only onboarding", () => {
  const profile = repositoryProfileFor("IAMSamuelRodda/example-tool");

  assert.equal(profile.targetRepo, "iamsamuelrodda/example-tool");
  assert.equal(profile.slug, "iamsamuelrodda-example-tool");
  assert.equal(profile.displayName, "example-tool");
  assert.equal(profile.checkoutDir, "example-tool");
  assert.match(profile.promptNote, /conservative IAMSamuelRodda onboarding profile/);
  assert.deepEqual(profile.applyCloseRules.issue, []);
  assert.deepEqual(profile.applyCloseRules.pull_request, []);
});

test("generic OpenClaw fallback keeps denied repositories unsupported", () => {
  assert.throws(
    () => repositoryProfileFor("openclaw/clawsweeper-state"),
    /Unsupported target repo: openclaw\/clawsweeper-state/,
  );
});

test("generic fallback does not support repositories outside configured owners", () => {
  assert.throws(
    () => repositoryProfileFor("other-org/example-tool"),
    /Unsupported target repo: other-org\/example-tool/,
  );
});

test("profile lookup normalizes candidate target repos as well as input", () => {
  const mixedCaseProfile = {
    ...REPOSITORY_PROFILES[0],
    targetRepo: "Example-Org/Mixed-Case-Repo",
    slug: "example-org-mixed-case-repo",
  };
  REPOSITORY_PROFILES.push(mixedCaseProfile);

  try {
    assert.equal(repositoryProfileFor("example-org/mixed-case-repo"), mixedCaseProfile);
    assert.equal(repositoryProfileFor("EXAMPLE-ORG/MIXED-CASE-REPO"), mixedCaseProfile);
  } finally {
    REPOSITORY_PROFILES.pop();
  }
});
