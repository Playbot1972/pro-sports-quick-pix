import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveLeagueSeasonStatus,
  OFF_SEASON_LABEL,
  STATUS
} = require('../js/league-season-status.js');

const MLB_END = '2026-11-12T07:59Z';
const MLB_START = '2026-02-19T08:00Z';

function mlbScoreboard({ seasonType = 3, startDate = MLB_START, endDate = MLB_END, events = [] } = {}) {
  return {
    season: { type: seasonType, year: 2026 },
    leagues: [
      {
        season: {
          year: 2026,
          type: { id: '2', type: 2, name: 'Regular Season' },
          startDate,
          endDate
        },
        calendarType: 'day',
        calendar: ['2026-02-19T08:00Z']
      }
    ],
    events
  };
}

function nflCalendarScoreboard(nowPhase) {
  const cal = [
    { label: 'Preseason', startDate: '2026-08-06T07:00Z', endDate: '2026-09-06T06:59Z' },
    { label: 'Regular Season', startDate: '2026-09-06T07:00Z', endDate: '2027-01-13T07:59Z' },
    { label: 'Postseason', startDate: '2027-01-13T08:00Z', endDate: '2027-02-16T07:59Z' },
    { label: 'Off Season', startDate: '2027-02-16T08:00Z', endDate: '2027-08-01T06:59Z' }
  ];
  return {
    season: { type: 2, year: 2026 },
    leagues: [{ season: { year: 2026, startDate: '2026-08-06T07:00Z', endDate: '2027-02-16T07:59Z' }, calendar: cal }],
    events: nowPhase === 'regular' ? [{ date: '2026-11-21T18:00Z', status: { type: { name: 'STATUS_SCHEDULED' } } }] : []
  };
}

test('MLB regression: completed season with season.type still set is Off-season', () => {
  // Reproduces the bug: probe used season.type>=1 and marked MLB in-season after World Series.
  const now = Date.parse('2026-11-21T12:00:00Z');
  const sb = mlbScoreboard({
    seasonType: 3,
    events: [{ date: '2026-11-01T00:00Z', status: { type: { name: 'STATUS_FINAL' } } }]
  });
  const r = resolveLeagueSeasonStatus(sb, now);
  assert.equal(r.status, STATUS.OFF);
  assert.equal(r.label, OFF_SEASON_LABEL);
  assert.equal(r.source, 'season-window');
});

test('MLB active regular season stays in-season even with an off day (no events)', () => {
  const now = Date.parse('2026-07-04T17:00:00Z');
  const r = resolveLeagueSeasonStatus(mlbScoreboard({ seasonType: 2, events: [] }), now);
  assert.equal(r.status, STATUS.IN);
  assert.notEqual(r.label, OFF_SEASON_LABEL);
});

test('MLB active postseason (before endDate) stays in-season', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  const r = resolveLeagueSeasonStatus(mlbScoreboard({ seasonType: 3 }), now);
  assert.equal(r.status, STATUS.IN);
  assert.match(String(r.phase), /Postseason/i);
});

test('next season restart: before startDate is Off-season; on startDate is in', () => {
  const before = resolveLeagueSeasonStatus(
    mlbScoreboard({ startDate: '2027-02-19T08:00Z', endDate: '2027-11-12T07:59Z', seasonType: 2 }),
    Date.parse('2027-02-10T00:00:00Z')
  );
  const onStart = resolveLeagueSeasonStatus(
    mlbScoreboard({ startDate: '2027-02-19T08:00Z', endDate: '2027-11-12T07:59Z', seasonType: 1 }),
    Date.parse('2027-02-19T08:00:00Z')
  );
  assert.equal(before.status, STATUS.OFF);
  assert.equal(onStart.status, STATUS.IN);
});

test('NFL calendar: regular season in; off-season labeled Off-season; postseason in', () => {
  const sb = nflCalendarScoreboard('regular');
  assert.equal(resolveLeagueSeasonStatus(sb, Date.parse('2026-11-21T12:00:00Z')).status, STATUS.IN);
  assert.equal(resolveLeagueSeasonStatus(sb, Date.parse('2027-01-20T12:00:00Z')).status, STATUS.IN);
  const off = resolveLeagueSeasonStatus(sb, Date.parse('2027-03-01T12:00:00Z'));
  assert.equal(off.status, STATUS.OFF);
  assert.equal(off.label, OFF_SEASON_LABEL);
  assert.equal(off.source, 'calendar');
});

test('season spanning calendar years: Jan still in NFL regular/post window', () => {
  const sb = nflCalendarScoreboard();
  const jan = resolveLeagueSeasonStatus(sb, Date.parse('2027-01-05T12:00:00Z'));
  assert.equal(jan.status, STATUS.IN);
});

test('preseason is active (ends off-season)', () => {
  const sb = nflCalendarScoreboard();
  const pre = resolveLeagueSeasonStatus(sb, Date.parse('2026-08-15T12:00:00Z'));
  assert.equal(pre.status, STATUS.IN);
  assert.match(String(pre.phase), /Preseason/i);
});

test('bare season.type without dates is unknown (not falsely in or off)', () => {
  const r = resolveLeagueSeasonStatus(
    { season: { type: 2, year: 2026 }, leagues: [{}], events: [] },
    Date.parse('2026-11-21T12:00:00Z')
  );
  assert.equal(r.status, STATUS.UNKNOWN);
});

test('empty events alone do not force Off-season when season window is active', () => {
  const r = resolveLeagueSeasonStatus(mlbScoreboard({ events: [] }), Date.parse('2026-06-15T12:00:00Z'));
  assert.equal(r.status, STATUS.IN);
});

test('Off-season label spelling is exact', () => {
  assert.equal(OFF_SEASON_LABEL, 'Off-season');
  const r = resolveLeagueSeasonStatus(mlbScoreboard(), Date.parse('2026-11-21T12:00:00Z'));
  assert.equal(r.label, 'Off-season');
});
