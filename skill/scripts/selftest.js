#!/usr/bin/env node
'use strict';
// Offline self test for ad-verdict-skill. Uses invented numbers only. No network, no token, no ad account.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lib');
const V = require('./verdict');

let pass = 0; const failed = [];
function t(name, fn) {
  try { fn(); pass++; if (process.argv.includes('--verbose')) console.log(`ok   ${name}`); }
  catch (e) { failed.push(name); console.log(`FAIL ${name}\n     ${String(e.message).split('\n')[0]}`); }
}
const cfg = { target: 10, breakeven: 20 };
const day = (i, s, c) => ({ d: `2026-01-${String(i).padStart(2, '0')}`, s, c });
const spread = (spend, conv, n = 4) => Array.from({ length: n }, (_, i) => day(i + 1, spend / n, conv / n));
const judge = (spend, conv, extra = {}) => V.judgeAd({ spend, conv, frequency: 1.2, learning: false, days: spread(spend, conv), ...extra }, cfg);
const is = (r, verdict, rule) => { assert.strictEqual(r.verdict, verdict); assert.strictEqual(r.rule, rule); };

// Allowable CPL
t('breakeven = front end cash / results', () => assert.strictEqual(L.computeBreakeven({ front_end_cash: 4800, results: 400 }), 12));
t('breakeven rounds to pence', () => assert.strictEqual(L.computeBreakeven({ front_end_cash: 1000, results: 3 }), 333.33));
t('breakeven refuses zero results', () => assert.strictEqual(L.computeBreakeven({ front_end_cash: 100, results: 0 }), null));
t('breakeven refuses missing numbers', () => assert.strictEqual(L.computeBreakeven({}), null));

// KILL thresholds
t('KILL: zero conversions at exactly 2 x breakeven', () => is(judge(40, 0), 'KILL', 'zero-conversions'));
t('no kill: zero conversions just under 2 x breakeven', () => is(judge(39.99, 0), 'HOLD', 'above-target'));
t('KILL: CPL over 2.5 x target with enough spend', () => is(judge(52, 2), 'KILL', 'cpl-too-high'));
t('no kill: CPL exactly 2.5 x target', () => is(judge(50, 2), 'HOLD', 'above-target'));
t('no kill: CPL over 2.5 x target but spend under 1.5 x breakeven', () => is(judge(26, 1), 'HOLD', 'underspent'));
t('KILL: spend since last conversion at 2.5 x breakeven beats a good lifetime CPL', () => is(V.judgeAd({ spend: 100, conv: 10, frequency: 1, days: [day(1, 50, 10), day(2, 25, 0), day(3, 25, 0)] }, cfg), 'KILL', 'died-mid-flight'));
t('no kill: spend since last conversion just under 2.5 x breakeven', () => assert.notStrictEqual(V.judgeAd({ spend: 99.99, conv: 10, frequency: 1, days: [day(1, 50, 10), day(2, 25, 0), day(3, 24.99, 0)] }, cfg).verdict, 'KILL'));
const rises = [day(1, 12, 1), day(2, 13, 1), day(3, 14, 1), day(4, 15, 1)];
t('KILL: frequency over 3.5 with CPL up 3 days running', () => is(V.judgeAd({ spend: 54, conv: 4, frequency: 3.6, days: rises }, cfg), 'KILL', 'fatigue'));
t('no kill: frequency exactly 3.5', () => assert.notStrictEqual(V.judgeAd({ spend: 54, conv: 4, frequency: 3.5, days: rises }, cfg).verdict, 'KILL'));
t('no kill: high frequency but CPL up only 2 days', () => assert.notStrictEqual(V.judgeAd({ spend: 39, conv: 3, frequency: 3.9, days: rises.slice(1) }, cfg).verdict, 'KILL'));

