import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  resolveLeagueSeasonStatus,
  OFF_SEASON_LABEL,
  STATUS
} = require('../js/league-season-status.js');
const {
  evaluateMarketEligibility,
  evaluateMarketAvailability,
  badgeLabelForStatus,
  marketRequiresActiveSeason,
  UNAVAILABLE_OOS
} = require('../js/league-market-eligibility.js');

function mlbSb({ endDate = '2026-11-12T07:59Z', startDate = '2026-02-19T08:00Z', type = 3 } = {}) {
  return {
    season: { type, year: 2026 },
    leagues: [{ season: { year: 2026, startDate, endDate }, calendarType: 'day', calendar: [] }],
    events: []
  };
}

/** Minimal browser-ish harness that mirrors index.html selection + submission gates. */
function createAppGateHarness(initialStatusBySport) {
  const statusMap = { ...initialStatusBySport };
  const state = {
    current: 'MLB',
    currentOption: 'HR',
    picks: [],
    toasts: [],
    selectionBlocked: 0,
    submissionsRejected: 0
  };

  function getLeagueSeasonStatus(sport) {
    return statusMap[sport] || 'unknown';
  }

  function evaluate(sport, option) {
    return evaluateMarketEligibility(getLeagueSeasonStatus(sport), sport, option);
  }

  function setOption(o) {
    const elig = evaluate(state.current, o);
    if (!elig.ok) {
      state.selectionBlocked += 1;
      state.toasts.push(elig.reason);
      return false;
    }
    state.currentOption = o;
    return true;
  }

  function spin() {
    const elig = evaluate(state.current, state.currentOption);
    if (!elig.ok) {
      state.selectionBlocked += 1;
      state.toasts.push(elig.reason);
      return false;
    }
    state.picks = [{ player: 'Test', market: state.currentOption }];
    return true;
  }

  function submitSlip() {
    const elig = evaluate(state.current, state.currentOption);
    if (!elig.ok) {
      state.submissionsRejected += 1;
      state.toasts.push(elig.reason);
      return false;
    }
    if (!state.picks.length) return false;
    return true;
  }

  function refreshStatus(sport, next) {
    statusMap[sport] = next;
    if (next !== 'in' && state.picks.length) {
      state.picks = [];
      state.toasts.push(UNAVAILABLE_OOS);
    }
  }

  return { state, setOption, spin, submitSlip, refreshStatus, evaluate, getLeagueSeasonStatus };
}

test('1. off-season league badge label is exact Off-season', () => {
  const st = resolveLeagueSeasonStatus(mlbSb(), Date.parse('2026-11-21T12:00:00Z'));
  assert.equal(st.status, STATUS.OFF);
  assert.equal(badgeLabelForStatus(st.status), OFF_SEASON_LABEL);
  assert.equal(OFF_SEASON_LABEL, 'Off-season');
});

test('2. off-season blocks market selection with clear reason', () => {
  const e = evaluateMarketEligibility('off', 'MLB', 'HR');
  assert.equal(e.ok, false);
  assert.equal(e.reason, UNAVAILABLE_OOS);
});

test('3. direct selection-handler calls cannot bypass the restriction', () => {
  const app = createAppGateHarness({ MLB: 'off' });
  assert.equal(app.setOption('Ks'), false);
  assert.equal(app.setOption('HR'), false);
  assert.equal(app.spin(), false);
  assert.equal(app.state.selectionBlocked, 3);
  assert.ok(app.state.toasts.every((t) => t === UNAVAILABLE_OOS));
});

test('4. submission validation rejects an ineligible selection', () => {
  const app = createAppGateHarness({ MLB: 'in' });
  assert.equal(app.spin(), true);
  app.refreshStatus('MLB', 'off');
  // Restore picks artificially to simulate stale slip, then submit must still reject.
  app.state.picks = [{ player: 'Stale' }];
  assert.equal(app.submitSlip(), false);
  assert.equal(app.state.submissionsRejected, 1);
});

test('5. previously selected market becomes invalid after status refresh', () => {
  const app = createAppGateHarness({ MLB: 'in' });
  assert.equal(app.spin(), true);
  assert.equal(app.state.picks.length, 1);
  app.refreshStatus('MLB', 'off');
  assert.equal(app.state.picks.length, 0);
  assert.ok(app.state.toasts.includes(UNAVAILABLE_OOS));
});

