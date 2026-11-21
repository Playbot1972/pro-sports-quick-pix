/**
 * Season touchdown helpers for NFL/NCAAF TD pick cards.
 * Season-stat UI shows numeric season scoring TDs — never Over/Under lines.
 * Betting lines (dir/line) stay on the pick object for sportsbook handoff.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FootballSeasonTd = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MISSING = '—';

  /** Parse ESPN core athlete statistics → season TD fields (no double-counting). */
  function parseEspnFootballSeasonTds(statsJson) {
    var cats = (((statsJson || {}).splits || {}).categories) || [];
    var scoring = null;
    for (var i = 0; i < cats.length; i++) {
      if (String(cats[i].name || '').toLowerCase() === 'scoring') {
        scoring = cats[i];
        break;
      }
    }
    var byName = {};
    var stats = (scoring && scoring.stats) || [];
    for (var j = 0; j < stats.length; j++) {
      var s = stats[j];
      if (s && s.name) byName[s.name] = s.value;
    }

    function num(v) {
      var n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    // Prefer totalScoringTouchdowns (rush+rec+return). Do not sum with passing.
    var seasonTd = num(byName.totalScoringTouchdowns);
    if (seasonTd == null) seasonTd = num(byName.totalTouchdowns);

    return {
      seasonTd: seasonTd,
      seasonTdPass: num(byName.passingTouchdowns),
      seasonTdRush: num(byName.rushingTouchdowns),
      seasonTdRec: num(byName.receivingTouchdowns),
      seasonTdReturn: num(byName.returnTouchdowns)
    };
  }

  /** Numeric season TD for display, or null when unavailable (not 0). */
  function seasonTdValue(p) {
    if (!p) return null;
    if (p.seasonTd == null || p.seasonTd === '') return null;
    var n = Number(p.seasonTd);
    return Number.isFinite(n) ? n : null;
  }

  function seasonTdDisplayHtml(p) {
    var n = seasonTdValue(p);
    var shown = n == null ? MISSING : String(n);
    return (
      "<span class='muted'><span style='font-weight:700;color:#6ee7ff'>" +
      shown +
      "</span> <span style='opacity:.6;font-size:11px'>TDs</span></span>"
    );
  }

  function seasonTdDetailsHtml(p) {
    var n = seasonTdValue(p);
    var shown = n == null ? MISSING : String(n);
    return "<div class='muted'>Season TDs: " + shown + '</div>';
  }

  /** True if html contains Over/Under betting chrome (regression guard). */
  function htmlHasBettingLine(html) {
    return /\b(Over|Under)\s+\d/.test(String(html || ''));
  }

  function coreStatsUrl(league, seasonYear, athleteId) {
    return (
      'https://sports.core.api.espn.com/v2/sports/football/leagues/' +
      encodeURIComponent(league) +
      '/seasons/' +
      encodeURIComponent(String(seasonYear)) +
      '/types/2/athletes/' +
      encodeURIComponent(String(athleteId)) +
      '/statistics'
    );
  }

  function leagueFromSportPath(sportPath) {
    return String(sportPath || '').indexOf('college-football') >= 0
      ? 'college-football'
      : 'nfl';
  }

  return {
    MISSING: MISSING,
    parseEspnFootballSeasonTds: parseEspnFootballSeasonTds,
    seasonTdValue: seasonTdValue,
    seasonTdDisplayHtml: seasonTdDisplayHtml,
    seasonTdDetailsHtml: seasonTdDetailsHtml,
    htmlHasBettingLine: htmlHasBettingLine,
    coreStatsUrl: coreStatsUrl,
    leagueFromSportPath: leagueFromSportPath
  };
});
