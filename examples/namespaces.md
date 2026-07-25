# Namespaces — practical guide

Namespaces isolate memory without a multi-tenant cloud. Soft by default; hard isolation is opt-in.

## Conventions

| Namespace | Use for |
|-----------|---------|
| `global` | Default when omitted; cross-cutting facts you want everywhere |
| `project:<slug>` | One repo or product (`project:acme-api`, `project:voniq`) |
| `client:<slug>` | Client-confidential work (`client:northwind`) |
| `personal` | Your coding prefs across all projects |
| `team:<slug>` | Shared team conventions (if multiple people share a DB carefully) |

Slug rules: lowercase, hyphens, no spaces. Example: `project:acme-api`.

## Soft vs hard isolation

**Soft (default):** `recall` may still surface memories from other namespaces depending on query/store filters. You pass `namespace` to bias writes and often reads.

**Hard:** set env `UMG_HARD_ISOLATION=true` (or config `namespace.hard_isolation`). Recall defaults to the configured namespace when you omit one — safer for client work on a shared machine.

```bash
export UMG_HARD_ISOLATION=true
export UMG_NAMESPACE=client:northwind
```

## Examples

### Project work

```
retain({
  content: "acme-api uses Supabase RLS on all user tables.",
  tier: "semantic",
  namespace: "project:acme-api",
  entities: ["Supabase", "RLS", "acme-api"]
})

recall({
  query: "acme-api RLS Supabase",
  namespace: "project:acme-api"
})
```

### Personal style (all projects)

```
retain({
  content: "Preference: TypeScript strict; no any in public APIs.",
  tier: "semantic",
  namespace: "personal",
  entities: ["TypeScript"]
})
```

Session start often does **two** recalls: project ns, then personal.

### Client isolation

```
retain({
  content: "Northwind prefers weekly deploy windows on Thursdays.",
  tier: "semantic",
  namespace: "client:northwind"
})
```

Do not put client secrets in any namespace. Namespace is isolation, not encryption.

## Default namespace

Env `UMG_NAMESPACE` or config `default_namespace` (default `global`) applies when tools omit `namespace`.

MCP config example:

```json
{
  "env": {
    "UMG_NAMESPACE": "project:acme-api",
    "UMG_HARD_ISOLATION": "true"
  }
}
```

## Prune by namespace

```
prune({ dry_run: true, namespace: "project:acme-api" })
prune({ namespace: "project:acme-api" })
```

## Anti-patterns

- One giant `global` for every client (leak risk, noisy recall)
- Random strings (`ns1`, `foo`) instead of `project:` / `client:` prefixes
- Expecting namespace to hide secrets from a compromised agent
- Multiple MCP processes writing different namespaces into the **same** DB file concurrently (still single-writer SQLite)

## Cheatsheet

| Situation | Namespace |
|-----------|-----------|
| This repo’s architecture | `project:<repo>` |
| How *I* like code | `personal` |
| Client A only | `client:a` |
| Truly universal | `global` |