// SCALE thresholds
t('SCALE: CPL exactly at target with 5 conversions', () => { const r = judge(50, 5); is(r, 'SCALE', 'winner'); assert.strictEqual(r.tier, 'standard'); });
t('no scale: 4 conversions', () => is(judge(40, 4), 'HOLD', 'low-volume'));
t('no scale: CPL a penny over target', () => assert.strictEqual(judge(50.05, 5).verdict, 'HOLD'));
t('SCALE champion: CPL exactly 60% of target', () => { const r = judge(60, 10); is(r, 'SCALE', 'champion'); assert.strictEqual(r.tier, 'champion'); });
t('SCALE standard: CPL just over 60% of target', () => assert.strictEqual(judge(60.1, 10).tier, 'standard'));
t('no scale: last 2 days both above breakeven', () => is(V.judgeAd({ spend: 100, conv: 12, frequency: 1, days: [day(1, 50, 10), day(2, 25, 1), day(3, 25, 1)] }, cfg), 'HOLD', 'recent-slump'));

// HOLD reasons
t('HOLD: no spend', () => is(judge(0, 0), 'HOLD', 'no-delivery'));
t('HOLD: learning with CPL under breakeven', () => is(judge(60, 4, { learning: true }), 'HOLD', 'learning'));
t('HOLD: within 25% of target and worsening', () => is(V.judgeAd({ spend: 66, conv: 6, frequency: 1, days: [day(1, 8, 1), day(2, 8, 1), day(3, 8, 1), day(4, 14, 1), day(5, 14, 1), day(6, 14, 1)] }, cfg), 'HOLD', 'drifting'));

// Trend maths
t('trend: spend since last conversion, rising days, 3 day rolling CPL', () => {
  const tr = V.trend([day(3, 30, 1), day(1, 10, 1), day(2, 20, 1), day(4, 9, 0)], 20);
  assert.strictEqual(tr.spendSinceLastConv, 9); assert.strictEqual(tr.risingDays, 3); assert.strictEqual(tr.rolling3, 29.5); assert.strictEqual(tr.twoDaysAboveBreakeven, false);
});

// Config and token handling
const good = { act_id: '1234567890', conversion_event: 'lead', target_cpl: 8, breakeven_cpl: null, economics: { front_end_cash: 4800, results: 400 } };
t('config: bare account number gains act_ and breakeven comes from economics', () => { const c = L.normaliseConfig(good); assert.strictEqual(c.act_id, 'act_1234567890'); assert.strictEqual(c.breakeven_cpl, 12); assert.strictEqual(c.api_version, L.DEFAULT_API_VERSION); });
t('config: every problem is reported', () => assert.throws(() => L.normaliseConfig({ act_id: 'abc', target_cpl: '8' }), e => e instanceof L.UserError && /act_id/.test(e.message) && /conversion_event/.test(e.message) && /target_cpl/.test(e.message) && /breakeven_cpl/.test(e.message)));
t('config: warns when target is above breakeven', () => assert.strictEqual(L.normaliseConfig({ ...good, target_cpl: 30 }).warnings.length, 1));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-selftest-'));
const envFile = path.join(tmp, 'env');
const tok = v => L.readToken({ token_source: { file: envFile, var: 'META_ACCESS_TOKEN' } }, {}).token === v;
t('token: plain, quoted and export lines are read; a longer variable name is not mistaken for it', () => {
  fs.writeFileSync(envFile, '# note\nMY_META_ACCESS_TOKEN=wrong_one\nMETA_ACCESS_TOKEN=fake_token_for_tests\n'); assert.ok(tok('fake_token_for_tests'));
  fs.writeFileSync(envFile, 'export META_ACCESS_TOKEN="fake_token_for_tests"\n'); assert.ok(tok('fake_token_for_tests'));
});
t('token: placeholder, missing variable and missing file are refused clearly', () => {
  fs.writeFileSync(envFile, `META_ACCESS_TOKEN=${L.PLACEHOLDER_TOKEN}\n`); assert.throws(() => tok(''), L.UserError);
  fs.writeFileSync(envFile, 'OTHER=1\n'); assert.throws(() => tok(''), L.UserError);
  fs.unlinkSync(envFile); assert.throws(() => tok(''), L.UserError);
});
t('token: environment variable wins over the file', () => assert.strictEqual(L.readToken({ token_source: { var: 'META_ACCESS_TOKEN' } }, { META_ACCESS_TOKEN: 'fake_env_token' }).token, 'fake_env_token'));
t('money: pounds, yen without pence, unknown code', () => { assert.strictEqual(L.money(87.9, 'GBP'), '£87.90'); assert.strictEqual(L.money(1500, 'JPY'), 'JPY 1500'); assert.strictEqual(L.minorOffset('JPY'), 1); assert.strictEqual(L.minorOffset('GBP'), 100); });
t('args: value, equals form and bare flags', () => { const a = L.parseArgs(['--client', 'x', '--since=2026-01-01', '--check', '--outdir'], ['check']); assert.deepStrictEqual([a.client, a.since, a.check, a.outdir], ['x', '2026-01-01', true, true]); });
t('dates: real dates only', () => { assert.ok(L.isDate('2026-02-28')); assert.ok(!L.isDate('2026-02-30')); assert.ok(!L.isDate('28/02/2026')); });

