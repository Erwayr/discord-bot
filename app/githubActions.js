"use strict";

const axios = require("axios");

function compactObject(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null),
  );
}

function workflowDispatchUrl({ owner, repo, workflowId }) {
  return `https://api.github.com/repos/${encodeURIComponent(
    owner,
  )}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(
    workflowId,
  )}/dispatches`;
}

function createGithubActionsDispatcher({
  config,
  httpClient = axios,
  logger = console,
} = {}) {
  const githubConfig = config?.githubActions || {};

  async function dispatchWorkflow({
    workflowId = githubConfig.liveEndWorkflowId,
    ref = githubConfig.ref,
    inputs = {},
    source = "manual",
  } = {}) {
    const enabled = githubConfig.enabled !== false;
    const token = String(githubConfig.token || "").trim();
    const owner = String(githubConfig.owner || "").trim();
    const repo = String(githubConfig.repo || "").trim();
    const safeWorkflowId = String(workflowId || "").trim();
    const safeRef = String(ref || "").trim();

    if (!enabled) {
      logger.log?.(`[github-actions] workflow dispatch skipped (${source}: disabled)`);
      return { skipped: true, reason: "disabled" };
    }

    if (!token) {
      logger.log?.(
        `[github-actions] workflow dispatch skipped (${source}: missing token)`,
      );
      return { skipped: true, reason: "missing_token" };
    }

    if (!owner || !repo || !safeWorkflowId || !safeRef) {
      logger.warn?.(
        `[github-actions] workflow dispatch skipped (${source}: missing config)`,
      );
      return { skipped: true, reason: "missing_config" };
    }

    const url = workflowDispatchUrl({
      owner,
      repo,
      workflowId: safeWorkflowId,
    });
    const body = {
      ref: safeRef,
      inputs: compactObject(inputs),
    };

    try {
      const response = await httpClient.post(url, body, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "discord-bot-live-end",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      logger.log?.(
        `[github-actions] workflow dispatch requested (${safeWorkflowId}@${safeRef}, status=${
          response?.status || 204
        })`,
      );

      return {
        ok: true,
        skipped: false,
        status: response?.status || 204,
        workflowId: safeWorkflowId,
        ref: safeRef,
      };
    } catch (e) {
      const status = e?.response?.status || null;
      const details = e?.response?.data
        ? JSON.stringify(e.response.data).slice(0, 500)
        : e?.message || String(e);

      logger.error?.(
        `[github-actions] workflow dispatch failed (${safeWorkflowId}@${safeRef}, status=${
          status || "-"
        })`,
        details,
      );

      return {
        ok: false,
        skipped: false,
        status,
        workflowId: safeWorkflowId,
        ref: safeRef,
        error: e?.message || String(e),
      };
    }
  }

  function dispatchLiveEndWorkflows({ streamId } = {}) {
    return dispatchWorkflow({
      workflowId: githubConfig.liveEndWorkflowId,
      ref: githubConfig.ref,
      inputs: githubConfig.liveEndInputs || { run_cards_after: "true" },
      source: streamId ? `live-end:${streamId}` : "live-end",
    });
  }

  return {
    dispatchWorkflow,
    dispatchLiveEndWorkflows,
  };
}

module.exports = {
  createGithubActionsDispatcher,
  workflowDispatchUrl,
};
