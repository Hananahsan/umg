# Session end — umg0 checklist

Write durable memory **before** the session dies. Prefer MCP `reflect` over dumping chat.

## 1. Draft bullets (3–8 max)

Use labeled lines only:

```
Decision: Use JWT access tokens with 15m expiry; refresh via httpOnly cookie.
Preference: Prefer TypeScript strict mode; no `any` in public APIs.
Correction: Auth middleware lives in src/middleware/auth.ts, not lib/auth.
Lesson: Supabase RLS must be tested with anon key, not service role.
```

Labels that work well with extract/reflect:

- `Decision:` — choose A over B, architecture calls
- `Preference:` — how the user wants work done
- `Correction:` — wrong assumption fixed this session
- `Lesson:` — reusable pitfall / how-to insight

**Do not** paste transcripts, diffs, or secrets.

## 2. Reflect (required)

```
reflect({
  text: "Decision: ...\nPreference: ...\nCorrection: ...",
  namespace: "project:acme-api",
  auto_retain: true
})
```

Quality bar: only durable, reusable facts. Skip “fixed typo in README”.

## 3. Promote only if proven (optional)

If a multi-step procedure was used successfully more than once:

```
promote_to_skill({
  memory_ids: ["id1", "id2"],
  title: "Skill: ship acme-api with RLS checks",
  dry_run: true
})
```

If dry_run looks good → same call without `dry_run`.  
See [skill-promotion.md](./skill-promotion.md).

## 4. Prune (optional)

If you retained a lot of noise this session:

```
prune({ dry_run: true })
// review → then
prune({})
```

Do not aggressive-prune by default.

## Checklist

- [ ] 3–8 labeled bullets (Decision / Preference / Correction / Lesson)
- [ ] `reflect` with `auto_retain: true` and correct namespace
- [ ] Secrets stripped
- [ ] `promote_to_skill` only for proven playbooks (dry_run first)
- [ ] Optional `prune(dry_run: true)` if noisy

## Hook note

Shell Stop hooks are best-effort. **Agent-driven MCP reflect with real bullets beats a generic hook.** See [claude-code-hooks.md](./claude-code-hooks.md).
