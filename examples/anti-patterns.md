# Anti-patterns — what not to retain

UMG’s thesis: **hierarchical memory + aggressive hygiene**. Bloat kills ranking and trust. When in doubt, **do not retain**.

## Never retain

| Anti-pattern | Why |
|--------------|-----|
| API keys, tokens, passwords, private cookies | Security; treat memory as semi-trusted context |
| Full chat transcripts | Use `reflect` with bullets instead |
| Entire source files or large diffs | Retain the *rule*, not the patch |
| `.env` contents / connection strings | Secrets + machine-specific |
| PII you wouldn’t put in a shared doc | Privacy |

## Usually do not retain

| Anti-pattern | Prefer instead |
|--------------|----------------|
| “WIP”, “looking into it”, status spam | Nothing, or `working` tier if truly useful mid-task |
| Absolute laptop paths (`/Users/you/...`) | Repo-relative paths (`src/middleware/auth.ts`) |
| One-off error logs with no lesson | `Lesson:` bullet only if reusable |
| Duplicate of an existing semantic fact | Let merge/supersede handle it; don’t re-dump |
| Every intermediate hypothesis | Final decision only |
| Meeting notes with no action/decision | Extract decisions only |

## Recall anti-patterns

| Bad | Good |
|-----|------|
| `query: "stuff"` | `query: "acme-api auth JWT Supabase"` |
| No namespace on client work | `namespace: "client:acme"` |
| Ignoring returned prefs and re-asking | Apply first; ask only on gaps |
| Recalling once a month | Session start + before risky changes |

## Reflect anti-patterns

| Bad | Good |
|-----|------|
| Paste entire session into `reflect` | 3–8 labeled bullets |
| Unlabeled wall of text | `Decision:` / `Preference:` / `Correction:` |
| Reflecting empty sessions | Skip |
| Secrets in bullets | Strip before reflect |

## Promote anti-patterns

| Bad | Good |
|-----|------|
| Promote after one try | Wait until proven multi-use |
| Skill = single preference | Use semantic `retain` |
| Skill body = transcript | Structured When/How/Lessons |
| Never dry_run | `dry_run: true` first when unsure |

## Hygiene anti-patterns

| Bad | Good |
|-----|------|
| Never prune | Weekly `prune({ dry_run: true })` then prune |
| Aggressive prune daily | Default prune; aggressive only when intentional |
| Multiple writers on one SQLite file | One MCP process per DB |
| Infinite episodic diary | Semantic decisions + rare skills |

## Smell test

Before `retain`, ask:

1. Will this help a **cold agent next week**?
2. Is it **one fact** (or a true multi-step skill)?
3. Free of **secrets** and **machine-local junk**?

If any answer is no → skip.
