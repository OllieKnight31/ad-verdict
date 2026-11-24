#!/usr/bin/env node
'use strict';
// Builds skill/fixtures/demo-account.json from a compact spec. Every name and number is invented.
const fs = require('fs');
const path = require('path');
const DAYS = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'];
const CID = '9000000000001';
// n: ad number, set: ad set number, st: ad status, freq, learn, d: [spend, conversions] per day (null = not running)
const ADS = [
  { n: 1, name: 'Angle 01 Champion', set: 1, d: [[12, 3], [14, 4], [13, 3], [14, 3], [14, 4], [15, 4], [14, 3]] },
  { n: 2, name: 'Angle 02 Winner', set: 2, d: [[15, 2], [15, 2], [15, 3], [15, 2], [15, 2], [15, 2], [15, 2]] },
  { n: 3, name: 'Angle 03 Zero', set: 3, d: [[5, 0], [5, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, 0]] },
  { n: 4, name: 'Angle 04 Expensive', set: 4, d: [[9, 1], [9, 0], [9, 1], [9, 0], [9, 0], [9, 1], [9, 0]] },
  { n: 5, name: 'Angle 05 Died', set: 5, d: [[14, 4], [15, 3], [15, 3], [9, 0], [9, 0], [9, 0], [9, 0]] },
  { n: 6, name: 'Angle 06 Fatigue', set: 6, freq: 3.9, d: [null, [12, 1], [12, 1], [16, 2], [20, 2], [24, 2], [15, 1]] },
  { n: 7, name: 'Angle 07 Underspent', set: 7, d: [null, null, null, null, null, [7, 0], [7, 1]] },
  { n: 8, name: 'Angle 08 Learning', set: 8, learn: true, d: [null, null, null, [11, 1], [11, 1], [11, 1], [11, 1]] },
  { n: 9, name: 'Angle 09 Drifting', set: 9, d: [[6, 1], [6, 1], [6, 1], [6, 1], [10, 1], [10, 1], [10, 0]] },
  { n: 10, name: 'Angle 10 Paused Early', set: 10, st: 'PAUSED', d: [[10, 0], [10, 1], [10, 1], [10, 2], null, null, null] },
  { n: 11, name: 'Angle 11 Paused Dud', set: 11, st: 'PAUSED', d: [[12, 0], null, null, null, null, null, null] },
  { n: 12, name: 'Angle 12 Twin', set: 2, d: [[7, 1], [7, 1], [7, 1], [7, 1], [7, 1], [7, 1], [6, 0]] },
];
const adId = n => String(7000000000000 + n);
const setId = n => String(8000000000000 + n);
const setName = n => `Test ad set ${String(n).padStart(2, '0')}`;
const CPM = 9, CPC = 0.6, LPV_PER_CLICK = 0.8;

function insight(a, spend, conv, extra) {
  const imp = Math.round(spend / CPM * 1000), clicks = Math.round(spend / CPC), lpv = Math.round(clicks * LPV_PER_CLICK);
  const freq = a.freq || 1.4;
  const actions = [{ action_type: 'link_click', value: String(clicks) }, { action_type: 'landing_page_view', value: String(lpv) }];
  if (conv) actions.push({ action_type: 'complete_registration', value: String(conv) }, { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: String(conv) });
  const row = {
    adset_id: setId(a.set), adset_name: setName(a.set), ad_id: adId(a.n), ad_name: a.name,
    spend: spend.toFixed(2), impressions: String(imp), reach: String(Math.round(imp / freq)), frequency: freq.toFixed(6),
    cpm: CPM.toFixed(6), inline_link_clicks: String(clicks), inline_link_click_ctr: (clicks / imp * 100).toFixed(6), cost_per_inline_link_click: CPC.toFixed(6),
    actions,
    video_play_actions: [{ action_type: 'video_view', value: String(Math.round(imp * 0.9)) }],
    video_thruplay_watched_actions: [{ action_type: 'video_view', value: String(Math.round(imp * 0.9 * (0.07 + (a.n % 5) * 0.015))) }],
    ...extra,
  };
  if (conv) row.cost_per_action_type = [{ action_type: 'complete_registration', value: (spend / conv).toFixed(6) }];
  return row;
}

const lifetime = [], daily = [];
let totSpend = 0, totConv = 0;
for (const a of ADS) {
  let s = 0, c = 0;
  a.d.forEach((x, i) => {
    if (!x) return;
    s += x[0]; c += x[1];
    daily.push(insight(a, x[0], x[1], { date_start: DAYS[i], date_stop: DAYS[i] }));
  });
  totSpend += s; totConv += c;
  lifetime.push(insight(a, s, c, { date_start: DAYS[0], date_stop: DAYS[6] }));
}
const sets = [...new Set(ADS.map(a => a.set))].map(n => {
  const mine = ADS.filter(a => a.set === n);
  const paused = mine.every(a => a.st === 'PAUSED');
  return { id: setId(n), name: setName(n), effective_status: paused ? 'PAUSED' : 'ACTIVE', daily_budget: '2000', optimization_goal: 'OFFSITE_CONVERSIONS', learning_stage_info: { status: mine.some(a => a.learn) ? 'LEARNING' : 'SUCCESS' } };
});
const half = Math.ceil(daily.length / 2);
const TOTAL_LPV = 656; // 82 conversions / 656 landing page views = 12.5%, so the page flag fires
const fixture = {
  _about: 'Invented demo data for ad-verdict-skill. No real account, business, person or advert is represented. Built by tests/make-fixture.js.',
  today: DAYS[6],
  responses: {
    account: { name: 'Demo Account (invented)', currency: 'GBP', timezone_name: 'Europe/London', account_status: 1, id: 'act_0000000000' },
    campaigns: { data: [
      { id: CID, name: 'Demo Webinar Cold Test', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS', created_time: '2026-01-04T09:00:00+0000', start_time: '2026-01-05T00:00:00+0000' },
      { id: '9000000000002', name: 'Demo Retargeting (paused)', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_LEADS', daily_budget: '1500', created_time: '2025-11-01T09:00:00+0000', start_time: '2025-11-02T00:00:00+0000' },
    ] },
    [`adsets:${CID}`]: { data: sets },
    [`ads:${CID}`]: { data: ADS.map(a => ({ id: adId(a.n), name: a.name, effective_status: a.st || 'ACTIVE', adset_id: setId(a.set) })) },
    [`insights_lifetime:${CID}`]: { data: lifetime },
    [`insights_daily:${CID}`]: { data: daily.slice(0, half), paging: { next: `insights_daily:${CID}:page2` } },
    [`insights_daily:${CID}:page2`]: { data: daily.slice(half) },
    [`insights_totals:${CID}`]: { data: [{
      spend: totSpend.toFixed(2), impressions: String(Math.round(totSpend / CPM * 1000)), cpm: CPM.toFixed(6), inline_link_click_ctr: '1.500000', frequency: '1.800000', reach: String(Math.round(totSpend / CPM * 1000 / 1.8)),
      actions: [{ action_type: 'landing_page_view', value: String(TOTAL_LPV) }, { action_type: 'complete_registration', value: String(totConv) }, { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: String(totConv) }],
      cost_per_action_type: [{ action_type: 'complete_registration', value: (totSpend / totConv).toFixed(6) }],
      date_start: DAYS[0], date_stop: DAYS[6],
    }] },
  },
};
const out = path.join(__dirname, '..', 'skill', 'fixtures', 'demo-account.json');
fs.writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
console.log(`wrote ${out}: ${ADS.length} ads, ${daily.length} daily rows, spend ${totSpend}, conversions ${totConv}`);
