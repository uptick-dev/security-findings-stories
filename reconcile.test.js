const { describe, test } = require("node:test");
const { expect } = require("./test/expect");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseFindings, canonical, renderDescription, externalId, reconcile } = require("./reconcile");

function writeFindings(findings) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "findings-")), "f.jsonl");
  fs.writeFileSync(file, findings.map((f) => JSON.stringify(f)).join("\n"));
  return file;
}

const WORKFLOWS = [
  {
    id: 1,
    states: [
      { id: 10, name: "To Do", type: "unstarted" },
      { id: 11, name: "In Progress", type: "started" },
      { id: 12, name: "Done", type: "done" },
    ],
  },
];
const ITERATIONS = [
  { id: 5487, status: "started", group_ids: ["dev"] },
  { id: 5432, status: "done", group_ids: ["dev"] },
];
const GROUPS = [{ id: "dev", default_workflow_id: 1 }];
const LABELS = [{ id: 7, name: "security-audit" }];

/** Fake Shortcut API that records calls and serves a fixed set of stories. */
function fakeApi(stories = []) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ method: options.method, url, body: options.body && JSON.parse(options.body) });
    const byId = options.method === "GET" && /\/stories\/\d+$/.test(url);
    const json = byId
      ? stories.find((st) => String(st.id) === url.split("/").pop()) || {}
      : url.includes("/labels/7/stories")
        ? stories
        : url.endsWith("/labels")
          ? LABELS
          : url.includes("/workflows")
            ? WORKFLOWS
            : url.includes("/iterations")
              ? ITERATIONS
              : url.includes("/groups")
                ? GROUPS
                : {};
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { fetchImpl, calls };
}

const base = { token: "t", label: "security-audit", closeResolved: true, maxNew: 25, teamId: "dev" };
const finding = (key, body = "Upgrade it.") => ({ key, title: `Security: ${key}`, body });
const story = (id, key, over = {}) => ({
  id,
  external_id: externalId(key),
  name: `Security: ${key}`,
  description: renderDescription(finding(key)),
  workflow_id: 1,
  workflow_state_id: 10,
  ...over,
});
const created = (calls) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/stories"));
const patched = (calls) => calls.filter((c) => c.method === "PUT");

describe("parseFindings", () => {
  test("rejects a duplicated key rather than mistracking later runs", () => {
    expect(() => parseFindings(writeFindings([finding("a"), finding("a")]))).toThrow(/duplicate finding keys: a/);
  });

  test("rejects a finding missing a field", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "f-")), "f.jsonl");
    fs.writeFileSync(file, JSON.stringify({ title: "no key", body: "x" }));
    expect(() => parseFindings(file)).toThrow(/missing a non-empty "key"/);
  });
});

describe("descriptions", () => {
  test("compare equal across runs despite the timestamp", () => {
    const a = renderDescription(finding("k"), "https://run/1");
    const b = renderDescription(finding("k"), "https://run/2");
    expect(a).not.toBe(b);
    expect(canonical(a)).toBe(canonical(b));
  });
});

