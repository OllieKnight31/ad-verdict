'use strict';
// Shared helpers for ad-verdict-skill. No dependencies. Node 18 or newer.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_DIR = path.join(__dirname, '..');
const CLIENTS_DIR = path.join(SKILL_DIR, 'clients');
const PLACEHOLDER_ACT = 'act_0000000000';
const PLACEHOLDER_TOKEN = 'PASTE_YOUR_TOKEN_HERE';
const DEFAULT_API_VERSION = 'v26.0';
// Currencies Meta reports in whole units (budgets are not multiplied by 100).
const ZERO_DECIMAL = ['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND'];
const SYMBOLS = { GBP: '£', USD: '$', EUR: '€', AUD: 'A$', CAD: 'C$', NZD: 'NZ$' };

class UserError extends Error {}

function fail(msg) { throw new UserError(msg); }

// --flag value, --flag=value and bare --flag (true) are all accepted.
function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (booleans.includes(key) || next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function listClients() {
  if (!fs.existsSync(CLIENTS_DIR)) return [];
  return fs.readdirSync(CLIENTS_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

// With no --client: use the only config that is not the shipped example.
function defaultClient() {
  const own = listClients().filter(c => c !== 'example');
  return own.length === 1 ? own[0] : null;
}

// Allowable (breakeven) cost per lead = front end cash collected / results.
function computeBreakeven(economics) {
  if (!economics || typeof economics !== 'object') return null;
  const cash = Number(economics.front_end_cash);
  const results = Number(economics.results);
  if (!Number.isFinite(cash) || !Number.isFinite(results) || cash <= 0 || results <= 0) return null;
  return Math.round((cash / results) * 100) / 100;
}

function isPos(n) { return typeof n === 'number' && Number.isFinite(n) && n > 0; }

// Validates a client config and returns a normalised copy. Throws UserError with every problem listed.
function normaliseConfig(raw, label = 'config') {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label}: must be a JSON object.`);
  const cfg = { ...raw };
  let act = String(cfg.act_id == null ? '' : cfg.act_id).trim();
  if (/^\d+$/.test(act)) act = `act_${act}`;
  if (!/^act_\d+$/.test(act)) problems.push('act_id must look like act_1234567890 (the ad account id with act_ in front).');
  cfg.act_id = act;
  if (typeof cfg.conversion_event !== 'string' || !cfg.conversion_event.trim()) problems.push('conversion_event is required, for example "lead" or "complete_registration".');
  if (!isPos(cfg.target_cpl)) problems.push('target_cpl must be a number above 0 (no quotes, no currency sign).');
  let be = cfg.breakeven_cpl;
  const fromEcon = computeBreakeven(cfg.economics);
  if (be == null) {
    if (fromEcon == null) problems.push('give either breakeven_cpl (a number above 0) or economics.front_end_cash and economics.results (both above 0).');
    else { be = fromEcon; cfg.breakeven_source = 'economics'; }
  } else if (!isPos(be)) {
    problems.push('breakeven_cpl must be a number above 0, or null to have it worked out from economics.');
  } else {
    cfg.breakeven_source = 'breakeven_cpl';
  }
  cfg.breakeven_cpl = be;
  if (cfg.api_version != null && !/^v\d+\.\d+$/.test(String(cfg.api_version))) problems.push('api_version must look like v26.0.');
  cfg.api_version = cfg.api_version || DEFAULT_API_VERSION;
  if (cfg.currency != null && !/^[A-Za-z]{3}$/.test(String(cfg.currency))) problems.push('currency must be a three letter code such as GBP, USD or EUR.');
  if (cfg.currency) cfg.currency = String(cfg.currency).toUpperCase();
  if (problems.length) fail(`${label} has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  cfg.warnings = [];
  if (cfg.target_cpl > cfg.breakeven_cpl) cfg.warnings.push(`target_cpl (${cfg.target_cpl}) is above breakeven_cpl (${cfg.breakeven_cpl}). A lead bought at target would lose money on the front end. Check both numbers.`);
  return cfg;
}

function loadConfig(slug) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(slug))) fail(`Client name "${slug}" is not valid. Use letters, numbers, hyphens and underscores only.`);
  const file = path.join(CLIENTS_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) {
    const have = listClients();
    fail(`No config found for "${slug}".\n  Looked for: ${file}\n  Configs present: ${have.length ? have.join(', ') : '(none)'}\n  To create one, copy ${path.join(CLIENTS_DIR, 'example.json')} to ${file} and fill it in.`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail(`${file} is not valid JSON: ${e.message}`); }
  return normaliseConfig(raw, file);
}

// Reads the access token. The value is never printed by this skill.
function readToken(cfg, env = process.env) {
  const src = cfg.token_source || {};
  const name = src.var || 'META_ACCESS_TOKEN';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`token_source.var "${name}" is not a valid variable name.`);
  let val = env[name];
  let where = `environment variable ${name}`;
  if (!val) {
    if (!src.file) fail(`No token found. Set token_source.file in the client config, or export ${name} in your shell.`);
    const file = expandHome(src.file);
    where = file;
    if (!fs.existsSync(file)) fail(`Token file not found: ${file}\n  Create it with one line:  ${name}=your_token`);
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[1] === name) val = m[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    }
    if (val == null) fail(`${name} is not set in ${file}\n  Add one line:  ${name}=your_token`);
  }
  val = String(val).trim();
  if (!val || val === PLACEHOLDER_TOKEN) fail(`${name} in ${where} is still empty or the placeholder. Paste your Meta access token there.`);
  if (/\s/.test(val)) fail(`${name} in ${where} contains a space or line break. The token must be one unbroken string.`);
  return { token: val, where, name };
}

function minorOffset(currency) { return ZERO_DECIMAL.includes(String(currency || '').toUpperCase()) ? 1 : 100; }

function money(n, currency) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  const c = String(currency || '').toUpperCase();
  const dp = ZERO_DECIMAL.includes(c) ? 0 : 2;
  const v = Number(n).toFixed(dp);
  if (SYMBOLS[c]) return `${SYMBOLS[c]}${v}`;
  return c ? `${c} ${v}` : v;
}

function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

module.exports = {
  SKILL_DIR, CLIENTS_DIR, PLACEHOLDER_ACT, PLACEHOLDER_TOKEN, DEFAULT_API_VERSION, ZERO_DECIMAL,
  UserError, fail, parseArgs, expandHome, listClients, defaultClient, computeBreakeven,
  normaliseConfig, loadConfig, readToken, minorOffset, money, localDate, isDate,
};
