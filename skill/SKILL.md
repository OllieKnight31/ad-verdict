---
name: ad-verdict-skill
description: |
  Scale, Kill or Hold verdict engine for live Meta (Facebook and Instagram) ad accounts.
  Reads every ACTIVE campaign, ad set and ad from the Marketing API with lifetime and daily
  insights (spend, CPL, CPM, link CTR, CPC, frequency, landing page views, hook rate, hold
  rate), works out the allowable cost per lead from the funnel numbers, and gives each ad a
  verdict with the exact next action (new budget, kill line, revive candidates, learning
  phase cautions, funnel bottleneck flags, test slot refill plan). Analysis only by default:
  it never changes the ad account unless the user explicitly says to execute.

  Aliases: /ad-verdict, /scale-kill-hold, /ad-audit.

  Triggers on: "analyse the live ads", "scale kill or hold", "ad verdict for [client]",
  "which ads should I scale", "audit the ads", "breakdown of live ads", "should I kill this ad",
  "/ad-verdict [client]", "run the ad verdict demo", "set up ad verdict".
metadata:
  type: skill
---

# Ad Verdict Skill: Scale, Kill or Hold

## What this skill does

For one ad account it produces a verdict table covering every live ad: **SCALE** (with the
exact new budget), **KILL** (with the daily budget freed) or **HOLD** (with the kill line and
when to check again). It also shows what the ads cannot fix (funnel bottlenecks) and how many
test slots need refilling.

The scaling rules follow direct response doctrine taught publicly by Jeremy Haynes: judge on
cost per lead against what the funnel can afford, scale in small steps, kill fast, keep
testing new angles.

## Hard rules

1. **Read only by default.** Both scripts only read. Never change a budget, a status or
   anything else in the ad account unless the user explicitly tells you to in a later message
   (see Phase 4).
2. **Never ask the user to paste an access token into the chat**, never print one, and never
   read the token file yourself. The user pastes the token into the token file; the script
   reads it.
3. **Never invent numbers.** Every figure in the report comes from the script output. If a
   pull is incomplete, say so and stop.
4. All paths below are inside `~/.claude/skills/ad-verdict-skill/`. Call the scripts by their
   full path so they work from any folder.

## Requirements

- Node.js 18 or newer (`node --version`). No packages to install.
- A Meta access token with the `ads_read` permission, for a user or system user who can see
  the ad account. The README that came with this skill explains how to create one.
- One config file per ad account in `clients/`.

## Phase 0: Resolve the client config

Configs live at `~/.claude/skills/ad-verdict-skill/clients/<name>.json`. The installer creates
`clients/my-account.json` from `clients/example.json`. If the user names no client and there is
exactly one config other than `example.json`, the scripts use it.

| Key | Meaning |
|---|---|
| `act_id` | Ad account id, written `act_1234567890` |
| `token_source.file` | File holding the token, default `~/.ad-verdict/.env` |
| `token_source.var` | Variable name inside that file, default `META_ACCESS_TOKEN` |
| `api_version` | Graph API version, for example `v26.0` |
| `conversion_event` | The action type that counts as the result, for example `lead` or `complete_registration` |
| `currency` | Three letter code, for example `GBP`. Optional: the account currency is used if absent |
| `target_cpl` | The cost per lead the account must beat |
| `breakeven_cpl` | The allowable cost per lead: front end cash collected divided by results. Set to `null` to have it worked out from `economics` |
| `economics.front_end_cash`, `economics.results` | Cash collected and number of results over a recent, typical period |
| `notes` | Free text: policy flags, event days, anything that explains odd delivery |

If the config is missing, or still holds the placeholder account id `act_0000000000`, ask the
user for: the ad account id, the conversion event, the target CPL, and either the breakeven
CPL or the cash collected and number of results it comes from. Write the config file yourself.
Then tell the user to open the token file and paste their token after `META_ACCESS_TOKEN=`.
Do not handle the token for them.

Check the setup without touching the network:

```
node ~/.claude/skills/ad-verdict-skill/scripts/pull-meta-ads.js --client <name> --check
```

## Phase 1: Pull the data

```
node ~/.claude/skills/ad-verdict-skill/scripts/pull-meta-ads.js --client <name> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--outdir <folder>]
```

Default window: each active campaign's start date to today. The script prints, and saves to a
JSON dump (`ad-verdict-<name>-<date>.json` in the current folder or `--outdir`):

1. Every campaign with its effective status, so you see what is live and what is paused
2. For each ACTIVE campaign: ad sets (budget, optimisation goal, learning stage) and ads
3. Lifetime insights per ad: spend, impressions, reach, frequency, CPM, link CTR, link clicks,
   CPC, landing page views, conversions, video plays, ThruPlays and watch depth
4. Daily insights per ad. The trend is half the verdict
5. Campaign totals

Exit code 0 means the pull is complete. Exit code 1 means it could not run: read the message,
it says what to fix. Exit code 2 means some reads failed and the data is partial: do not issue
verdicts from it.

To try the skill with no ad account at all, use the invented demo account:

```
node ~/.claude/skills/ad-verdict-skill/scripts/pull-meta-ads.js --demo --outdir /tmp
```

