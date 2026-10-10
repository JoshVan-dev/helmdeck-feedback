#!/usr/bin/env node
// Builds Helmdeck's live catalog: one signed file with every shared build,
// its likes and rating, every listed (locked or for-sale) build, and the
// latest AI providers, models, prices and app recipes.
//
// It runs every hour as a GitHub Action in the public feedback repo (see
// catalog/README.md) and publishes catalog.json and catalog.json.sig to the
// repo's `catalog` branch. Every copy of Helmdeck downloads that one file
// instead of searching GitHub itself, so Browse stays fast with any number
// of users and builds.
//
// Each run only re-reads what changed since the last one (kept in
// state.json next to the catalog), so it stays inside GitHub's limits.
//
//   CATALOG_TOKEN        a GitHub token (the Action's GITHUB_TOKEN works; a
//                        fine-grained read-only token allows more builds)
//   CATALOG_SIGNING_KEY  the Ed25519 private key from scripts/catalog-key.js
//   FEEDBACK_REPO        owner/name of the feedback repo (has sellers.json)
//   node catalog/build-index.js <output folder>
//
// Self-contained (Node 20, no packages), so it runs straight from the repo.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = process.env.HUB_GITHUB_API || 'https://api.github.com';
const BUILD_TOPIC = 'helmdeck-build';
const LISTING_TOPIC = 'helmdeck-listing';
const REVIEW_MARK = /<!-- helmdeck-review stars=([1-5])( unsafe)? -->/;
const CHECKOUT = /^https:\/\/[a-z0-9-]+\.lemonsqueezy\.com\/(checkout\/)?buy\/[\w-]+$/i;
const MAX_READS = Number(process.env.CATALOG_MAX_READS) || 1500; // file reads per run
const START = '2015-01-01T00:00:00Z';

