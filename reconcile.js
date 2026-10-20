#!/usr/bin/env node

/**
 * Reconciles a set of security findings against Shortcut stories.
 *
 * A daily audit that only fails the workflow has nowhere to put a finding: nothing can be assigned, nothing can be closed when one of three problems is fixed, and a permanently red scheduled run stops being read.
 * Stories go to Shortcut rather than GitHub Issues so the dev team keeps one place to look.
 *
 * Stories are matched on `external_id`, which Shortcut provides for exactly this, so a title that moves with a version or severity does not orphan its story.
 *
 * Usage: node reconcile.js <findings.jsonl>
 *
 * Environment:
 *   SHORTCUT_TOKEN   required
 *   STORY_LABEL      defaults to "security-audit"
 *   TEAM_ID          optional; restricts the active-iteration lookup to one team
 *   CLOSE_RESOLVED   "false" withholds closing; see below
 *   MAX_NEW_STORIES  defaults to 25
 *   BUG_PREFIXES     comma-separated key prefixes filed as bugs rather than chores
 *   RUN_URL          optional, recorded on the story
 *   GITHUB_OUTPUT    optional; receives the counts
 *
 * Exit codes:
 *   0 - reconciled (outstanding findings are reported in the outputs, not the exit code)
 *   2 - script error (bad input, API failure)
 */

const fs = require("fs");

const API = "https://api.app.shortcut.com/api/v3";
const KEY_PREFIX = "security:";

function parseFindings(path) {
  const lines = fs.readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const findings = lines.map((line, i) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`findings line ${i + 1} is not valid JSON`);
    }
    for (const field of ["key", "title", "body"]) {
      if (typeof parsed[field] !== "string" || !parsed[field]) {
        throw new Error(`findings line ${i + 1} is missing a non-empty "${field}"`);
      }
    }
    return parsed;
  });

  // A duplicated key silently mistracks every later run, so it is a hard error rather than something to deduplicate and hope about.
  const seen = new Set();
  const duplicates = findings.map((f) => f.key).filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  if (duplicates.length) {
    throw new Error(`duplicate finding keys: ${[...new Set(duplicates)].join(", ")}`);
  }
  return findings;
}

const externalId = (key) => `${KEY_PREFIX}${key}`;

/** Everything below the marker is rewritten every run; comparing without it keeps a quiet day from touching every story. */
function canonical(description) {
  return (description || "").split("\n\n---\nLast seen ")[0].trimEnd();
}

function renderDescription(finding, runUrl) {
  const seen = `Last seen ${new Date().toISOString().slice(0, 10)}`;
  const where = runUrl ? ` in ${runUrl}` : "";
  return `${finding.body}\n\n---\n${seen}${where}.\nThis story is closed automatically once the finding is no longer reported.`;
}

async function api(fetchImpl, token, method, path, body) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { "Shortcut-Token": token, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return response.status === 204 ? null : response.json();
}

/**
 * Every non-archived story carrying the audit label.
 *
 * This reads the label relation rather than /search/stories, whose index lags behind writes.
 * Matching on `external_id` is what stops a finding getting a second story, and a stale index silently breaks that: a re-run inside the indexing window sees none of the stories the previous run filed and files them all again.
 */
async function managedStories(fetchImpl, token, label) {
  const labels = await api(fetchImpl, token, "GET", "/labels");
  const match = Array.isArray(labels) ? labels.find((l) => l.name === label) : null;
  // No label yet means nothing has ever been filed, which is the ordinary first run.
  if (!match) return [];

  const stories = await api(fetchImpl, token, "GET", `/labels/${match.id}/stories`);
  return (Array.isArray(stories) ? stories : []).filter((story) => !story.archived);
}

/** The workflow the team files into, so a new story starts in that team's own first unstarted state. */
async function teamWorkflowId(fetchImpl, token, teamId) {
  if (!teamId) return null;
  const groups = await api(fetchImpl, token, "GET", "/groups");
  const group = Array.isArray(groups) ? groups.find((g) => g.id === teamId) : null;
  return group ? group.default_workflow_id : null;
}

/** The started iteration, so findings land in the work the team is actually doing. */
async function activeIteration(fetchImpl, token, teamId) {
  const iterations = await api(fetchImpl, token, "GET", "/iterations");
  const started = (iterations || []).filter((i) => i.status === "started");
  const mine = teamId ? started.filter((i) => (i.group_ids || []).includes(teamId)) : started;
  // No active iteration is normal between iterations; the story is still created, just unassigned to one.
  return mine[0] || started[0] || null;
}

function doneStateIds(workflows) {
  const ids = new Set();
  for (const workflow of workflows || []) {
    for (const state of workflow.states || []) {
      if (state.type === "done") ids.add(state.id);
    }
  }
  return ids;
}