// Whole flow on the invented demo account: pull from the fixture, then judge.
const node = process.execPath;
const pull = spawnSync(node, [path.join(__dirname, 'pull-meta-ads.js'), '--demo', '--outdir', tmp], { encoding: 'utf8' });
t('demo pull exits 0', () => assert.strictEqual(pull.status, 0, pull.stderr));
const dumpFile = path.join(tmp, 'ad-verdict-example-2026-01-11.json');
const ver = spawnSync(node, [path.join(__dirname, 'verdict.js'), '--dump', dumpFile, '--json'], { encoding: 'utf8' });
t('demo verdict exits 0', () => assert.strictEqual(ver.status, 0, ver.stderr));
let res = { campaigns: [{ ads: [], revive: [], summary: {}, flags: [] }] };
try { res = JSON.parse(ver.stdout); } catch (e) { /* reported by the tests below */ }
const camp = res.campaigns[0];
const got = Object.fromEntries(camp.ads.map(a => [a.ad_name, `${a.verdict}:${a.rule}`]));
const want = {
  'Angle 01 Champion': 'SCALE:champion', 'Angle 02 Winner': 'SCALE:winner', 'Angle 12 Twin': 'SCALE:winner',
  'Angle 07 Underspent': 'HOLD:underspent', 'Angle 08 Learning': 'HOLD:learning', 'Angle 09 Drifting': 'HOLD:drifting',
  'Angle 03 Zero': 'KILL:zero-conversions', 'Angle 04 Expensive': 'KILL:cpl-too-high', 'Angle 05 Died': 'KILL:died-mid-flight', 'Angle 06 Fatigue': 'KILL:fatigue',
};
t('demo: all 10 live ads get the expected verdict', () => assert.deepStrictEqual(got, want));
t('demo: breakeven 12 worked out from economics, target 8', () => { assert.strictEqual(res.breakeven_cpl, 12); assert.strictEqual(res.target_cpl, 8); });
t('demo: paged daily rows all arrive (66 rows over 2 pages)', () => assert.strictEqual(JSON.parse(fs.readFileSync(dumpFile, 'utf8')).active[0].daily.length, 66));
t('demo: new budgets 26.00 (+30%) and 24.00 (+20%), raised once per ad set', () => { const b = camp.ads.filter(a => a.new_daily_budget).map(a => a.new_daily_budget).sort(); assert.deepStrictEqual(b, [24, 26]); });
t('demo: money summary 180 now, 80 freed, 10 added, 110 after, blended CPL 8.35', () => { const s = camp.summary; assert.deepStrictEqual([s.daily_budget_now, s.freed_per_day, s.added_per_day, s.daily_budget_after, s.blended_cpl], [180, 80, 10, 110, 8.35]); });
t('demo: one revive candidate, the paused ad with a good final day', () => assert.deepStrictEqual(camp.revive.map(r => r.ad_name), ['Angle 10 Paused Early']));
t('demo: page bottleneck flagged at 12.5%', () => { assert.strictEqual(camp.summary.lpv_to_conv, 12.5); assert.ok(camp.flags.some(f => /page/.test(f))); });
t('demo: the dump holds no token details', () => assert.ok(!/token/i.test(fs.readFileSync(dumpFile, 'utf8'))));
t('demo: only the chosen conversion event is counted (duplicates ignored)', () => assert.strictEqual(camp.summary.conversions, 82));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nSelf test: ${pass} passed, ${failed.length} failed.`);
process.exitCode = failed.length ? 1 : 0;
