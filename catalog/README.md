# Helmdeck live catalog

These files go in the public `helmdeck-feedback` repo. Every hour a GitHub
Action builds `catalog.json` there: every shared build with its likes and
rating, every listed and for-sale build, and the AI providers, models, prices
and app recipes in `extras.json`. It's signed with your catalog key and
published to the repo's `catalog` branch. Every copy of Helmdeck downloads that
one file instead of searching GitHub itself.

Setup is in docs/DEVELOPER-GUIDE.md, section 8. In short:

1. `node scripts/catalog-key.js init`. Put the public key in package.json
   (`helmdeck.catalog.publicKey`), and the private key in the
   `CATALOG_SIGNING_KEY` secret on helmdeck-feedback.
2. Copy this folder to `catalog/` in helmdeck-feedback, and
   `.github/workflows/catalog.yml` to the same path there.
3. Actions → Helmdeck catalog → Run workflow.

## extras.json

Changes here reach everyone within the hour, without an app update.

- `models`: a new default model for a built-in provider, like
  `{ "groq": "llama-4-maverick" }`. People's own choices are kept.
- `prices`: updated estimates in dollars per million tokens, like
  `{ "openai": [1.25, 10] }`.
- `providers`: new OpenAI-compatible services:
  `{ "id": "cerebras", "name": "Cerebras", "tier": "free", "model": "…",
  "base": "https://api.cerebras.ai/v1", "env": ["CEREBRAS_API_KEY"],
  "keyUrl": "https://…", "note": "…" }`. Built-in providers can't be
  replaced.
- `recipes`: new one-click apps. Steps are commands, with `{python}` for
  Python and `{venv}` for the app's virtual environment, like
  `{ "id": "kotaemon", "name": "Kotaemon", "needs": ["python"], "port": 7860,
  "steps": ["{python} -m venv .venv", "{venv}pip install kotaemon"],
  "command": "{venv}kotaemon" }`. Recipes run commands on people's PCs, so
  only add ones you've tried yourself.
- `latestVersion`: the newest Helmdeck version.

## Limits

Each run reads up to 1500 changed files (`CATALOG_MAX_READS`). New builds
beyond that are picked up in the next runs. With the default token that's
enough for tens of thousands of builds. Add a `CATALOG_TOKEN` secret (a
read-only fine-grained token) for more. Past about 50,000 builds the file
should be split into pages.
