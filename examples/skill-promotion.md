# Skill promotion — when and how

Procedural memory (`tier: procedural`) is **expensive and near-immortal**. Promote rarely. Prefer lean semantic facts for most durable knowledge.

## When to promote

Promote when **all** are true:

1. Multi-step procedure (not a single fact)
2. Proven in **≥2** real situations (or clearly reusable playbook)
3. Stable — not a one-off incident response
4. Body would help a cold agent next month

**Do not promote:** one-off fixes, product facts, user prefs, temporary workarounds.

## How (always dry_run first if unsure)

```
// From source memory ids (after retain/reflect)
promote_to_skill({
  memory_ids: ["01H...", "01H..."],
  title: "Skill: ship acme-api with RLS smoke tests",
  dry_run: true
})
```

If the proposed body looks skill-like and correct:

```
promote_to_skill({
  memory_ids: ["01H...", "01H..."],
  title: "Skill: ship acme-api with RLS smoke tests"
})
```

CLI:

```bash
umg0 promote --ids id1,id2 --title "Skill: ..." --dry-run
umg0 promote --ids id1,id2 --title "Skill: ..."
```

Quality gates (engine may reject):

- Body long enough (`promote_min_skill_chars`)
- Skill-like structure (steps / “When to use” / “How to” / numbered list)
- Source cluster importance above minimum

Episodic sources may be archived after successful promote when configured.

## Good skill body

```
Skill: Deploy acme-api with RLS smoke tests

When to use:
- Before merging auth or policy changes
- After Supabase migration that touches RLS

How to:
1. Apply migrations against staging.
2. Run smoke tests with anon key (not service role).
3. Verify JWT middleware path src/middleware/auth.ts still mounts.
4. Confirm refresh cookie flags: httpOnly, Secure, SameSite=Lax.
5. Only then promote to production.

Lessons:
- Service-role tests hide RLS bugs.
- Never skip anon-key path for user-facing routes.
```

Why good: titled, situational, numbered steps, durable lessons, entity names.

## Bad skill bodies

**Too thin (a fact, not a skill):**

```
Use Zod.
```

**Transcript dump:**

```
User said they want zod and then we edited three files and the test failed once...
```

**One-off incident:**

```
On Tuesday the deploy failed because port 3000 was busy on Hanan's laptop.
```

**Secret-laden:**

```
Deploy with API_KEY=sk-live-... and DATABASE_URL=postgres://...
```

## Heuristic: skill vs semantic

| Content | Store as |
|---------|----------|
| “Prefer Zod at API boundary” | `retain` semantic |
| “Auth middleware is at path X” | `retain` semantic |
| “Five-step deploy + RLS checklist used every release” | `promote_to_skill` |
| “Fixed typo in README” | nothing |

## Anti-pattern: skill sprawl

If procedural tier fills with near-duplicates, stop promoting. Merge via better skill text; prune noise in lower tiers. See [anti-patterns.md](./anti-patterns.md).
