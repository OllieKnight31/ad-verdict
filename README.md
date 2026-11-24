# Ad Verdict Skill

A Claude Code skill that reads your live Meta (Facebook and Instagram) ad account and gives every ad a **Scale**, **Kill** or **Hold** verdict, with the exact next action.

## What it does

1. Reads every active campaign, ad set and ad from your ad account, with lifetime and day by day numbers.
2. Works out your allowable cost per lead (CPL) from your own funnel numbers.
3. Judges each ad against fixed rules and prints a verdict table: new budgets for winners, which ads to pause and how much budget that frees, which to leave alone and when to check again.
4. Flags what the ads cannot fix, such as a landing page that converts badly, and lists paused ads that may have been stopped too early.

**It is analysis only.** The scripts can only read. They contain no code that edits an ad account, and the token this guide tells you to create has read permission only, so it could not change anything even if asked.

## What you need

| You need | Notes |
|---|---|
| A Mac | The installer is a shell script. Linux also works. |
| Claude Code | Installed and signed in. See https://claude.com/claude-code |
| Node.js 18 or newer | Check with `node --version` in Terminal. If it is missing or older, install the LTS version from https://nodejs.org |
| A Meta ad account with running ads | You need to be an admin of it, or have been given access to it. |
| A Meta access token with `ads_read` | Free. Takes about 10 minutes. Steps below. |
| Three numbers from your funnel | The event that counts as a lead, your target CPL, and your breakeven CPL (or the cash and lead counts to work it out). |

Nothing else is installed. The skill has no dependencies and takes under 1 MB.

## Install

1. Unzip the folder you were sent.
2. Open Terminal and run:

```bash
cd path/to/ad-verdict-skill
bash install.sh
```

The installer:
- copies the skill to `~/.claude/skills/ad-verdict-skill/`
- creates your config at `~/.claude/skills/ad-verdict-skill/clients/my-account.json` from the example
- creates an empty token file at `~/.ad-verdict/.env` that only you can read
- runs an offline self test on invented data and tells you if it passed

Running it again later is safe. It never overwrites a config or a token file that already exists.

## Try the demo first (no ad account needed)

Restart Claude Code and say:

> run the ad verdict demo

Or run it yourself in Terminal:

```bash
node ~/.claude/skills/ad-verdict-skill/scripts/pull-meta-ads.js --demo --outdir /tmp
node ~/.claude/skills/ad-verdict-skill/scripts/verdict.js --dump /tmp/ad-verdict-example-2026-01-11.json
```

The demo uses an invented account with 12 ads. You should see `SCALE 3 | HOLD 3 | KILL 4`.

## Create the Meta token

Meta moves its menus around from time to time, so a label may differ slightly from what is written here. The things you are aiming for do not change: **an app with the Marketing API, and a token that has the `ads_read` permission for a user who can see your ad account.**

### Step 1: Create a Meta app (once)

1. Go to https://developers.facebook.com and log in with the Facebook account that has access to your ad account. If asked, register as a developer (free).
2. Click **My Apps**, then **Create App**.
3. When asked what the app is for, choose the option for ads or marketing (it may be worded "Create and manage ads with Marketing API"), or **Other** then **Business**.
4. Give it any name, for example "My ad reports". Connect it to your business portfolio if offered.
5. In the app dashboard, make sure **Marketing API** is added as a product or use case.

You do not need to publish the app or send it for review. An app in development mode can read ad accounts that its own admin has access to.

### Step 2: Create the token

Pick one route.

**Route A, quickest (the token lasts about 60 days):**

1. In your app dashboard, open **Marketing API**, then **Tools**.
2. Tick **ads_read** only. Leave `ads_management` unticked so the token cannot change anything.
3. Click **Get Token** and copy it.

**Route B, best for regular use (the token does not expire):**

1. Go to https://business.facebook.com/settings and choose your business portfolio.
2. Open **Users**, then **System users**, and click **Add**. Name it, for example "ad-reports", with the Employee role.
3. With the system user selected, click **Assign assets**. Choose **Ad accounts**, pick your account, and turn on **View performance** only.
4. Click **Generate token**. Choose the app from Step 1, set the expiry to **Never**, tick **ads_read** only, and generate. Copy the token straight away: Meta shows it once.

### Step 3: Find your ad account id

Open Ads Manager. The number after `act=` in the address bar is your ad account id. It is also shown in the account drop down at the top left. In the config you write it with `act_` in front, for example `act_1234567890`.

## Set up

### 1. Paste the token

Open the token file:

```bash
open -e ~/.ad-verdict/.env
```

Replace `PASTE_YOUR_TOKEN_HERE` so the line reads `META_ACCESS_TOKEN=` followed by your token. One line, no quotes, no spaces. Save and close.

Treat the token like a password. Do not paste it into Claude, a chat or an email.

### 2. Fill in your config

```bash
open -e ~/.claude/skills/ad-verdict-skill/clients/my-account.json
```

| Key | What to put |
|---|---|
| `act_id` | Your ad account id, for example `"act_1234567890"` |
| `conversion_event` | What counts as a lead. Common values: `"lead"` for lead forms and most lead pixels, `"complete_registration"` for webinar or event sign ups, `"purchase"` for sales |
| `currency` | Your account currency, for example `"GBP"`, `"USD"` or `"EUR"` |
| `target_cpl` | The cost per lead you want to beat. A number, no quotes, no currency sign |
| `breakeven_cpl` | The most a lead can cost before you lose money on the front end. Leave as `null` to have it worked out from `economics` |
| `economics` | `front_end_cash`: cash collected from a recent, typical period. `results`: the number of leads in that same period. Breakeven CPL is the first divided by the second |
| `api_version` | Leave as it is unless you see the "version has been retired" error |
| `notes` | Anything worth remembering about the account |