async function reconcile({ findings, token, label, closeResolved, maxNew, runUrl, teamId, bugPrefixes = [], fetchImpl }) {
  const [stories, workflows, iteration, workflowId] = await Promise.all([
    managedStories(fetchImpl, token, label),
    api(fetchImpl, token, "GET", "/workflows"),
    activeIteration(fetchImpl, token, teamId),
    teamWorkflowId(fetchImpl, token, teamId),
  ]);

  const done = doneStateIds(workflows);
  const managed = new Map();
  for (const story of stories) {
    if (story.external_id && story.external_id.startsWith(KEY_PREFIX)) {
      managed.set(story.external_id.slice(KEY_PREFIX.length), story);
    }
  }

  // Reopening into the first unstarted state of the story's own workflow keeps a recurrence on the same story instead of creating a duplicate.
  const unstartedFor = (workflowId) => {
    const workflow = (workflows || []).find((w) => w.id === workflowId) || (workflows || [])[0];
    const state = (workflow?.states || []).find((s) => s.type === "unstarted");
    return state ? state.id : null;
  };

  // Shortcut rejects a story that names neither a project nor a workflow state, so resolve one before filing anything.
  const createState = unstartedFor(workflowId);
  if (!createState) {
    throw new Error("no unstarted workflow state is available to create stories in");
  }

  const result = { outstanding: findings.length, created: 0, updated: 0, unchanged: 0, reopened: 0, closed: 0, deferred: 0 };

  for (const finding of findings) {
    const description = renderDescription(finding, runUrl);
    const existing = managed.get(finding.key);

    if (existing) {
      // The label listing leaves description out, and comparing against a missing one would rewrite every story on every run.
      const current = await api(fetchImpl, token, "GET", `/stories/${existing.id}`);
      const patch = {};
      if (canonical(current.description) !== canonical(description)) patch.description = description;
      if (current.name !== finding.title) patch.name = finding.title;
      if (done.has(current.workflow_state_id)) {
        // The finding came back after the story was closed.
        const reopen = unstartedFor(current.workflow_id);
        if (reopen) patch.workflow_state_id = reopen;
        if (iteration) patch.iteration_id = iteration.id;
      }
      if (Object.keys(patch).length === 0) {
        result.unchanged += 1;
      } else {
        await api(fetchImpl, token, "PUT", `/stories/${existing.id}`, patch);
        if (patch.workflow_state_id) result.reopened += 1;
        else result.updated += 1;
      }
    } else if (result.created >= maxNew) {
      result.deferred += 1;
    } else {
      await api(fetchImpl, token, "POST", "/stories", {
        name: finding.title,
        description,
        story_type: finding.story_type || (bugPrefixes.some((p) => finding.key.startsWith(p)) ? "bug" : "chore"),
        workflow_state_id: createState,
        external_id: externalId(finding.key),
        labels: [{ name: label }],
        ...(iteration ? { iteration_id: iteration.id } : {}),
        ...(teamId ? { group_id: teamId } : {}),
      });
      result.created += 1;
    }
  }

  // A scanner that could not run reports nothing, which is indistinguishable from a clean result, so closing on that run would retire live findings.
  if (closeResolved) {
    const live = new Set(findings.map((f) => f.key));
    for (const [key, story] of managed) {
      if (live.has(key) || done.has(story.workflow_state_id)) continue;
      const workflow = (workflows || []).find((w) => w.id === story.workflow_id) || (workflows || [])[0];
      const doneState = (workflow?.states || []).find((s) => s.type === "done");
      if (!doneState) continue;
      await api(fetchImpl, token, "POST", `/stories/${story.id}/comments`, {
        text: "No longer reported by the security audit.",
      });
      await api(fetchImpl, token, "PUT", `/stories/${story.id}`, { workflow_state_id: doneState.id });
      result.closed += 1;
    }
  }

  return result;
}

async function main() {
  const [findingsPath] = process.argv.slice(2);
  if (!findingsPath) throw new Error("usage: reconcile.js <findings.jsonl>");

  const token = process.env.SHORTCUT_TOKEN;
  if (!token) throw new Error("SHORTCUT_TOKEN is required");

  const result = await reconcile({
    findings: parseFindings(findingsPath),
    token,
    label: process.env.STORY_LABEL || "security-audit",
    closeResolved: process.env.CLOSE_RESOLVED !== "false",
    maxNew: Number(process.env.MAX_NEW_STORIES || 25),
    runUrl: process.env.RUN_URL,
    teamId: process.env.TEAM_ID || null,
    bugPrefixes: (process.env.BUG_PREFIXES || "").split(",").map((p) => p.trim()).filter(Boolean),
    fetchImpl: globalThis.fetch,
  });

  console.log(
    `${result.outstanding} outstanding; created ${result.created}, updated ${result.updated}, ` +
      `unchanged ${result.unchanged}, reopened ${result.reopened}, closed ${result.closed}, deferred ${result.deferred}`,
  );
  if (result.deferred) {
    console.log(`::warning::${result.deferred} new finding(s) held back; the next run files them.`);
  }
  if (process.env.GITHUB_OUTPUT) {
    const counts = ["outstanding", "created", "updated", "unchanged", "reopened", "closed", "deferred"];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, counts.map((name) => `${name}=${result[name]}\n`).join(""));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(2);
  });
}

module.exports = { parseFindings, canonical, renderDescription, externalId, reconcile };
