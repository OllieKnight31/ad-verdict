#!/usr/bin/env node
'use strict';
// ad-verdict-skill verdict engine. Works only on a dump file written by pull-meta-ads.js.
// It makes no network calls and changes nothing in any ad account.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const HELP = `ad-verdict-skill: Scale, Kill or Hold verdict for every ad in a dump

Usage:
  node verdict.js --dump <ad-verdict-NAME-DATE.json> [--json] [--allow-incomplete]

Options:
  --dump <file>        The file written by pull-meta-ads.js.
  --json               Print the verdicts as JSON instead of a report.
  --allow-incomplete   Judge a dump even though some reads failed (not advised).
  --help               Show this text.

Rules (T = target CPL, B = breakeven CPL, both from the client config):
  KILL  if any:  spend >= 2 x B with 0 conversions
                 CPL > 2.5 x T once spend >= 1.5 x B
                 spend since the last conversion day >= 2.5 x B
                 frequency > 3.5 and daily CPL up 3 days running
  SCALE if all:  CPL <= T, 5 or more conversions, and the last 2 days are not both above B
                 +20% ad set budget, or +30% when CPL <= 60% of T (champion)
  HOLD  otherwise, with the reason and the kill line.
Kill rules are checked first, then Scale, then Hold.
This script only reads a file. It never changes an ad account.`;

const R = { KILL_ZERO: 2, KILL_CPL: 2.5, MIN_SPEND: 1.5, KILL_DRY: 2.5, FREQ: 3.5, RISE_DAYS: 3, SCALE_CONV: 5, CHAMPION: 0.6, STEP: 0.2, STEP_CHAMPION: 0.3, BAND: 0.25, CONSOLIDATE_ADS: 3, CONSOLIDATE_CONV: 20, MIN_SLOTS: 3, PAGE_FLOOR: 15, PAGE_GOOD: 25 };

const round2 = n => Math.round(n * 100) / 100;
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));

// days: [{ d: 'YYYY-MM-DD', s: spend, c: conversions }] in any order.
function trend(days, breakeven) {
  const rows = (days || []).filter(r => r.s > 0 || r.c > 0).sort((a, b) => String(a.d).localeCompare(String(b.d)));
  const cpl = r => (r.c > 0 ? r.s / r.c : (r.s > 0 ? Infinity : null));
  let lastConv = -1;
  rows.forEach((r, i) => { if (r.c > 0) lastConv = i; });
  const spendSinceLastConv = round2(rows.slice(lastConv + 1).reduce((t, r) => t + r.s, 0));
  let rising = 0;
  for (let i = rows.length - 1; i > 0; i--) { if (cpl(rows[i]) > cpl(rows[i - 1])) rising++; else break; }
  const above = r => (r.c > 0 ? r.s / r.c > breakeven : r.s >= breakeven);
  const last2 = rows.slice(-2);
  const twoDaysAboveBreakeven = last2.length === 2 && last2.every(above);
  const last3 = rows.slice(-3);
  const s3 = last3.reduce((t, r) => t + r.s, 0), c3 = last3.reduce((t, r) => t + r.c, 0);
  const rolling3 = rows.length ? (c3 > 0 ? round2(s3 / c3) : (s3 > 0 ? Infinity : null)) : null;
  const last = rows[rows.length - 1] || null;
  return { rows, spendSinceLastConv, risingDays: rising, twoDaysAboveBreakeven, rolling3, finalDay: last, finalDayCpl: last ? cpl(last) : null };
}

// ad: { spend, conv, frequency, learning (bool), days }  cfg: { target, breakeven }
function judgeAd(ad, cfg) {
  const T = cfg.target, B = cfg.breakeven;
  const spend = num(ad.spend), conv = num(ad.conv), freq = num(ad.frequency);
  const cpl = conv > 0 ? round2(spend / conv) : null;
  const tr = trend(ad.days, B);
  const worsening = cpl != null && tr.rolling3 != null && tr.rows.length > 3 && tr.rolling3 > cpl;
  const out = { verdict: 'HOLD', rule: '', reason: '', tier: null, cpl, worsening, trend: tr };
  const set = (verdict, rule, reason, tier = null) => Object.assign(out, { verdict, rule, reason, tier });

  if (spend <= 0) return set('HOLD', 'no-delivery', 'No spend in this window. Nothing to judge. If the ad is approved and still not delivering, check the account for policy flags before blaming the creative.');
  if (conv === 0 && spend >= R.KILL_ZERO * B) return set('KILL', 'zero-conversions', `Spent ${round2(spend)} with no conversions, which is at or over 2 x breakeven (${round2(R.KILL_ZERO * B)}).`);
  if (cpl != null && cpl > R.KILL_CPL * T && spend >= R.MIN_SPEND * B) return set('KILL', 'cpl-too-high', `CPL ${cpl} is above 2.5 x target (${round2(R.KILL_CPL * T)}) after enough spend to judge (${round2(R.MIN_SPEND * B)} or more).`);
  if (conv > 0 && tr.spendSinceLastConv >= R.KILL_DRY * B) return set('KILL', 'died-mid-flight', `Spent ${tr.spendSinceLastConv} since its last conversion day, which is at or over 2.5 x breakeven (${round2(R.KILL_DRY * B)}).`);
  if (freq > R.FREQ && tr.risingDays >= R.RISE_DAYS) return set('KILL', 'fatigue', `Frequency ${freq.toFixed(2)} is above 3.5 and daily CPL has risen ${tr.risingDays} days running.`);

  if (cpl != null && cpl <= T && conv >= R.SCALE_CONV && !tr.twoDaysAboveBreakeven) {
    const champion = cpl <= R.CHAMPION * T;
    return set('SCALE', champion ? 'champion' : 'winner', champion
      ? `CPL ${cpl} is at or under 60% of target (${round2(R.CHAMPION * T)}) on ${conv} conversions.`
      : `CPL ${cpl} is at or under target (${T}) on ${conv} conversions and the last 2 days are not both above breakeven.`, champion ? 'champion' : 'standard');
  }

  const killLine = `Kill if 3 day rolling CPL goes above breakeven (${B}).`;
  if (spend < R.MIN_SPEND * B) return set('HOLD', 'underspent', `No verdict yet: spend ${round2(spend)} is under 1.5 x breakeven (${round2(R.MIN_SPEND * B)}). Let it spend.`);
  if (ad.learning && cpl != null && cpl <= B) return set('HOLD', 'learning', `In learning with CPL ${cpl} at or under breakeven (${B}). Do not touch: edits restart learning. ${killLine}`);
  if (cpl != null && Math.abs(cpl - T) <= R.BAND * T && worsening) return set('HOLD', 'drifting', `CPL ${cpl} is within 25% of target but the last 3 days (${tr.rolling3 === Infinity ? 'no conversions' : tr.rolling3}) are worse than lifetime. Hold 48 hours. ${killLine}`);
  if (cpl != null && cpl <= T && tr.twoDaysAboveBreakeven) return set('HOLD', 'recent-slump', `Lifetime CPL ${cpl} is under target but the last 2 days were both above breakeven. Do not scale into a slump. ${killLine}`);
  if (cpl != null && cpl <= T) return set('HOLD', 'low-volume', `CPL ${cpl} is under target but only ${conv} conversion(s). Under 5 is noise. Let it run.`);
  return set('HOLD', 'above-target', `${cpl == null ? 'No conversions yet' : `CPL ${cpl} is above target (${T})`} but no kill rule is met. ${killLine}`);
}

// Turns a dump into verdicts for every ad in every active campaign.
function analyse(dump) {
  const c = dump.config || {};
  const cfg = { target: Number(c.target_cpl), breakeven: Number(c.breakeven_cpl) };
  if (!(cfg.target > 0) || !(cfg.breakeven > 0)) L.fail('The dump has no usable target_cpl and breakeven_cpl. Pull again with a valid client config.');
  const event = c.conversion_event;
  const currency = c.currency || (dump.account && dump.account.currency) || '';
  const offset = L.minorOffset(currency);
  const convOf = a => num(((a.actions || []).find(x => x.action_type === event) || {}).value);
  const lpvOf = a => num(((a.actions || []).find(x => x.action_type === 'landing_page_view') || {}).value);
  const first = list => num(((list || [])[0] || {}).value);
  const result = { client: c.client, mode: dump.mode, currency, target_cpl: cfg.target, breakeven_cpl: cfg.breakeven, conversion_event: event, incomplete: (dump.errors || []).length > 0, campaigns: [] };

  for (const e of dump.active || []) {
    const camp = e.campaign || {};
    const adsets = {}; const adStatus = {}; const adsInSet = {};
    for (const s of e.adsets || []) { adsets[s.id] = s; for (const a of s.ads || []) { adStatus[a.id] = a.effective_status; (adsInSet[s.id] = adsInSet[s.id] || []).push(a); } }
    const daily = {};
    for (const r of e.daily || []) (daily[r.ad_id] = daily[r.ad_id] || []).push({ d: r.date_start, s: num(r.spend), c: convOf(r) });

    const live = []; const paused = [];
    for (const a of e.lifetime || []) {
      const set = adsets[a.adset_id] || null;
      const status = adStatus[a.ad_id] || (set ? set.effective_status : 'UNKNOWN');
      const imp = num(a.impressions), plays = first(a.video_play_actions), thru = first(a.video_thruplay_watched_actions);
      const conv = convOf(a), lpv = lpvOf(a);
      const learning = !!(set && set.learning_stage_info && /^LEARNING$/i.test(String(set.learning_stage_info.status || '')));
      const row = {
        ad_id: a.ad_id, ad_name: a.ad_name, adset_id: a.adset_id, adset_name: a.adset_name, status,
        spend: num(a.spend), conv, frequency: num(a.frequency), link_ctr: num(a.inline_link_click_ctr), cpc: num(a.cost_per_inline_link_click), cpm: num(a.cpm),
        lpv, lpv_to_conv: lpv ? round2(conv / lpv * 100) : null, hook_rate: imp ? round2(plays / imp * 100) : null, hold_rate: plays ? round2(thru / plays * 100) : null,
        learning, adset_daily_budget: set && set.daily_budget ? num(set.daily_budget) / offset : null,
      };
      const v = judgeAd({ spend: row.spend, conv, frequency: row.frequency, learning, days: daily[a.ad_id] || [] }, cfg);
      Object.assign(row, { cpl: v.cpl, daily: v.trend.rows, final_day_cpl: v.trend.finalDayCpl });
      if (status === 'ACTIVE' && (!set || set.effective_status === 'ACTIVE')) {
        Object.assign(row, { verdict: v.verdict, rule: v.rule, reason: v.reason, tier: v.tier });
        live.push(row);
      } else {
        const fd = v.trend.finalDay;
        row.revive = !!(fd && fd.c > 0 && fd.s / fd.c < cfg.target);
        paused.push(row);
      }
    }

    // Actions. Budgets move once per ad set, however many of its ads qualify.
    const scaled = {}; let freed = 0; let added = 0;
    const order = { SCALE: 0, HOLD: 1, KILL: 2 };
    live.sort((a, b) => order[a.verdict] - order[b.verdict] || (a.cpl == null ? 1e12 : a.cpl) - (b.cpl == null ? 1e12 : b.cpl));
    const bestTier = {};
    live.filter(r => r.verdict === 'SCALE').forEach(r => { if (r.tier === 'champion' || !bestTier[r.adset_id]) bestTier[r.adset_id] = r.tier; });
    for (const r of live) {
      const money = n => L.money(n, currency);
      if (r.verdict === 'SCALE') {
        const pct = bestTier[r.adset_id] === 'champion' ? R.STEP_CHAMPION : R.STEP;
        const extra = r.tier === 'champion' ? ' Also queue a horizontal duplicate: clone this ad into a fresh broad ad set at the original budget.' : '';
        const caution = r.learning ? ' Caution: the ad set is in learning and a budget change restarts it; that is accepted for angle tests on small budgets.' : '';
        if (scaled[r.adset_id]) r.action = `Covered by the budget rise already listed for ad set "${r.adset_name}".${extra}`;
        else if (r.adset_daily_budget) {
          const nb = round2(r.adset_daily_budget * (1 + pct));
          added += nb - r.adset_daily_budget; scaled[r.adset_id] = true; r.new_daily_budget = nb;
          r.action = `Raise ad set "${r.adset_name}" from ${money(r.adset_daily_budget)} to ${money(nb)} per day (+${pct * 100}%). Wait 24 to 48 hours before the next rise. Never more than +30% in one step.${extra}${caution}`;
        } else if (camp.daily_budget) {
          const cb = num(camp.daily_budget) / offset; const nb = round2(cb * (1 + pct));
          if (!scaled[`c:${camp.id}`]) { added += nb - cb; scaled[`c:${camp.id}`] = true; r.action = `Budget sits on the campaign. Raise the campaign from ${money(cb)} to ${money(nb)} per day (+${pct * 100}%).${extra}${caution}`; }
          else r.action = `Covered by the campaign budget rise already listed.${extra}`;
        } else r.action = `No daily budget found (lifetime budget or unknown). Raise the budget by ${pct * 100}% by hand.${extra}${caution}`;
      } else if (r.verdict === 'KILL') {
        const others = (adsInSet[r.adset_id] || []).filter(a => a.id !== r.ad_id && a.effective_status === 'ACTIVE').length;
        if (others === 0 && r.adset_daily_budget) { freed += r.adset_daily_budget; r.freed_per_day = r.adset_daily_budget; r.action = `Pause the ad. It is the only live ad in "${r.adset_name}", so this frees ${money(r.adset_daily_budget)} per day.`; }
        else r.action = `Pause the ad. ${others} other live ad(s) share the ad set budget, so the budget moves to them and nothing is freed.`;
      } else r.action = r.rule === 'drifting' ? 'Leave it running. Check again in 48 hours.' : 'Leave it running. No change.';
    }

    const t = (e.totals || [])[0] || null;
    const tSpend = t ? num(t.spend) : 0, tConv = t ? convOf(t) : 0, tLpv = t ? lpvOf(t) : 0;
    const liveBudget = Object.values(adsets).filter(s => s.effective_status === 'ACTIVE' && s.daily_budget).reduce((x, s) => x + num(s.daily_budget) / offset, 0) || (camp.daily_budget ? num(camp.daily_budget) / offset : 0);
    const winners = live.filter(r => r.cpl != null && r.cpl <= cfg.target && r.conv >= R.CONSOLIDATE_CONV);
    const kills = live.filter(r => r.verdict === 'KILL').length;
    const surviving = live.length - kills;
    const lpvRate = tLpv ? round2(tConv / tLpv * 100) : null;
    const flags = [];
    if (lpvRate != null && lpvRate < R.PAGE_FLOOR) flags.push(`Landing page view to conversion is ${lpvRate}%, under ${R.PAGE_FLOOR}%. The bottleneck is the page, not the ads. Fix the page before buying more traffic.`);
    else if (lpvRate != null && lpvRate < R.PAGE_GOOD) flags.push(`Landing page view to conversion is ${lpvRate}%. A healthy registration page runs ${R.PAGE_GOOD}% to 40%, so the page is costing leads.`);
    if (t && tConv === 0 && tSpend > 0) flags.push(`No "${event}" conversions were recorded for the whole campaign. Check that conversion_event in the client config matches the event your pixel or lead form reports.`);
    if (t && num(t.frequency) > R.FREQ) flags.push(`Campaign frequency is ${num(t.frequency).toFixed(2)}, above ${R.FREQ}. The audience is tiring.`);
    if (!(e.lifetime || []).length) flags.push('The campaign is active but has no delivery in this window. Check ad approval and any account or domain flags.');

    result.campaigns.push({
      id: camp.id, name: camp.name, since: e.since, until: e.until, ads: live, paused,
      revive: paused.filter(r => r.revive),
      summary: {
        spend: round2(tSpend), conversions: tConv, blended_cpl: tConv ? round2(tSpend / tConv) : null, lpv_to_conv: lpvRate,
        scale: live.filter(r => r.verdict === 'SCALE').length, hold: live.filter(r => r.verdict === 'HOLD').length, kill: kills,
        daily_budget_now: round2(liveBudget), freed_per_day: round2(freed), added_per_day: round2(added), daily_budget_after: round2(liveBudget - freed + added),
        consolidation: winners.length >= R.CONSOLIDATE_ADS ? { ads: winners.map(r => r.ad_name), cbo_budget: round2(winners.reduce((x, r) => x + (r.adset_daily_budget || 0), 0)) } : null,
        live_after_kills: surviving, refill_slots: Math.max(kills, R.MIN_SLOTS - surviving, 0),
      },
      flags,
    });
  }
  return result;
}

function report(res) {
  const m = n => L.money(n, res.currency);
  const cplText = v => (v == null ? 'n/a' : v === Infinity ? 'no conv' : m(v));
  const out = [];
  if (res.mode === 'fixture') out.push('NOTE: this is invented demo data from a fixture file, not a live ad account.\n');
  if (res.incomplete) out.push('WARNING: the pull was incomplete. Some reads failed, so these verdicts may be wrong. Pull again before acting.\n');
  out.push(`# Ad verdict: ${res.client}`);
  out.push(`Target CPL ${m(res.target_cpl)} | breakeven (allowable) CPL ${m(res.breakeven_cpl)} | conversion event ${res.conversion_event}`);
  if (!res.campaigns.length) out.push('\nNo ACTIVE campaigns were found, so there is nothing to judge.');
  for (const c of res.campaigns) {
    const s = c.summary;
    out.push(`\n## ${c.name} (${c.since} to ${c.until})`);
    out.push(`SCALE ${s.scale} | HOLD ${s.hold} | KILL ${s.kill}\n`);
    out.push('| Ad | Spend | Conv | CPL | Trend (daily CPL) | Diagnostics | VERDICT and exact action |');
    out.push('|---|---|---|---|---|---|---|');
    for (const r of c.ads) {
      const tr = r.daily.slice(-5).map(d => (d.c ? (d.s / d.c).toFixed(1) : 'x')).join(', ');
      const diag = `freq ${r.frequency.toFixed(2)}, CTR ${r.link_ctr.toFixed(2)}%, CPC ${m(r.cpc)}, CPM ${m(r.cpm)}, LPV ${r.lpv}, hook ${r.hook_rate == null ? 'n/a' : r.hook_rate + '%'}, hold ${r.hold_rate == null ? 'n/a' : r.hold_rate + '%'}${r.learning ? ', in learning' : ''}`;
      out.push(`| ${r.ad_name} | ${m(r.spend)} | ${r.conv} | ${cplText(r.cpl)} | ${tr || 'n/a'} | ${diag} | **${r.verdict}** (${r.rule}). ${r.reason} ${r.action} |`);
    }
    if (!c.ads.length) out.push('| (no live ads with delivery) | | | | | | |');
    out.push('\nTrend shows the last 5 days with spend; x means a day with spend and no conversion.');
    out.push('\n### Money summary');
    out.push(`- Spend ${m(s.spend)}, ${s.conversions} conversions, blended CPL ${cplText(s.blended_cpl)} against target ${m(res.target_cpl)} and breakeven ${m(res.breakeven_cpl)}.`);
    out.push(`- Live daily budget now ${m(s.daily_budget_now)}. Kills free ${m(s.freed_per_day)} per day, scaling adds ${m(s.added_per_day)} per day, so the projected daily budget is ${m(s.daily_budget_after)}.`);
    if (s.consolidation) out.push(`- Consolidation trigger met: ${s.consolidation.ads.length} ads each hold ${R.CONSOLIDATE_CONV} or more conversions under target (${s.consolidation.ads.join(', ')}). Propose a winners campaign on campaign budget at ${m(s.consolidation.cbo_budget)} per day and keep the current ad sets running until it has proved itself for 4 to 7 days.`);
    out.push('\n### Funnel flags');
    out.push(c.flags.length ? c.flags.map(f => `- ${f}`).join('\n') : '- None from the numbers.');
    out.push('\n### Revive candidates');
    out.push(c.revive.length ? c.revive.map(r => `- ${r.ad_name}: paused, but its final day ran at ${cplText(r.final_day_cpl)}, under target. Possibly paused early. Revive at minimum budget as a test slot.`).join('\n') : '- None.');
    out.push('\n### Test slots');
    out.push(`- ${s.live_after_kills} live ad(s) remain after the kills. Refill ${s.refill_slots} test slot(s) with new angles. Keep at least ${R.MIN_SLOTS} to 5 live test angles beside the winners.`);
  }
  out.push('\nThis is analysis only. Nothing in the ad account was changed.');
  return out.join('\n');
}

