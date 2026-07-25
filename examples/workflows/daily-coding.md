# Workflow: a typical coding day with umg0

Concrete tool sequences. Replace `acme-api` / entities with yours.  
MCP server: `npx -y @umg0/umg0 mcp` (see [../README.md](../README.md)).

---

## Morning — open the repo

**Goal:** load prior decisions; skip re-onboarding.

```
// 1) Project + task + entities
recall({
  query: "acme-api auth JWT middleware Supabase RLS",
  namespace: "project:acme-api",
  limit: 8
})

// 2) Optional: personal coding prefs if project ns is thin
recall({
  query: "TypeScript testing style preferences",
  namespace: "personal",
  limit: 5
})
```

Then start work using returned prefs/decisions. Do not ask “what framework?” if memory already says Next.js + Supabase.

---

## During — when something becomes durable

**User says:** “Always use Zod at the API boundary.”

```
retain({
  content: "acme-api: validate all public API inputs with Zod at the route boundary.",
  tier: "semantic",
  namespace: "project:acme-api",
  entities: ["Zod", "acme-api"]
})
```

**You decide:** “Refresh tokens go in httpOnly cookies.”

```
retain({
  content: "Decision: acme-api refresh tokens stored in httpOnly cookies; access JWT 15m.",
  tier: "semantic",
  namespace: "project:acme-api",
  entities: ["JWT", "cookies", "acme-api"]
})
```

**User corrects you:** “Auth is in `src/middleware/auth.ts`, not `lib/auth`.”

```
retain({
  content: "Correction: acme-api auth middleware path is src/middleware/auth.ts (not lib/auth).",
  tier: "semantic",
  namespace: "project:acme-api",
  entities: ["auth", "acme-api"]
})
```

**Before a risky refactor:**

```
recall({
  query: "acme-api auth middleware JWT",
  namespace: "project:acme-api"
})
```

**Scratch for this PR only:**

```
retain({
  content: "WIP plan: extract token verify into shared helper; do not merge until tests pass.",
  tier: "working",
  namespace: "project:acme-api"
})
```

---

## End of session

```
reflect({
  text: [
    "Decision: Refresh tokens in httpOnly cookies; access JWT 15m.",
    "Preference: Zod at every public API boundary.",
    "Correction: Auth middleware is src/middleware/auth.ts.",
    "Lesson: RLS policies must be tested with anon key, not service role."
  ].join("\n"),
  namespace: "project:acme-api",
  auto_retain: true
})
```

If a repeatable deploy checklist emerged and was used twice:

```
promote_to_skill({
  memory_ids: ["<id-from-list_or_reflect>"],
  title: "Skill: acme-api auth deploy checks",
  dry_run: true
})
// review → promote without dry_run
```

---

## Weekly hygiene (5 minutes)

```
list_memories({ namespace: "project:acme-api", limit: 20 })
prune({ dry_run: true, namespace: "project:acme-api" })
// if the plan looks right:
prune({ namespace: "project:acme-api" })
stats({})
```

---

## Minimal day (if short on time)

1. Start: one `recall`  
2. Mid: `retain` only on prefs/decisions/corrections  
3. End: one `reflect` with labeled bullets  

That alone beats no memory. Hierarchy + hygiene beat volume.
