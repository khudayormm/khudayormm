// Generates GitHub stats SVG cards from ALL owned repositories (public + private).
// Needs GH_TOKEN (classic PAT with `repo` + `read:user`) and GH_USER env vars.
import { writeFileSync, mkdirSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN;
const USER = process.env.GH_USER;
if (!TOKEN || !USER) {
  console.error('GH_TOKEN and GH_USER are required');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-stats',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors || !json.data) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

// ---------- 1. Repositories (owned, public + private) ----------
const repos = [];
let profile;
let cursor = null;
do {
  const d = await gql(
    `query($login:String!,$cursor:String){
      user(login:$login){
        pullRequests{ totalCount }
        issues{ totalCount }
        contributionsCollection{ contributionYears }
        repositories(first:100, after:$cursor, ownerAffiliations:OWNER){
          pageInfo{ hasNextPage endCursor }
          nodes{
            isPrivate isFork stargazerCount
            languages(first:10, orderBy:{field:SIZE, direction:DESC}){
              edges{ size node{ name color } }
            }
          }
        }
      }
    }`,
    { login: USER, cursor },
  );
  profile = d.user;
  repos.push(...d.user.repositories.nodes);
  const p = d.user.repositories.pageInfo;
  cursor = p.hasNextPage ? p.endCursor : null;
} while (cursor);

const privateCount = repos.filter((r) => r.isPrivate).length;
const publicCount = repos.length - privateCount;
const own = repos.filter((r) => !r.isFork);
const stars = own.reduce((s, r) => s + r.stargazerCount, 0);

const langMap = {};
for (const r of own) {
  for (const e of r.languages.edges) {
    const k = e.node.name;
    langMap[k] ??= { size: 0, color: e.node.color || '#858585' };
    langMap[k].size += e.size;
  }
}
const langTotal = Object.values(langMap).reduce((s, l) => s + l.size, 0) || 1;
const langs = Object.entries(langMap)
  .map(([name, l]) => ({ name, color: l.color, pct: (l.size / langTotal) * 100 }))
  .sort((a, b) => b.pct - a.pct)
  .slice(0, 8);

// ---------- 2. Contributions (all years) ----------
let totalCommits = 0;
let totalContrib = 0;
const days = [];
for (const y of profile.contributionsCollection.contributionYears) {
  const d = await gql(
    `query($login:String!,$from:DateTime!,$to:DateTime!){
      user(login:$login){
        contributionsCollection(from:$from, to:$to){
          totalCommitContributions
          contributionCalendar{
            totalContributions
            weeks{ contributionDays{ date contributionCount } }
          }
        }
      }
    }`,
    { login: USER, from: `${y}-01-01T00:00:00Z`, to: `${y}-12-31T23:59:59Z` },
  );
  const c = d.user.contributionsCollection;
  totalCommits += c.totalCommitContributions;
  totalContrib += c.contributionCalendar.totalContributions;
  for (const w of c.contributionCalendar.weeks) days.push(...w.contributionDays);
}

const lastYear = (
  await gql(
    `query($login:String!){ user(login:$login){ contributionsCollection{ contributionCalendar{ totalContributions } } } }`,
    { login: USER },
  )
).user.contributionsCollection.contributionCalendar.totalContributions;

// ---------- 3. Streaks ----------
const today = new Date().toISOString().slice(0, 10);
const past = [...new Map(days.map((d) => [d.date, d])).values()]
  .filter((d) => d.date <= today)
  .sort((a, b) => a.date.localeCompare(b.date));

let longest = 0, run = 0, runStart = null, longestRange = [null, null];
for (const d of past) {
  if (d.contributionCount > 0) {
    if (run === 0) runStart = d.date;
    run++;
    if (run > longest) { longest = run; longestRange = [runStart, d.date]; }
  } else run = 0;
}

let i = past.length - 1;
if (i >= 0 && past[i].contributionCount === 0) i--; // today may have no commits yet
let current = 0, curEnd = i >= 0 ? past[i].date : null, curStart = curEnd;
while (i >= 0 && past[i].contributionCount > 0) { current++; curStart = past[i].date; i--; }
if (current === 0) curStart = curEnd = null;
const firstDay = past.find((d) => d.contributionCount > 0)?.date ?? null;

// ---------- 4. SVG rendering ----------
const T = {
  bg: '#1a1b27', border: '#2a2e45', title: '#70a5fd', text: '#a9b1d6',
  value: '#c0caf5', accent: '#bf91f3', icon: '#38bdf8', muted: '#565f89',
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (n) => Number(n).toLocaleString('en-US');
const fmtDate = (s) =>
  s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
const FONT = `font-family="'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif"`;

const frame = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT}>
  <style>
    .fade { opacity: 0; animation: fade .6s ease-in-out forwards; }
    @keyframes fade { to { opacity: 1; } }
  </style>
  <rect x="0.5" y="0.5" rx="10" width="${w - 1}" height="${h - 1}" fill="${T.bg}" stroke="${T.border}"/>
  ${body}
</svg>`;

function statsCard() {
  const rows = [
    ['', 'Total repositories', `${fmt(repos.length)}`, `${fmt(privateCount)} private · ${fmt(publicCount)} public`],
    ['', 'Total commits (all time)', fmt(totalCommits), ''],
    ['', 'Contributions (last year)', fmt(lastYear), ''],
    ['', 'Pull requests', fmt(profile.pullRequests.totalCount), ''],
    ['', 'Issues', fmt(profile.issues.totalCount), ''],
    ['', 'Stars earned', fmt(stars), ''],
  ];
  const body = rows
    .map(([, label, val, note], k) => {
      const y = 72 + k * 22;
      return `<g class="fade" style="animation-delay:${150 + k * 120}ms">
        <circle cx="31" cy="${y - 4}" r="4" fill="${T.icon}"/>
        <text x="48" y="${y}" font-size="13" fill="${T.text}" font-weight="600">${esc(label)}:</text>
        <text x="245" y="${y}" font-size="13" fill="${T.value}" font-weight="700">${esc(val)}</text>
        ${note ? `<text x="290" y="${y}" font-size="11" fill="${T.muted}">${esc(note)}</text>` : ''}
      </g>`;
    })
    .join('\n');
  return frame(495, 205, `
  <text x="25" y="38" font-size="18" font-weight="700" fill="${T.title}">Khudayor's GitHub Stats</text>
  <text x="470" y="38" font-size="11" fill="${T.muted}" text-anchor="end">public + private</text>
  ${body}`);
}

function langsCard() {
  const barW = 300;
  let x = 0;
  const segs = langs
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const r = `<rect x="${25 + x}" y="52" width="${w}" height="8" fill="${l.color}"/>`;
      x += w;
      return r;
    })
    .join('');
  const items = langs
    .map((l, k) => {
      const col = k % 2, row = Math.floor(k / 2);
      const cx = 25 + col * 155, cy = 88 + row * 26;
      return `<g class="fade" style="animation-delay:${150 + k * 100}ms">
        <circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${l.color}"/>
        <text x="${cx + 16}" y="${cy}" font-size="12" fill="${T.text}">${esc(l.name)} <tspan fill="${T.muted}">${l.pct.toFixed(1)}%</tspan></text>
      </g>`;
    })
    .join('\n');
  return frame(350, 205, `
  <text x="25" y="38" font-size="18" font-weight="700" fill="${T.title}">Most Used Languages</text>
  <clipPath id="bar"><rect x="25" y="52" width="${barW}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#bar)">${segs}</g>
  ${items}`);
}

function streakCard() {
  const col = (cx, num, label, range, color, delay) => `<g class="fade" style="animation-delay:${delay}ms">
    <text x="${cx}" y="92" font-size="28" font-weight="700" fill="${color}" text-anchor="middle">${esc(num)}</text>
    <text x="${cx}" y="128" font-size="14" fill="${T.value}" text-anchor="middle" font-weight="600">${esc(label)}</text>
    <text x="${cx}" y="152" font-size="11" fill="${T.muted}" text-anchor="middle">${esc(range)}</text>
  </g>`;
  return frame(495, 195, `
  <line x1="165" y1="35" x2="165" y2="160" stroke="${T.border}"/>
  <line x1="330" y1="35" x2="330" y2="160" stroke="${T.border}"/>
  ${col(82, fmt(totalContrib), 'Total Contributions', `${fmtDate(firstDay)} – Present`, T.icon, 150)}
  <g class="fade" style="animation-delay:300ms">
    <circle cx="247" cy="80" r="40" fill="none" stroke="${T.accent}" stroke-width="5"/>
    <text x="247" y="90" font-size="28" font-weight="700" fill="${T.value}" text-anchor="middle">${current}</text>
    <text x="247" y="148" font-size="14" fill="${T.accent}" text-anchor="middle" font-weight="700">Current Streak</text>
    <text x="247" y="170" font-size="11" fill="${T.muted}" text-anchor="middle">${current ? `${fmtDate(curStart)} – ${fmtDate(curEnd)}` : 'Start a new streak today!'}</text>
  </g>
  ${col(412, fmt(longest), 'Longest Streak', longest ? `${fmtDate(longestRange[0])} – ${fmtDate(longestRange[1])}` : '—', T.icon, 450)}
  `);
}

mkdirSync('assets', { recursive: true });
writeFileSync('assets/stats.svg', statsCard());
writeFileSync('assets/langs.svg', langsCard());
writeFileSync('assets/streak.svg', streakCard());

console.log({
  repos: repos.length, privateCount, publicCount, totalCommits, lastYear, totalContrib,
  current, longest, topLangs: langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`),
});
