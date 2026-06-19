"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createGithubActionsDispatcher,
  workflowDispatchUrl,
} = require("../app/githubActions");

function captureLogger() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.join(" ")),
    warn: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
  };
}

function baseConfig(overrides = {}) {
  return {
    githubActions: {
      enabled: true,
      token: "super-secret-token",
      owner: "Erwayr",
      repo: "ErwayrWebSite",
      ref: "master",
      liveEndWorkflowId: "twitch-to-firebase.yml",
      liveEndInputs: { run_cards_after: "true" },
      ...overrides,
    },
  };
}

test("workflow dispatch URL targets the configured workflow file", () => {
  assert.equal(
    workflowDispatchUrl({
      owner: "Erwayr",
      repo: "ErwayrWebSite",
      workflowId: "twitch-to-firebase.yml",
    }),
    "https://api.github.com/repos/Erwayr/ErwayrWebSite/actions/workflows/twitch-to-firebase.yml/dispatches",
  );
});

test("dispatcher skips cleanly when disabled or missing token", async () => {
  let called = 0;
  const httpClient = {
    post: async () => {
      called += 1;
    },
  };

  const disabled = createGithubActionsDispatcher({
    config: baseConfig({ enabled: false }),
    httpClient,
    logger: captureLogger(),
  });
  assert.deepEqual(await disabled.dispatchLiveEndWorkflows({ streamId: "s1" }), {
    skipped: true,
    reason: "disabled",
  });

  const missingToken = createGithubActionsDispatcher({
    config: baseConfig({ token: "" }),
    httpClient,
    logger: captureLogger(),
  });
  assert.deepEqual(
    await missingToken.dispatchLiveEndWorkflows({ streamId: "s1" }),
    {
      skipped: true,
      reason: "missing_token",
    },
  );

  assert.equal(called, 0);
});

test("dispatcher posts workflow_dispatch payload without logging the token", async () => {
  const calls = [];
  const logger = captureLogger();
  const httpClient = {
    post: async (url, body, options) => {
      calls.push({ url, body, options });
      return { status: 204 };
    },
  };

  const dispatcher = createGithubActionsDispatcher({
    config: baseConfig(),
    httpClient,
    logger,
  });

  const result = await dispatcher.dispatchLiveEndWorkflows({
    streamId: "stream-1",
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/Erwayr/ErwayrWebSite/actions/workflows/twitch-to-firebase.yml/dispatches",
  );
  assert.deepEqual(calls[0].body, {
    ref: "master",
    inputs: { run_cards_after: "true" },
  });
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer super-secret-token",
  );
  assert.equal(logger.lines.join("\n").includes("super-secret-token"), false);
});
