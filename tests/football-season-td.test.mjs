import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseEspnFootballSeasonTds,
  seasonTdValue,
  seasonTdDisplayHtml,
  seasonTdDetailsHtml,
  htmlHasBettingLine
} = require('../js/football-season-td.js');

function scoringFixture({ pass = 0, rush = 0, rec = 0, ret = 0, totalScoring, total } = {}) {
  const totalScoringTouchdowns =
    totalScoring != null ? totalScoring : rush + rec + ret;
  const totalTouchdowns = total != null ? total : totalScoringTouchdowns;
  return {
    splits: {
      categories: [
        {
          name: 'passing',
          stats: [{ name: 'passingTouchdowns', value: pass }, { name: 'totalTouchdowns', value: pass + rush }]
        },
        {
          name: 'scoring',
          stats: [
            { name: 'passingTouchdowns', value: pass },
            { name: 'rushingTouchdowns', value: rush },
            { name: 'receivingTouchdowns', value: rec },
            { name: 'returnTouchdowns', value: ret },
            { name: 'totalScoringTouchdowns', value: totalScoringTouchdowns },
            { name: 'totalTouchdowns', value: totalTouchdowns }
          ]
        }
      ]
    }
  };
}

test('parseEspnFootballSeasonTds uses scoring totalScoringTouchdowns (not pass+rush double count)', () => {
  // Josh Allen-like: 13 pass + 11 rush; scoring total is 11 (anytime / scoring TDs)
  const parsed = parseEspnFootballSeasonTds(
    scoringFixture({ pass: 13, rush: 11, rec: 0, ret: 0, totalScoring: 11, total: 11 })
  );
  assert.equal(parsed.seasonTd, 11);
  assert.equal(parsed.seasonTdPass, 13);
  assert.equal(parsed.seasonTdRush, 11);
  assert.equal(parsed.seasonTdRec, 0);
  assert.notEqual(parsed.seasonTd, 24);
});

test('parseEspnFootballSeasonTds returns 0 for true zero season TDs', () => {
  const parsed = parseEspnFootballSeasonTds(
    scoringFixture({ pass: 0, rush: 0, rec: 0, ret: 0, totalScoring: 0, total: 0 })
  );
  assert.equal(parsed.seasonTd, 0);
});

test('parseEspnFootballSeasonTds returns null seasonTd when scoring stats missing', () => {
  const parsed = parseEspnFootballSeasonTds({ splits: { categories: [] } });
  assert.equal(parsed.seasonTd, null);
});

test('seasonTdValue treats real zero as 0 and missing as null', () => {
  assert.equal(seasonTdValue({ seasonTd: 0 }), 0);
  assert.equal(seasonTdValue({ seasonTd: 7 }), 7);
  assert.equal(seasonTdValue({}), null);
  assert.equal(seasonTdValue({ seasonTd: null }), null);
  assert.equal(seasonTdValue({ dir: 'Over', line: 0.5 }), null);
});

test('season-stat display shows numeric season TDs, never Over/Under lines', () => {
  const withTds = { seasonTd: 3, dir: 'Over', line: 0.5 };
  const zero = { seasonTd: 0, dir: 'Under', line: 0.5 };
  const missing = { dir: 'Over', line: 0.5 };

  const d1 = seasonTdDisplayHtml(withTds);
  const d0 = seasonTdDisplayHtml(zero);
  const dm = seasonTdDisplayHtml(missing);
  const t1 = seasonTdDetailsHtml(withTds);
  const t0 = seasonTdDetailsHtml(zero);
  const tm = seasonTdDetailsHtml(missing);

  assert.match(d1, />3</);
  assert.match(d0, />0</);
  assert.match(dm, />—</);
  assert.match(t1, /Season TDs: 3/);
  assert.match(t0, /Season TDs: 0/);
  assert.match(tm, /Season TDs: —/);

  for (const html of [d1, d0, dm, t1, t0, tm]) {
    assert.equal(htmlHasBettingLine(html), false, html);
  }
});