Leave `token_source` alone unless you keep your token somewhere else.

Example: you collected 4,800 in sales from 400 webinar registrations, so a registration is worth 12. Your breakeven CPL is 12. You set the target lower, say 8, so there is profit in it.

You can also skip editing by hand: tell Claude "set up ad verdict for my account" and it will ask for these values and write the file. It will not ask for your token.

### 3. Check the setup

```bash
node ~/.claude/skills/ad-verdict-skill/scripts/pull-meta-ads.js --client my-account --check
```

This checks the config and finds the token without contacting Meta. You should see `Config OK`.

## First run

Restart Claude Code, then say:

> ad verdict for my-account

Claude pulls the data, runs the verdict rules and gives you the report. To run the two steps yourself:

```bash
cd ~/Desktop
node ~/.claude/skills/ad-verdict-skill/scripts/pull-meta-ads.js --client my-account
node ~/.claude/skills/ad-verdict-skill/scripts/verdict.js --dump ad-verdict-my-account-YYYY-MM-DD.json
```

The pull prints the exact second command for you. Add `--since 2026-01-01 --until 2026-01-31` to the pull to limit the dates.

More than one ad account? Copy `my-account.json` to a new name in the same folder, for example `shop.json`, change the values, and say "ad verdict for shop".

## The rules it applies

T is your target CPL and B is your breakeven CPL. Kill rules are checked first, then Scale, then Hold.

| Verdict | When |
|---|---|
| KILL | Spend of 2 x B or more with no conversions |
| KILL | CPL above 2.5 x T once spend has reached 1.5 x B |
| KILL | Spend of 2.5 x B or more since the last day with a conversion |
| KILL | Frequency above 3.5 and daily CPL up 3 days running |
| SCALE | CPL at or under T, 5 or more conversions, and the last 2 days not both above B. Budget goes up 20%, or 30% when CPL is at or under 60% of T |
| HOLD | Everything else, with the reason and the kill line |

## Troubleshooting

| What you see | What to do |
|---|---|
| `command not found: node`, or the installer says Node.js is missing or too old | Install the LTS version from https://nodejs.org, open a new Terminal window, run `bash install.sh` again |
| `still has the placeholder ad account id` | Put your own id in `act_id` in `my-account.json` |
| `is still empty or the placeholder` | Paste your token into `~/.ad-verdict/.env` |
| `The access token is invalid or has expired` (code 190) | Create a new token (Step 2 above) and paste it in. Route B tokens do not expire |
| `The token is missing a permission` (code 10 or 200) | The token needs `ads_read`, and the user or system user behind it needs access to this ad account |
| `Meta rejected the request` (code 100) | Check `act_id`: it is `act_` then numbers only. Check the token belongs to someone who can see that account |
| `This Graph API version has been retired` | Open https://developers.facebook.com/docs/graph-api/changelog, find the newest version number, and put it in `api_version`, for example `"v27.0"` |
| `rate limit reached` | Wait 15 to 60 minutes and run again |
| `could not reach graph.facebook.com` | Check your internet connection, VPN or firewall |
| `INCOMPLETE` and exit code 2 | Some reads failed. Do not act on that report. Fix the cause shown and pull again |
| Every ad shows 0 conversions but you know leads are coming in | `conversion_event` does not match what Meta reports. Open the dump file, search for `"actions"`, and use the `action_type` that matches your leads |
| Claude does not recognise the skill | Restart Claude Code. Check that `~/.claude/skills/ad-verdict-skill/SKILL.md` exists |
| `is not valid JSON` | A comma or quote is missing in the config. Copy `example.json` over it and start again |

To run the offline self test at any time:

```bash
node ~/.claude/skills/ad-verdict-skill/scripts/selftest.js
```

## Privacy and safety

- Your token stays in `~/.ad-verdict/.env` on your Mac. It is sent only to `graph.facebook.com`, and never written to the dump file or printed.
- The dump file (`ad-verdict-NAME-DATE.json`) holds your ad names and numbers. Delete it when you are done if that matters to you.
- The skill makes read requests only. If you later ask Claude to apply changes for you, it must list each change and wait for your yes, and it needs a different token with `ads_management`, which this guide does not create. Making the changes yourself in Ads Manager is the safer route.

## Uninstall

```bash
rm -rf ~/.claude/skills/ad-verdict-skill ~/.ad-verdict
```

## What is in this folder

| Path | What it is |
|---|---|
| `install.sh` | The installer |
| `skill/SKILL.md` | The instructions Claude follows |
| `skill/scripts/pull-meta-ads.js` | Reads the ad account (read only) |
| `skill/scripts/verdict.js` | Applies the rules to the data |
| `skill/scripts/lib.js` | Shared helpers |
| `skill/scripts/selftest.js` | Offline self test |
| `skill/clients/example.json` | Example config |
| `skill/fixtures/demo-account.json` | Invented demo data |
| `tests/` | Extra offline tests for anyone who changes the code. Not installed |
