#!/usr/bin/env node
'use strict';
// ad-verdict-skill data puller. Read only: every request is an HTTP GET. No dependencies. Node 18 or newer.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const HELP = `ad-verdict-skill: pull Meta ads data (read only)

Usage:
  node pull-meta-ads.js --client <name> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--outdir <dir>]
  node pull-meta-ads.js --client <name> --check
  node pull-meta-ads.js --demo [--outdir <dir>]

Options:
  --client <name>   Config to use: clients/<name>.json inside the skill folder.
                    Optional when exactly one config other than example.json exists.
  --since, --until  Reporting window. Default: each campaign's start date to today.
  --outdir <dir>    Where the raw JSON dump is written. Default: the current folder.
  --check           Validate the config and find the token. Makes no network call.
  --fixture <file>  Read saved responses from a JSON file instead of calling Meta.
  --demo            Same as --client example --fixture fixtures/demo-account.json.
                    Needs no token, no ad account and no internet connection.
  --help            Show this text.

Exit codes: 0 complete, 1 could not run, 2 ran but some data is missing (do not trust verdicts).
This script never changes anything in the ad account.`;

const HINTS = {
  190: 'The access token is invalid or has expired. Create a new token (README, "Create the Meta token") and paste it into the token file.',
  10: 'The token is missing a permission. It needs ads_read, and the user or system user behind it needs access to this ad account.',
  200: 'The token is missing a permission. It needs ads_read, and the user or system user behind it needs access to this ad account.',
  100: 'Meta rejected the request. Check act_id in the client config (act_ followed by the numeric account id) and that this token can see that account.',
  803: 'Meta does not recognise this id. Check act_id in the client config.',
  2635: 'This Graph API version has been retired. Set "api_version" in the client config to the newest version listed at https://developers.facebook.com/docs/graph-api/changelog',
  4: 'Meta rate limit reached. Wait 15 to 60 minutes and run again.',
  17: 'Meta rate limit reached. Wait 15 to 60 minutes and run again.',
  613: 'Meta rate limit reached. Wait 15 to 60 minutes and run again.',
  80000: 'Meta rate limit reached for this ad account. Wait 15 to 60 minutes and run again.',
  80004: 'Meta rate limit reached for this ad account. Wait 15 to 60 minutes and run again.',
  1: 'Meta had a temporary problem or the request was too large. Try again with a shorter window using --since.',
  2: 'Meta had a temporary problem. Try again in a few minutes.',
};

async function main() {
  const args = L.parseArgs(process.argv.slice(2), ['help', 'check', 'demo']);
  if (args.help) { console.log(HELP); return 0; }
  if (args.demo) { args.client = args.client || 'example'; args.fixture = args.fixture || path.join(L.SKILL_DIR, 'fixtures', 'demo-account.json'); }
  if (args.client === true || args.fixture === true || args.since === true || args.until === true || args.outdir === true) L.fail('An option is missing its value. Run with --help to see the usage.');
  const client = args.client || L.defaultClient();
  if (!client) {
    const have = L.listClients();
    L.fail(`Say which config to use with --client <name>.\n  Configs present: ${have.length ? have.join(', ') : '(none)'}\n  Run with --help to see the usage, or --demo to try the invented demo account.`);
  }
  for (const k of ['since', 'until']) if (args[k] !== undefined && !L.isDate(args[k])) L.fail(`--${k} must be a real date written as YYYY-MM-DD. Got "${args[k]}".`);
  if (args.since && args.until && args.since > args.until) L.fail('--since must not be later than --until.');

  const cfg = L.loadConfig(client);
  cfg.warnings.forEach(w => console.error(`WARNING: ${w}`));
  const FIXTURE = args.fixture ? loadFixture(args.fixture) : null;
  if (!FIXTURE && cfg.act_id === L.PLACEHOLDER_ACT) L.fail(`clients/${client}.json still has the placeholder ad account id (${L.PLACEHOLDER_ACT}).\n  Put your own ad account id in act_id, or run with --demo to use the invented demo account.`);

  let TOKEN = null;
  if (!FIXTURE) TOKEN = L.readToken(cfg);
  if (args.check) {
    console.log(`Config OK: clients/${client}.json`);
    console.log(`  ad account ${cfg.act_id} | conversion event ${cfg.conversion_event} | target CPL ${cfg.target_cpl} | breakeven CPL ${cfg.breakeven_cpl} (from ${cfg.breakeven_source}) | Graph API ${cfg.api_version}`);
    console.log(FIXTURE ? '  Fixture mode: no token needed.' : `  Token found in ${TOKEN.where} (value not shown).`);
    console.log('No network call was made.');
    return 0;
  }

  const OUT = path.resolve(L.expandHome(args.outdir || process.cwd()));
  if (!fs.existsSync(OUT) || !fs.statSync(OUT).isDirectory()) L.fail(`--outdir is not an existing folder: ${OUT}`);
  const scrub = s => (TOKEN ? String(s).split(TOKEN.token).join('<token>') : String(s));
  const errors = [];

  // One page of one read. Fixture mode looks the key up in the file. Live mode sends a GET.
  async function page(key, url) {
    if (FIXTURE) {
      if (!(key in FIXTURE.responses)) return { error: { code: 'fixture', message: `fixture has no response saved for "${key}"` } };
      return FIXTURE.responses[key];
    }
    let res;
    try { res = await fetch(url, { method: 'GET' }); }
    catch (e) { return { error: { code: 'network', message: `could not reach graph.facebook.com (${scrub(e.cause && e.cause.code ? e.cause.code : e.message)})` } }; }
    try { return await res.json(); }
    catch (e) { return { error: { code: 'http', message: `Meta sent a reply that was not JSON (HTTP ${res.status})` } }; }
  }

  // Reads every page of an edge. Returns { data, ok }.
  async function getAll(key, p, params = {}) {
    const rows = [];
    let k = key;
    let url = FIXTURE ? null : `https://graph.facebook.com/${cfg.api_version}/${p}?${new URLSearchParams({ access_token: TOKEN.token, ...params })}`;
    for (let n = 0; n < 200; n++) {
      const j = await page(k, url);
      if (!j || j.error) {
        const e = (j && j.error) || { message: 'empty reply' };
        const item = { call: key, code: e.code == null ? null : e.code, subcode: e.error_subcode == null ? null : e.error_subcode, message: scrub(e.message || '').slice(0, 300) };
        errors.push(item);
        console.error(`API ERROR on ${key}: (code ${item.code}) ${item.message}`);
        return { data: rows, ok: false, error: item };
      }
      if (Array.isArray(j.data)) rows.push(...j.data); else return { data: j, ok: true };
      const next = j.paging && j.paging.next;
      if (!next) return { data: rows, ok: true };
      if (FIXTURE) k = next; else url = next;
    }
    const item = { call: key, code: 'paging', subcode: null, message: 'more than 200 pages, stopped' };
    errors.push(item);
    return { data: rows, ok: false, error: item };
  }

  function fatal(r, what) {
    const hint = HINTS[r.error.code] || 'See the Troubleshooting section of the README.';
    L.fail(`Could not read ${what}.\n  Meta said: (code ${r.error.code}) ${r.error.message}\n  What to do: ${hint}`);
  }

  const one = (list, type) => (list || []).find(x => x.action_type === type);
  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
  const convOf = a => num((one(a.actions, cfg.conversion_event) || {}).value);
  const lpvOf = a => num((one(a.actions, 'landing_page_view') || {}).value);
  const first = list => num(((list || [])[0] || {}).value);

  const acct = await getAll('account', cfg.act_id, { fields: 'name,currency,timezone_name,account_status' });
  if (!acct.ok) fatal(acct, `ad account ${cfg.act_id}`);
  const account = acct.data;
  const currency = cfg.currency || account.currency || '';
  if (cfg.currency && account.currency && cfg.currency !== account.currency) console.error(`WARNING: config says currency ${cfg.currency} but the ad account reports ${account.currency}. Using ${cfg.currency}; fix the config if that is wrong.`);
  const offset = L.minorOffset(currency);
  const fmt = n => L.money(n, currency);

  const camps = await getAll('campaigns', `${cfg.act_id}/campaigns`, { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,start_time', limit: '100' });
  if (!camps.ok) fatal(camps, 'the campaign list');
  console.log(`=== ACCOUNT: ${account.name || cfg.act_id} (${cfg.act_id}) | currency ${currency || 'unknown'} | ${FIXTURE ? 'FIXTURE DATA, not a live account' : 'live read, Graph API ' + cfg.api_version} ===`);
  console.log('\n=== ALL CAMPAIGNS ===');
  camps.data.forEach(c => console.log(`${String(c.effective_status).padEnd(22)} ${c.id} ${c.name}`));
  const active = camps.data.filter(c => c.effective_status === 'ACTIVE');
  console.log(`\n=== ACTIVE: ${active.length} of ${camps.data.length} ===`);

  const today = FIXTURE && FIXTURE.today ? FIXTURE.today : L.localDate();
  // Meta only serves insights for roughly the last 37 months.
  const floor = new Date(`${today}T00:00:00Z`); floor.setUTCMonth(floor.getUTCMonth() - 36);
  const floorDate = floor.toISOString().slice(0, 10);

  const { token_source, warnings, ...safeCfg } = cfg; // the dump never holds the token or where it lives
  const dump = {
    generated_at: new Date().toISOString(), mode: FIXTURE ? 'fixture' : 'live', api_version: cfg.api_version,
    config: { client, ...safeCfg, currency }, account, campaigns: camps.data, active: [], errors,
  };

  const LIFE = 'adset_name,adset_id,ad_name,ad_id,spend,impressions,reach,frequency,cpm,inline_link_clicks,inline_link_click_ctr,cost_per_inline_link_click,actions,cost_per_action_type,video_play_actions,video_thruplay_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_avg_time_watched_actions';
  for (const c of active) {
    let since = args.since || String(c.start_time || c.created_time || today).slice(0, 10);
    if (since < floorDate) since = floorDate;
    let until = args.until || today;
    if (since > until) since = until;
    const tr = JSON.stringify({ since, until });
    const entry = { campaign: c, since, until };

    const sets = await getAll(`adsets:${c.id}`, `${c.id}/adsets`, { fields: 'id,name,effective_status,daily_budget,lifetime_budget,optimization_goal,learning_stage_info', limit: '100' });
    const ads = await getAll(`ads:${c.id}`, `${c.id}/ads`, { fields: 'id,name,effective_status,adset_id', limit: '200' });
    entry.adsets = sets.data.map(s => ({ ...s, ads: ads.data.filter(a => a.adset_id === s.id) }));
    entry.lifetime = (await getAll(`insights_lifetime:${c.id}`, `${c.id}/insights`, { level: 'ad', fields: LIFE, time_range: tr, limit: '200' })).data;
    entry.daily = (await getAll(`insights_daily:${c.id}`, `${c.id}/insights`, { level: 'ad', fields: 'adset_id,ad_name,ad_id,spend,impressions,inline_link_click_ctr,actions,frequency', time_increment: '1', time_range: tr, limit: '500' })).data;
    entry.totals = (await getAll(`insights_totals:${c.id}`, `${c.id}/insights`, { fields: 'spend,impressions,cpm,inline_link_click_ctr,actions,cost_per_action_type,frequency,reach', time_range: tr })).data;
    dump.active.push(entry);

    console.log(`\n### ${c.name} (${since} to ${until})`);
    const t = entry.totals[0];
    if (t) {
      const r = convOf(t), l = lpvOf(t), sp = num(t.spend);
      console.log(`TOTALS: spend ${fmt(sp)} | conv ${r} | CPL ${r ? fmt(sp / r) : 'n/a'} (target ${fmt(cfg.target_cpl)}, breakeven ${fmt(cfg.breakeven_cpl)}) | LPV to conv ${l && r ? (r / l * 100).toFixed(1) + '%' : 'n/a'} | freq ${num(t.frequency).toFixed(2)}`);
    } else {
      console.log('TOTALS: no delivery in this window.');
    }
    const statusOf = {};
    entry.adsets.forEach(s => s.ads.forEach(a => { statusOf[a.id] = a.effective_status; }));
    for (const a of entry.lifetime) {
      const imp = num(a.impressions), plays = first(a.video_play_actions), thru = first(a.video_thruplay_watched_actions);
      const r = convOf(a), sp = num(a.spend);
      const set = entry.adsets.find(s => s.id === a.adset_id);
      const st = statusOf[a.ad_id] || (set && set.effective_status) || 'UNKNOWN';
      let budget = 'budget n/a';
      if (set && set.daily_budget) budget = `budget ${fmt(num(set.daily_budget) / offset)}/day`;
      else if (set && set.lifetime_budget) budget = `lifetime budget ${fmt(num(set.lifetime_budget) / offset)}`;
      else if (c.daily_budget) budget = `campaign budget ${fmt(num(c.daily_budget) / offset)}/day`;
      else if (c.lifetime_budget) budget = `campaign lifetime budget ${fmt(num(c.lifetime_budget) / offset)}`;
      console.log([
        `${st !== 'ACTIVE' ? `[${st}] ` : ''}${a.ad_name} (${a.adset_name})`, budget,
        `spend ${fmt(sp)}`, `conv ${r}`, `CPL ${r ? fmt(sp / r) : 'n/a'}`,
        `linkCTR ${num(a.inline_link_click_ctr).toFixed(2)}%`, `cpc ${fmt(num(a.cost_per_inline_link_click))}`,
        `cpm ${fmt(num(a.cpm))}`, `freq ${num(a.frequency).toFixed(2)}`, `LPV ${lpvOf(a)}`,
        `hook ${imp ? (plays / imp * 100).toFixed(0) : 0}%`, `hold ${plays ? (thru / plays * 100).toFixed(1) : 0}%`,
      ].join(' | '));
    }
    const by = {};
    for (const r of entry.daily) (by[r.ad_id] = by[r.ad_id] || { name: r.ad_name, rows: [] }).rows.push({ d: r.date_start, s: num(r.spend), c: convOf(r) });
    console.log('--- daily trend: date: spend/conversions (CPL) ---');
    for (const { name, rows } of Object.values(by)) {
      rows.sort((x, y) => String(x.d).localeCompare(String(y.d)));
      console.log(String(name).padEnd(34), rows.map(r => `${String(r.d).slice(5)}: ${r.s.toFixed(0)}/${r.c} (${r.c ? (r.s / r.c).toFixed(1) : 'n/a'})`).join('  '));
    }
  }

  const out = path.join(OUT, `ad-verdict-${client}-${today}.json`);
  fs.writeFileSync(out, JSON.stringify(dump, null, 2));
  console.log(`\nRaw dump written to: ${out}`);
  console.log(`Next step: node "${path.join(__dirname, 'verdict.js')}" --dump "${out}"`);
  if (errors.length) {
    console.error(`\nINCOMPLETE: ${errors.length} read(s) failed, listed above and saved in the dump under "errors". Do not act on verdicts from this pull.`);
    const hint = HINTS[errors[0].code];
    if (hint) console.error(`What to do: ${hint}`);
    return 2;
  }
  return 0;
}

function loadFixture(file) {
  const f = path.resolve(L.expandHome(file));
  if (!fs.existsSync(f)) L.fail(`Fixture file not found: ${f}`);
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { L.fail(`Fixture file is not valid JSON: ${e.message}`); }
  if (!j || typeof j.responses !== 'object' || !j.responses) L.fail('Fixture file must hold a "responses" object.');
  return j;
}

main().then(code => { process.exitCode = code; }).catch(e => {
  if (e instanceof L.UserError) console.error(`ERROR: ${e.message}`);
  else console.error(`UNEXPECTED ERROR: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
