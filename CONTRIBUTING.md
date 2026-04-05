# Contributing to mpbt-server

All code changes go through a **branch → pull request → merge** workflow, regardless of size.

---

## Workflow Overview

1. **Find or open an issue** — every PR must link to an open issue.
2. **Create a branch** off `master` using the naming convention below.
3. **Implement, test, build** — `npm run build` must pass with zero errors.
4. **Open a PR** — fill out the PR template completely.
5. **Review and merge** — address any feedback; squash-merge into `master`.

---

## Branch Naming

`type/short-description`, where `type` matches the issue category:

| Type | Example |
|------|---------|
| `bug/` | `bug/fix-crc-seed` |
| `feature/` | `feature/cmd20-mech-detail` |
| `research/` | `research/post-redirect-protocol` |
| `docs/` | `docs/update-research-md` |
| `chore/` | `chore/upgrade-typescript` |

---

## Opening an Issue

All issues must use one of the four templates below. Blank issues are disabled.
Any issue submitted without template structure is automatically closed with a
message explaining how to resubmit.

| Template | Use when |
|----------|----------|
| **Bug Report** | Something is broken or behaving unexpectedly |
| **Feature Request** | You want a new feature or enhancement |
| **Research Finding** | You've made a reverse engineering discovery |
| **Documentation** | Something in the docs is wrong or missing |
| **Test Plan** | Verifying milestone completeness with a manual test pass |

### Issue Lifecycle

1. Opens → `status: needs-triage` applied automatically
2. Maintainer reviews → sets `status: accepted` (or `status: wont-fix`)
3. `status: accepted` → issue automatically added to project backlog
4. Work begins → `status: in-progress`
5. PR merged → issue closed via `Closes #N` in the PR

### Test Plans

When opening a **Test Plan** issue, file each individual test case (T1, T2, …)
as its own **subissue** on the parent:

1. Open the Test Plan issue and list all T# cases in the body.
2. For each T#, click **Create sub-issue** (or use the sub-issues API) and open a
   brief issue titled `T# — <description>` under the parent.
3. GitHub will display a progress bar on the parent issue that advances
   automatically as each subissue is closed.
4. Close each subissue (or check the checkbox in the parent body) as the test
   passes; close the parent Test Plan issue when all T# are resolved.

Subissue title format: `T# — <one-line summary of expected result>`
Example: `T3 — Mech selection window shows 4 mechs from roster`

---

## Reverse Engineering Conventions

When contributing RE findings, follow the conventions established in [`RESEARCH.md`](RESEARCH.md)
and [`symbols.json`](symbols.json):

- **Functions:** `Module_VerbNoun` — e.g. `Frame_VerifyCRC`, `Aries_RecvPacket`
- **Global data:** `g_module_description` — e.g. `g_lobby_DispatchTable`
- Binary addresses use the Ghidra-style format: `FUN_xxxxxxxx` / `DAT_xxxxxxxx`

Every RE finding should:
1. Be filed as a **Research Finding** issue first (or reference an existing one in the PR)
2. Update the relevant section of `RESEARCH.md`
3. Add any new canonical names to `symbols.json`

---

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) style:

```
type: short description (72 chars max)

Optional body explaining the why. Reference issues with #N.
```

Valid types: `fix`, `feat`, `research`, `docs`, `refactor`, `chore`, `ci`

**Examples:**
```
fix: correct 19-bit CRC finalization rounds
feat: implement cmd20 mech detail response
research: document g_lobby_DispatchTable structure (DAT_00470198)
docs: add post-redirect protocol section to RESEARCH.md
chore: upgrade typescript to 5.5
```

---

## Pull Requests

Every PR must:
- Link to an open issue with `Closes #N`
- Be based on `master`
- Fill the PR template out completely — PRs that don't are automatically closed
- Pass `npm run build` with zero errors (enforced by CI)

PRs not following the template are automatically closed with a comment listing
exactly what is missing.

---

## Maintainer Setup (One Time)

These steps are required once to activate the full automation.

### 1. Sync Labels

After the first push to `master`, go to **Actions → Sync Labels → Run workflow**.

This creates all 20 labels (`type:`, `priority:`, `status:`, `size:`) in the repo.
**Run this before any other workflows need to apply labels.**

### 2. Create the GitHub Project

1. Go to [github.com/kenhuman](https://github.com/kenhuman) → **Projects → New project → Board**.
2. Name it `mpbt-server`.
3. Add columns: **Backlog**, **In Progress**, **In Review**, **Done**.
4. Note the project number `N` from the URL:
   `https://github.com/users/kenhuman/projects/N`

### 3. Configure Secrets and Variables

In **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|------|------|-------|
| Variable | `PROJECT_NUMBER` | The number `N` from the project URL |
| Secret | `PROJECT_PAT` | A classic PAT with **`project`** scope<br>(Settings → Developer settings → Personal access tokens → Tokens (classic)) |

### 4. Enable Branch Protection for `master`

In **Settings → Branches → Add rule** (branch name pattern: `master`):

- ✅ Require a pull request before merging
- ✅ Require status checks to pass before merging
  - Search for and add **`TypeScript build`** (appears after CI has run once)
- ✅ Require branches to be up to date before merging

> **Note:** The default branch is `master`.