function main() {
  const args = L.parseArgs(process.argv.slice(2), ['help', 'json', 'allow-incomplete']);
  if (args.help) { console.log(HELP); return 0; }
  if (!args.dump || args.dump === true) L.fail('Say which dump to judge with --dump <file>. Run with --help to see the usage.');
  const file = path.resolve(L.expandHome(args.dump));
  if (!fs.existsSync(file)) L.fail(`Dump file not found: ${file}`);
  let dump;
  try { dump = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { L.fail(`Dump file is not valid JSON: ${e.message}`); }
  if (!dump || !Array.isArray(dump.active) || !dump.config) L.fail('That file is not a dump written by pull-meta-ads.js.');
  if ((dump.errors || []).length && !args['allow-incomplete']) {
    L.fail(`This dump is incomplete: ${dump.errors.length} read(s) failed during the pull (${dump.errors.map(e => e.call).join(', ')}).\n  Verdicts from partial data can be wrong. Pull again, or add --allow-incomplete to judge it anyway.`);
  }
  const res = analyse(dump);
  console.log(args.json ? JSON.stringify(res, (k, v) => (v === Infinity ? 'Infinity' : v), 2) : report(res));
  return 0;
}

module.exports = { R, trend, judgeAd, analyse, report };

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (e) {
    if (e instanceof L.UserError) console.error(`ERROR: ${e.message}`);
    else console.error(`UNEXPECTED ERROR: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  }
}