describe("reconcile", () => {
  test("creates one story per finding, in the started iteration", async () => {
    const { fetchImpl, calls } = fakeApi([]);
    const result = await reconcile({ ...base, findings: [finding("a"), finding("b")], fetchImpl });
    expect(result).toMatchObject({ created: 2, updated: 0, closed: 0 });

    const bodies = created(calls).map((c) => c.body);
    expect(bodies.every((b) => b.iteration_id === 5487)).toBe(true);
    expect(bodies.every((b) => b.group_id === "dev")).toBe(true);
    expect(bodies.every((b) => b.labels[0].name === "security-audit")).toBe(true);
    expect(bodies.map((b) => b.external_id)).toEqual(["security:a", "security:b"]);
  });

  test("names a workflow state, which Shortcut requires to create a story at all", async () => {
    const { fetchImpl, calls } = fakeApi([]);
    await reconcile({ ...base, findings: [finding("a")], fetchImpl });
    // Shortcut rejects a create that names neither a project nor a workflow state, and the state comes from the team's own workflow.
    expect(created(calls)[0].body.workflow_state_id).toBe(10);
  });

  test("raises with the API's own message so a rejected create is diagnosable", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 422,
      json: async () => ({}),
      text: async () => '{"message":"Must provide at least one of project_id or workflow_state_id."}',
    });
    await expect(reconcile({ ...base, findings: [finding("a")], fetchImpl })).rejects.toThrow(/project_id or workflow_state_id/);
  });

  test("carries the finding's story type through", async () => {
    const { fetchImpl, calls } = fakeApi([]);
    await reconcile({ ...base, findings: [{ ...finding("a"), story_type: "bug" }], fetchImpl });
    expect(created(calls)[0].body.story_type).toBe("bug");
  });

  test("a second run with the same findings touches nothing", async () => {
    const { fetchImpl, calls } = fakeApi([story(1, "a")]);
    const result = await reconcile({ ...base, findings: [finding("a")], fetchImpl });
    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1, closed: 0 });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  test("a changed finding updates only its own story", async () => {
    const { fetchImpl, calls } = fakeApi([story(1, "a", { description: renderDescription(finding("a", "old")) })]);
    const result = await reconcile({ ...base, findings: [finding("a", "new")], fetchImpl });
    expect(result).toMatchObject({ updated: 1, created: 0 });
    expect(patched(calls)[0].body.description).toContain("new");
  });

  test("a moved title is refreshed, not left stale", async () => {
    const { fetchImpl, calls } = fakeApi([story(1, "a", { name: "Security: a 1.0 (low)" })]);
    await reconcile({ ...base, findings: [{ ...finding("a"), title: "Security: a 1.1 (high)" }], fetchImpl });
    expect(patched(calls)[0].body.name).toBe("Security: a 1.1 (high)");
  });

  test("a resolved finding moves its story to done", async () => {
    const { fetchImpl, calls } = fakeApi([story(1, "a"), story(2, "gone")]);
    const result = await reconcile({ ...base, findings: [finding("a")], fetchImpl });
    expect(result).toMatchObject({ closed: 1, unchanged: 1 });
    expect(patched(calls).find((c) => c.url.endsWith("/stories/2")).body.workflow_state_id).toBe(12);
  });

  test("a finding that comes back reopens its story instead of duplicating it", async () => {
    const { fetchImpl, calls } = fakeApi([story(1, "a", { workflow_state_id: 12 })]);
    const result = await reconcile({ ...base, findings: [finding("a")], fetchImpl });
    expect(result).toMatchObject({ reopened: 1, created: 0 });
    expect(patched(calls)[0].body).toMatchObject({ workflow_state_id: 10, iteration_id: 5487 });
    expect(created(calls)).toHaveLength(0);
  });

  test("an already-done story is not closed again", async () => {
    const { fetchImpl, calls } = fakeApi([story(1, "gone", { workflow_state_id: 12 })]);
    const result = await reconcile({ ...base, findings: [], fetchImpl });
    expect(result).toMatchObject({ closed: 0 });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  test("closeResolved false withholds closing, so a broken scan cannot retire live findings", async () => {
    const { fetchImpl, calls } = fakeApi([story(1, "gem/rack/CVE-1"), story(2, "gem/nokogiri/CVE-2")]);
    const result = await reconcile({ ...base, closeResolved: false, findings: [finding("scan/bundler-audit")], fetchImpl });
    expect(result).toMatchObject({ created: 1, closed: 0 });
    expect(patched(calls)).toHaveLength(0);
  });

  test("a story without the audit external_id is left alone", async () => {
    const { fetchImpl, calls } = fakeApi([{ id: 9, external_id: "jira:ABC-1", workflow_id: 1, workflow_state_id: 10 }]);
    const result = await reconcile({ ...base, findings: [], fetchImpl });
    expect(result).toMatchObject({ closed: 0 });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  test("maxNew defers the overflow rather than flooding the iteration", async () => {
    const { fetchImpl } = fakeApi([]);
    const result = await reconcile({ ...base, maxNew: 2, findings: [finding("a"), finding("b"), finding("c")], fetchImpl });
    expect(result).toMatchObject({ created: 2, deferred: 1 });
  });

  test("stories are still created when no iteration is active", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ method: options.method, url, body: options.body && JSON.parse(options.body) });
      const json = url.includes("/search/stories")
        ? { data: [], next: null }
        : url.includes("/workflows")
          ? WORKFLOWS
          : url.includes("/iterations")
            ? [{ id: 1, status: "done", group_ids: ["dev"] }]
            : {};
      return { ok: true, status: 200, json: async () => json };
    };
    const result = await reconcile({ ...base, findings: [finding("a")], fetchImpl });
    expect(result).toMatchObject({ created: 1 });
    expect(created(calls)[0].body.iteration_id).toBeUndefined();
  });

  test("existing stories are found without consulting the search index", async () => {
    // The search index lags behind writes, so a re-run inside that window would see no existing stories and file a duplicate for every finding.
    const { fetchImpl, calls } = fakeApi([story(1, "a"), story(2, "b")]);
    const result = await reconcile({ ...base, findings: [finding("a"), finding("b")], fetchImpl });
    expect(result).toMatchObject({ unchanged: 2, created: 0 });
    expect(calls.some((c) => c.url.includes("/search/stories"))).toBe(false);
  });

  test("an archived story does not count as the finding's story", async () => {
    const { fetchImpl, calls } = fakeApi([story(1, "a", { archived: true })]);
    const result = await reconcile({ ...base, findings: [finding("a")], fetchImpl });
    expect(result).toMatchObject({ created: 1, unchanged: 0 });
    expect(created(calls)).toHaveLength(1);
  });

  test("a label that does not exist yet is an ordinary first run", async () => {
    const fetchImpl = async (url, options) => {
      const json = url.endsWith("/labels")
        ? []
        : url.includes("/workflows")
          ? WORKFLOWS
          : url.includes("/iterations")
            ? ITERATIONS
            : url.includes("/groups")
              ? GROUPS
              : {};
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
    };
    const result = await reconcile({ ...base, findings: [finding("a")], fetchImpl });
    expect(result).toMatchObject({ created: 1 });
  });

  test("an API failure is raised rather than reported as a clean run", async () => {
    const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}), text: async () => "upstream unavailable" });
    await expect(reconcile({ ...base, findings: [finding("a")], fetchImpl })).rejects.toThrow(/502/);
  });
  test("files findings under a bug prefix as bugs, and the rest as chores", async () => {
    const { fetchImpl, calls } = fakeApi();
    await reconcile({
      ...base,
      findings: [finding("brakeman/abc"), finding("gem/rack/CVE-1"), { ...finding("importmap/x"), story_type: "feature" }],
      bugPrefixes: ["brakeman/"],
      fetchImpl,
    });
    expect(created(calls).map((c) => c.body.story_type)).toEqual(["bug", "chore", "feature"]);
  });
});