Always tell the user when a report comes from demo data.

## Phase 2: Verdicts

```
node ~/.claude/skills/ad-verdict-skill/scripts/verdict.js --dump <path printed by the pull>
```

The script applies the rules below exactly and prints the verdict table. Do not override its
verdicts by feel. Add judgement around them (see Phase 3). T is `target_cpl`, B is
`breakeven_cpl`. Kill rules are checked first, then Scale, then Hold.

### KILL when any of:
- Spend is 2 x B or more with zero conversions
- Lifetime CPL is above 2.5 x T once spend has reached 1.5 x B
- Spend since the last day with a conversion is 2.5 x B or more (the ad died mid flight)
- Frequency is above 3.5 and daily CPL has risen 3 days running (fatigue)

### SCALE when all of:
- Lifetime CPL is at or under T
- 5 or more conversions (fewer is noise, not signal)
- The last 2 days are not both above B

Scaling mechanics:
- **Vertical**: raise the ad set budget 20% (30% for a champion), then wait 24 to 48 hours.
  Never double. Jumps above 30% restart learning. The report states the exact new budget.
- **Champion** (CPL at or under 60% of T): 30% now and queue a **horizontal** duplicate,
  cloning the ad into a fresh broad ad set at the original budget.
- **Consolidation**: once 3 or more ads each hold 20 or more conversions under target,
  propose a winners campaign on campaign budget at the sum of their ad set budgets. Keep the
  original ad sets running until the new campaign has proved itself for 4 to 7 days.

### HOLD otherwise, with the reason:
- `underspent`: spend under 1.5 x B. No verdict yet, say so
- `learning`: in learning with CPL at or under B. Do not touch, edits restart learning
- `drifting`: CPL within 25% of T but the last 3 days are worse than lifetime. Hold 48 hours
  with the kill line "kill if 3 day rolling CPL goes above breakeven"
- `recent-slump`, `low-volume`, `above-target`, `no-delivery`: as named

### Revive check
Paused ads inside active campaigns whose final day ran under target were possibly paused too
early. The script lists them. Recommend reviving at minimum budget as a test slot.

### Test slot upkeep
The account needs a steady supply of different angles. For every kill, recommend a refill.
Ask the user whether they have unused scripts or creatives ready before proposing new
creative work. Aim for at least 3 to 5 live test angles beside the winners. Note angle
diversity: if every remaining winner uses the same avatar or emotion, the account is fragile.

## Phase 3: Report format

Lead with the verdict table from the script, sorted SCALE, HOLD, KILL:

| Ad | Spend | Conv | CPL | Trend (daily CPL) | Diagnostics | VERDICT and exact action |

Then, in order:
1. **Money summary**: blended CPL against target and breakeven, projected daily budget after
   the changes, budget freed by kills and where it should go
2. **Funnel flags**: landing page view to conversion rate (a registration page should run 25%
   to 40%; under 15% the bottleneck is the page, not the ads), CPM drift, frequency
3. **Revive candidates**
4. **Test slot refill plan**
5. **Timing**: if conversions depend on an event (for example a weekly webinar), say how the
   event date should shape when budget changes land

CTR, hook rate and hold rate are diagnostics that explain why. They never decide the verdict.
Hook rate is video plays divided by impressions; autoplay inflates it, so compare ads with
each other, not with a benchmark. Hold rate is ThruPlays divided by plays.

End every report with: "This is analysis only. Nothing in the ad account was changed."

## Phase 4: Making changes (ONLY on explicit instruction)

This skill ships with no code that can change an ad account, and a token with only `ads_read`
cannot change one. Applying the verdicts by hand in Ads Manager is the normal route.

Only if the user, after seeing the report, explicitly asks you to apply changes through the
API:
1. Confirm they have a token with `ads_management`. If not, stop and tell them to make the
   changes in Ads Manager.
2. List every change you are about to make (ad or ad set id, name, old value, new value) and
   wait for a clear yes.
3. Make one change at a time and show each API response. Budgets are in minor units
   (`8790` means 87.90) except for currencies with no minor unit.
4. Pull again afterwards and show the new state.

Never make changes in the same turn as the analysis. A general request such as "sort my ads
out" is not an instruction to change the account.

## Gotchas

- `daily_budget` is in minor units (pence or cents): `8790` is 87.90
- Pick one `conversion_event`. Meta often reports the same conversion under several action
  types (for example `complete_registration` and `offsite_conversion.fb_pixel_complete_registration`).
  Counting more than one double counts. If the report shows zero conversions on an account
  that is clearly converting, the event name is wrong: look at the `actions` list in the dump
  to find the right one
- Hook rates of 90% or more are normal because of autoplay. Only compare ads with each other
- Small budget test ad sets may never leave learning (that needs about 50 conversions in 7
  days). That is fine for angle testing. Chase CPL, not the end of learning
- User tokens expire, typically after about 60 days. A system user token set to never expire
  avoids this. Never create or refresh tokens for the user
- If an active campaign has approved ads but almost no delivery, check for account, domain or
  special category flags before blaming the creative, and record them in the config `notes`
- Ad set budgets are missing when the budget sits on the campaign. The report says so
