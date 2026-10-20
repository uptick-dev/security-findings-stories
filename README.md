# security-findings-stories

Tracks each outstanding security finding as its own Shortcut story. One
advisory is one unit of work, so it gets one story: created when the finding
appears, kept current while it persists, reopened if it comes back after being
closed, and moved to done once it is resolved.

It takes a JSONL file of findings, so any scanner can feed it. The
`uptick-dev/*-findings` actions emit that format:
[`bundler-audit-findings`](https://github.com/uptick-dev/bundler-audit-findings),
[`brakeman-findings`](https://github.com/uptick-dev/brakeman-findings) and
[`importmap-findings`](https://github.com/uptick-dev/importmap-findings).

## Usage

```yaml
- name: Bundler audit
  id: gems
  if: ${{ !cancelled() }}
  uses: uptick-dev/bundler-audit-findings@v1
  with:
    output: ${{ runner.temp }}/findings/gems.jsonl

- name: Brakeman
  id: brakeman
  if: ${{ !cancelled() }}
  uses: uptick-dev/brakeman-findings@v1
  with:
    output: ${{ runner.temp }}/findings/brakeman.jsonl

- name: Collect findings
  if: ${{ !cancelled() }}
  run: cat "$RUNNER_TEMP"/findings/*.jsonl > "$RUNNER_TEMP/findings.jsonl"

- name: Track each finding as a Shortcut story
  id: sync
  if: ${{ !cancelled() }}
  uses: uptick-dev/security-findings-stories@v1
  with:
    findings: ${{ runner.temp }}/findings.jsonl
    shortcut-token: ${{ env.SHORTCUT_TOKEN }}
    team-id: 6564cabf-20d1-463b-b9c1-4e1376a8f1ba
    # Closing on a run where a scanner failed would retire live findings.
    close-resolved: ${{ steps.gems.outputs.completed == 'true' && steps.brakeman.outputs.completed == 'true' }}

- name: Fail if anything is outstanding
  if: ${{ !cancelled() && steps.sync.outputs.outstanding != '0' }}
  run: |
    echo "::error::${{ steps.sync.outputs.outstanding }} outstanding security finding(s) — see the security-audit label in Shortcut."
    exit 1
```

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `findings` | _(required)_ | JSONL file, one `{key, title, body}` object per line, optionally with `story_type`. |
| `shortcut-token` | _(required)_ | Shortcut API token. |
| `label` | `security-audit` | Label applied to, and used to find, every managed story. |
| `team-id` | `""` | Team for new stories: its started iteration and default workflow. |
| `bug-prefixes` | `brakeman/` | Comma-separated key prefixes filed as bugs rather than chores. |
| `max-new-stories` | `25` | Most stories created per run; the rest wait for the next run. |
| `close-resolved` | `"true"` | Move stories for absent findings to done. Pass `false` when a scan did not complete. |

## Outputs

`outstanding`, `created`, `updated`, `reopened`, `closed`, `deferred`: counts
from the run. The action does not fail on outstanding findings; the caller
decides, as in the example above.

## How stories are matched

Stories are matched on Shortcut's `external_id` (`security:<key>`), so a title
that changes with a version or severity does not orphan its story. A duplicated
key in the findings is an error rather than something to deduplicate, because
it would mistrack every later run. Each story's description is rewritten below
a marker only when the finding's text changes, so a quiet day touches nothing.

## Development

```sh
node --test
```
