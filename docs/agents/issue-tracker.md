# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `cgm-16/clip`. Use the `gh` CLI from this clone; infer the repository from `git remote -v`.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read, including discussion: `gh issue view <number> --comments`; fetch structured fields with `--json number,title,body,labels,comments` when needed.
- List: `gh issue list --state open --json number,title,body,labels`; use `--label` and `--state` filters as needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

For multiline bodies, write the exact Markdown to a temporary file and pass `--body-file`. Follow the active harness's permission rules for GitHub-contacting commands.

When a skill says "publish to the issue tracker", create a GitHub issue. When it says "fetch the relevant ticket", read the issue and its comments.

Per-task implementation briefs remain GitHub issues, one per DAG node. Follow `docs/tasks/00_DAG.md` and the wave-based branch and PR workflow in `CLAUDE.md`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares a number space across issues and PRs. If a reference is ambiguous, resolve it with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Wayfinding operations

- Map: a single issue labelled `wayfinder:map`, with Notes, Decisions-so-far, and Fog in its body.
- Child ticket: link an issue to the map as a GitHub sub-issue. If unavailable, use a task list in the map and `Part of #<map>` in the child. Label with `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`).
- Blocking: use native issue dependencies with `gh api --method POST repos/cgm-16/clip/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Fetch the numeric database ID with `gh api repos/cgm-16/clip/issues/<blocker> --jq .id`. If unavailable, put `Blocked by: #<number>` in the child body.
- Frontier: list the map's open children; exclude assigned issues and those with open blockers. Select the first remaining ticket in map order.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the answer, close the child, and append a summary and link to the map's Decisions-so-far.
