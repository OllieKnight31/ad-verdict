'use strict';
// Test preload: replaces global fetch so the LIVE code path of pull-meta-ads.js can be run
// with no network. Serves the invented fixture, in small pages, and records every request.
// Usage: MOCK_FIXTURE=<fixture.json> MOCK_LOG=<file> [MOCK_FAIL=<kind>:<code>] node -r ./mock-fetch.js pull-meta-ads.js ...
const fs = require('fs');
const fx = JSON.parse(fs.readFileSync(process.env.MOCK_FIXTURE, 'utf8')).responses;
const [failKind, failCode] = (process.env.MOCK_FAIL || ':').split(':');
const log = line => fs.appendFileSync(process.env.MOCK_LOG, line + '\n');
const PAGE = 7;

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || 'GET').toUpperCase();
  log(`${method} ${u.host}${u.pathname} token=${u.searchParams.get('access_token') === 'fake_token_for_mock_tests' ? 'expected-fake' : 'UNEXPECTED'}`);
  if (process.env.MOCK_FAIL === 'network:down') { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
  const reply = body => ({ status: 200, json: async () => body });
  if (u.host !== 'graph.facebook.com' || method !== 'GET') return reply({ error: { code: 'mock', message: 'unexpected host or method' } });
  const parts = u.pathname.split('/').filter(Boolean); // [version, id, edge?]
  const id = parts[1], edge = parts[2];
  let kind, key;
  if (!edge) { kind = 'account'; key = 'account'; }
  else if (edge === 'campaigns') { kind = 'campaigns'; key = 'campaigns'; }
  else if (edge === 'insights') { kind = u.searchParams.get('time_increment') ? 'insights_daily' : u.searchParams.get('level') === 'ad' ? 'insights_lifetime' : 'insights_totals'; key = `${kind}:${id}`; }
  else { kind = edge; key = `${edge}:${id}`; }
  if (kind === failKind) return reply({ error: { code: Number(failCode), message: `Invented error ${failCode} for tests`, type: 'OAuthException' } });
  if (!(key in fx)) return reply({ error: { code: 100, message: `mock has nothing for ${key}` } });
  if (kind === 'account') return reply(fx[key]);
  // Join the fixture's own pages, then re-serve in pages of 7 behind real looking "next" URLs.
  let rows = []; let k = key;
  while (k) { rows = rows.concat(fx[k].data); k = fx[k].paging && fx[k].paging.next; }
  const off = Number(u.searchParams.get('mock_offset') || 0);
  const body = { data: rows.slice(off, off + PAGE) };
  if (off + PAGE < rows.length) { const n = new URL(url); n.searchParams.set('mock_offset', String(off + PAGE)); body.paging = { next: n.toString() }; }
  return reply(body);
};