function client(token) {
  let calls = 0;
  async function get(url, { raw = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      calls++;
      const res = await fetch(url.startsWith('http') ? url : API + url, {
        headers: { Authorization: `Bearer ${token}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'User-Agent': 'Helmdeck-catalog', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(30000),
      });
      // Search allows 30 calls a minute: wait and try again when it says so.
      if ((res.status === 403 || res.status === 429) && attempt < 4) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const wait = Number(res.headers.get('retry-after')) * 1000 || (reset ? Math.max(1000, reset - Date.now() + 1000) : 20000);
        if (wait > 5 * 60 * 1000) throw new Error('GitHub rate limit: try again later');
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return res;
    }
  }
  return { get, calls: () => calls };
}

// GitHub search returns at most 1000 results per query, so a query with more
// is split into smaller date ranges until each fits.
async function searchAll(gh, kind, q, field, from = START, to = new Date().toISOString()) {
  const range = `${field}:${from.slice(0, 19)}Z..${to.slice(0, 19)}Z`;
  const url = p => `/search/${kind}?q=${encodeURIComponent(`${q} ${range}`)}&per_page=100&page=${p}`;
  const first = await (await gh.get(url(1))).json();
  const total = first.total_count || 0;
  if (total > 1000 && Date.parse(to) - Date.parse(from) > 60 * 1000) {
    const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString();
    return [...await searchAll(gh, kind, q, field, from, mid), ...await searchAll(gh, kind, q, field, mid, to)];
  }
  const items = [...(first.items || [])];
  for (let p = 2; items.length < Math.min(total, 1000) && p <= 10; p++) {
    const page = await (await gh.get(url(p))).json();
    if (!(page.items || []).length) break;
    items.push(...page.items);
  }
  return items;
}

async function readJson(gh, repo, file) {
  const res = await gh.get(`/repos/${repo}/contents/${file}`, { raw: true });
  if (!res.ok) return null;
  try { return JSON.parse(await res.text()); } catch { return null; }
}

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const isImage = s => typeof s === 'string' && /\.(png|jpe?g|svg|ico|webp|gif)$/i.test(s);
const cleanManifest = m => m && typeof m === 'object' ? { name: str(m.name, 60), description: str(m.description, 200),
  icon: isImage(m.icon) ? 'bot' : str(m.icon || 'bot', 30), color: /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : '' } : null;
const sameUser = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());

// The same rule the app uses: only approved sellers' builds get a Buy button.
function saleOf(e, owner, market) {
  const s = e.sale;
  if (!s || !owner || !CHECKOUT.test(s.checkout || '') || !/^\d{1,12}$/.test(String(s.product || ''))) return null;
  const seller = (market.sellers || []).find(x => x && Number(x.id) === Number(owner.id) && sameUser(x.login, owner.login));
  if (!seller || !/^\d{1,12}$/.test(String(seller.store || ''))) return null;
  const price = Number(s.price);
  if (!(price > 0 && price < 10000)) return null;
  return { price: Math.round(price * 100) / 100, checkout: market.affiliate ? `${s.checkout}?aff=${encodeURIComponent(market.affiliate)}` : s.checkout, product: String(s.product), store: String(seller.store) };
}

async function build({ token, feedbackRepo, prev = {} }) {
  const gh = client(token);
  // Whole seconds, because search ranges are; the next run starts here.
  const started = new Date().toISOString().slice(0, 19) + 'Z';
  const state = { repos: {}, listings: {}, reviews: {}, reviewsAt: null, ...prev };
  let reads = 0;
  const canRead = () => reads++ < MAX_READS;

  // ---------- listed builds (locked and for sale) ----------
  // Read first: there are few listings and they hold paid builds.
  const market = { affiliate: '', cut: 15, sellers: [] };
  const sellers = feedbackRepo ? await readJson(gh, feedbackRepo, 'sellers.json') : null;
  if (sellers && Array.isArray(sellers.sellers)) Object.assign(market, { affiliate: /^[\w-]{1,60}$/.test(sellers.affiliate || '') ? sellers.affiliate : '', cut: Number(sellers.cut) || 15, sellers: sellers.sellers });
  const listingRepos = await searchAll(gh, 'repositories', `topic:${LISTING_TOPIC}`, 'created');
  const listings = {};
  for (const l of listingRepos) {
    const key = l.full_name.toLowerCase();
    const old = state.listings[key];
    let data = old ? old.data : null;
    let pushedAt = old ? old.pushedAt : null;
    if ((!old || old.pushedAt !== l.pushed_at) && canRead()) {
      data = await readJson(gh, l.full_name, 'listing.json');
      pushedAt = l.pushed_at;
    }
    listings[key] = { pushedAt, owner: { login: l.owner.login, id: l.owner.id }, repo: l.full_name, data };
  }
  state.listings = listings;

  // ---------- public builds ----------
  const found = await searchAll(gh, 'repositories', `topic:${BUILD_TOPIC}`, 'created');
  const repos = {};
  for (const r of found) {
    if (r.private || r.archived) continue;
    const key = r.full_name.toLowerCase();
    const old = state.repos[key];
    let m = old ? old.manifest : null;
    let pushedAt = old ? old.pushedAt : null; // left old when not read, so it's read next run
    if ((!old || old.pushedAt !== r.pushed_at) && canRead()) {
      m = cleanManifest((await readJson(gh, r.full_name, 'helmdeck.json')) || (await readJson(gh, r.full_name, 'apphub.json')));
      pushedAt = r.pushed_at;
    }
    repos[key] = {
      pushedAt, manifest: m,
      info: { repo: r.full_name, owner: r.owner.login, ownerId: r.owner.id, name: r.name, description: str(r.description, 200), stars: r.stargazers_count || 0, createdAt: r.created_at, updatedAt: r.pushed_at || r.updated_at },
    };
  }
  state.repos = repos;

  // ---------- reviews ----------
  // Every review is an issue titled "★★★★☆ Helmdeck review by @name". Only
  // reviews changed since the last run are fetched.
  const since = state.reviewsAt || START;
  const issues = await searchAll(gh, 'issues', 'is:issue "Helmdeck review by" in:title', 'updated', since, started);
  for (const i of issues) {
    const m = (i.body || '').match(REVIEW_MARK);
    const repo = String(i.repository_url || '').split('/repos/')[1];
    const user = i.user && i.user.login;
    if (!m || !repo || !user || sameUser(user, repo.split('/')[0])) continue;
    const key = repo.toLowerCase();
    const r = state.reviews[key] = state.reviews[key] || {};
    const prevR = r[user.toLowerCase()];
    if (!prevR || prevR[2] <= i.updated_at) r[user.toLowerCase()] = [Number(m[1]), m[2] ? 1 : 0, i.updated_at];
  }
  state.reviewsAt = started;

  // ---------- the catalog ----------
  const builds = Object.values(repos).map(({ info, manifest }) => {
    const rv = Object.values(state.reviews[info.repo.toLowerCase()] || {});
    const count = rv.length;
    return {
      ...info,
      name: (manifest && manifest.name) || info.name,
      description: (manifest && manifest.description) || info.description,
      icon: (manifest && manifest.icon) || 'bot',
      color: (manifest && manifest.color) || '#6366f1',
      rating: { count, average: count ? Math.round(rv.reduce((n, r) => n + r[0], 0) / count * 100) / 100 : 0, unsafe: rv.filter(r => r[1]).length },
    };
  });
  const listed = [];
  for (const l of Object.values(listings)) {
    for (const e of ((l.data && l.data.builds) || []).slice(0, 100)) {
      if (!e || typeof e.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(e.repo)) continue;
      // A listing can only advertise its own owner's repos.
      if (!sameUser(e.repo.split('/')[0], l.owner.login)) continue;
      const sale = saleOf(e, l.owner, market);
      listed.push({
        repo: e.repo, owner: l.owner.login, ownerId: l.owner.id, name: str(e.name || e.repo.split('/')[1], 60),
        description: str(e.description, 200), icon: /^[a-z]{2,20}$/.test(e.icon || '') ? e.icon : 'bot',
        color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#64748b', listing: l.repo, ...(sale ? { sale } : {}),
      });
    }
  }

  // Providers, models, prices and recipes: catalog/extras.json, edited by
  // Helmdeck's developer, ships to every copy of Helmdeck with this file.
  const extras = feedbackRepo ? (await readJson(gh, feedbackRepo, 'catalog/extras.json')) || {} : {};
  const catalog = {
    format: 'helmdeck-catalog', version: 1, generatedAt: started,
    builds: builds.sort((a, b) => b.stars - a.stars), listed,
    ai: { providers: Array.isArray(extras.providers) ? extras.providers : [], models: extras.models || {}, prices: extras.prices || {} },
    recipes: Array.isArray(extras.recipes) ? extras.recipes : [],
    minVersion: extras.minVersion || null, latestVersion: extras.latestVersion || null,
    stats: { builds: builds.length, listed: listed.length, builders: new Set([...builds, ...listed].map(b => b.owner.toLowerCase())).size },
  };
  return { catalog, state, calls: gh.calls(), reads: Math.min(reads, MAX_READS) };
}

function sign(bytes, pem) {
  return crypto.sign(null, bytes, crypto.createPrivateKey(pem)).toString('base64');
}

if (require.main === module) {
  (async () => {
    const out = process.argv[2] || 'out';
    const token = process.env.CATALOG_TOKEN || process.env.GITHUB_TOKEN;
    const key = process.env.CATALOG_SIGNING_KEY;
    if (!token || !key) throw new Error('Set CATALOG_TOKEN and CATALOG_SIGNING_KEY');
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8')); } catch {}
    const r = await build({ token, feedbackRepo: process.env.FEEDBACK_REPO || process.env.GITHUB_REPOSITORY, prev });
    const bytes = Buffer.from(JSON.stringify(r.catalog));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'catalog.json'), bytes);
    fs.writeFileSync(path.join(out, 'catalog.json.sig'), sign(bytes, key));
    fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(r.state));
    console.log(`Catalog: ${r.catalog.stats.builds} builds, ${r.catalog.stats.listed} listed, ${r.catalog.stats.builders} builders. ${r.calls} GitHub calls, ${r.reads} file reads, ${Math.round(bytes.length / 1024)} KB.`);
  })().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { build, sign };
