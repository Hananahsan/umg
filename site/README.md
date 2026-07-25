# umg0 marketing site

Product landing page for **umg0**, the brand for [UMG](https://github.com/Hananahsan/umg) (Unified Memory Gateway) **v0.2**.

Inspired by the structure of modern agent-memory products (Mem0, Zep, Cognee): hero + live session panel, integrations, problem framing, product UI mock, deep features, quickstart tabs, use cases.

Stack: **Astro + Tailwind CSS**. Fully static.

## Develop

```bash
cd site
npm install
npm run dev
```

Open the URL printed by Astro (usually `http://localhost:4321`).

## Build

```bash
npm run build
npm run preview
```

Output: `dist/`

## Page structure

1. Nav: product anchors, Docs, GitHub, Get Started  
2. Hero: value prop + session/tool demo panel  
3. Integrations strip  
4. Stats (aligned to v0.2)  
5. Problem  
6. Product demo (hierarchy + memory list mock)  
7. Features (hierarchy, consolidation, MCP)  
8. How it works  
9. Quickstart code tabs (CLI / MCP / agent pattern)  
10. Use cases  
11. Final CTA  
12. Footer  

## Deploy

| Setting | Value |
|---------|--------|
| Root directory | `site` |
| Build command | `npm run build` |
| Output directory | `dist` |

When you have a production domain, set `site` in `astro.config.mjs` (e.g. `site: 'https://your-domain'`).
