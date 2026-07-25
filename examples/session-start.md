# Session start — umg0 playbook

Do this **first**, before writing code or asking the user to re-explain stack/prefs.

## 1. Recall (required)

Call `recall` with **project + task + key entities** in one query.

```
recall({
  query: "acme-api auth middleware JWT Supabase",
  namespace: "project:acme-api",
  limit: 8
})
```

Good query shape:

| Piece | Example |
|-------|---------|
| Project | `acme-api`, `voniq` |
| Task | `auth middleware`, `deploy fix` |
| Entities | `JWT`, `Supabase`, `Retell`, `Stripe` |

**Bad:** `recall({ query: "help" })` — too vague; entity ranking cannot help.

Optional second recall if the first miss:

```
recall({ query: "preferences coding style TypeScript", namespace: "project:acme-api" })
```

## 2. Apply without re-asking

If recall returns preferences or decisions:

- Follow them.
- Do **not** re-interview the user for the same facts.
- Mention only if it changes the plan (“Using retained preference: strict TypeScript”).

## 3. Namespace

- Project work → `namespace: "project:<slug>"` (e.g. `project:acme-api`)
- Personal prefs that span projects → `personal` or omit (default `global`)
- Client-confidential → `client:<name>`

Soft isolation by default: cross-namespace recall may still surface hits unless `UMG_HARD_ISOLATION=true`.

## 4. Working scratch

Current-task notes → `retain` with `tier: "working"` only if useful mid-session.  
Do **not** put durable prefs in working tier.

## Checklist

- [ ] `recall` with project + task + entities
- [ ] Correct `namespace`
- [ ] Apply semantic/procedural hits
- [ ] No “what stack do you use?” when memory already answered