test('6. active-season off day remains selectable', () => {
  const st = resolveLeagueSeasonStatus(mlbSb({ type: 2 }), Date.parse('2026-07-04T12:00:00Z'));
  assert.equal(st.status, STATUS.IN);
  assert.equal(evaluateMarketEligibility(st.status, 'MLB', 'HR').ok, true);
});

test('7. postseason remains active until season endDate', () => {
  const st = resolveLeagueSeasonStatus(mlbSb({ type: 3 }), Date.parse('2026-10-20T12:00:00Z'));
  assert.equal(st.status, STATUS.IN);
  assert.equal(evaluateMarketEligibility(st.status, 'MLB', 'HR').ok, true);
});

test('8. next season starting updates badge and eligibility', () => {
  const before = resolveLeagueSeasonStatus(
    mlbSb({ startDate: '2027-02-19T08:00Z', endDate: '2027-11-12T07:59Z', type: 2 }),
    Date.parse('2027-02-10T12:00:00Z')
  );
  const after = resolveLeagueSeasonStatus(
    mlbSb({ startDate: '2027-02-19T08:00Z', endDate: '2027-11-12T07:59Z', type: 1 }),
    Date.parse('2027-02-19T08:00:00Z')
  );
  assert.equal(before.status, STATUS.OFF);
  assert.equal(badgeLabelForStatus(before.status), OFF_SEASON_LABEL);
  assert.equal(evaluateMarketEligibility(before.status, 'MLB', 'HR').ok, false);
  assert.equal(after.status, STATUS.IN);
  assert.equal(badgeLabelForStatus(after.status), null);
  assert.equal(evaluateMarketEligibility(after.status, 'MLB', 'HR').ok, true);
});

test('9. stale or missing provider data does not silently unlock unavailable markets', () => {
  assert.equal(evaluateMarketEligibility('unknown', 'MLB', 'HR').ok, false);
  assert.match(evaluateMarketEligibility('unknown', 'MLB', 'HR').reason, /unavailable|locked/i);
  const st = resolveLeagueSeasonStatus(mlbSb({ type: 3 }), Date.parse('2026-11-21T12:00:00Z'));
  assert.equal(st.status, STATUS.OFF);
  assert.equal(evaluateMarketEligibility(st.status, 'WNBA', 'Points').ok, false);
});

test('10. app has no next-season futures — all markets require active season', () => {
  assert.equal(marketRequiresActiveSeason('MLB', 'HR'), true);
  assert.equal(marketRequiresActiveSeason('NFL', 'TDs'), true);
  // Even a hypothetical "futures" option name is blocked while off-season.
  assert.equal(evaluateMarketEligibility('off', 'NFL', 'Super Bowl Winner').ok, false);
  // In-season upcoming slate markets remain available (Spin loads today's/next games).
  assert.equal(evaluateMarketEligibility('in', 'NFL', 'TDs').ok, true);
});

test('11. closed or expired markets remain blocked even when league is active', () => {
  assert.equal(evaluateMarketAvailability({ closed: true }).ok, false);
  assert.equal(evaluateMarketAvailability({ expired: true }).ok, false);
  assert.equal(evaluateMarketAvailability({ suspended: true }).ok, false);
  assert.equal(evaluateMarketEligibility('in', 'NBA', 'Points', { closed: true }).ok, false);
  assert.equal(evaluateMarketEligibility('in', 'NBA', 'Points', { status: 'expired' }).ok, false);
  assert.equal(evaluateMarketEligibility('in', 'NBA', 'Points', { availability: 'open' }).ok, true);
});

test('index.html wires Off-season badge markup and shared eligibility helpers', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /oos-badge/);
  assert.match(html, /Off-season/);
  assert.match(html, /getLeagueSeasonStatus/);
  assert.match(html, /assertMarketSelectable/);
  assert.match(html, /_guardSpinForSeason/);
  assert.match(html, /league-market-eligibility\.js/);
  assert.match(html, /Unavailable during the off-season/);
  // Nav must not rely on lock-only affordance without the text badge.
  assert.match(html, /oos-badge.*Off-season|OFF_SEASON_LABEL/);
});

test('eligibility module loads in a browser-like VM (no invent fields)', () => {
  const code = fs.readFileSync(path.join(__dirname, '../js/league-market-eligibility.js'), 'utf8');
  const sandbox = { LeagueSeasonStatus: require('../js/league-season-status.js') };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.equal(sandbox.LeagueMarketEligibility.OFF_SEASON_LABEL, 'Off-season');
  assert.equal(sandbox.LeagueMarketEligibility.evaluateMarketEligibility('off', 'MLB', 'HR').ok, false);
});
