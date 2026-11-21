/**
 * League season-status resolution from ESPN scoreboard payloads.
 * Never treats bare season.type alone as "in season" — that field often
 * still describes the most recently completed season during the off-season.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LeagueSeasonStatus = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATUS = { IN: 'in', OFF: 'off', UNKNOWN: 'unknown' };
  var OFF_SEASON_LABEL = 'Off-season';

  function parseMs(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    var t = Date.parse(String(v));
    return Number.isFinite(t) ? t : NaN;
  }

  function phaseKind(label) {
    var s = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (/(^|\b)off[-\s]?season(\b|$)/.test(s)) return 'off';
    if (/(^|\b)pre[-\s]?season(\b|$)/.test(s)) return 'pre';
    if (/(^|\b)post[-\s]?season(\b|$)|playoff|playoffs|championship|super bowl|world series|finals/.test(s)) {
      return 'post';
    }
    if (/(^|\b)regular(\b|$)|regular season/.test(s)) return 'regular';
    return null;
  }

  function labeledCalendarPhases(scoreboard) {
    var leagues = (scoreboard && scoreboard.leagues) || [];
    var league = leagues[0] || {};
    var cal = league.calendar;
    if (!Array.isArray(cal) || !cal.length) return [];
    var out = [];
    for (var i = 0; i < cal.length; i++) {
      var c = cal[i];
      if (!c || typeof c !== 'object') continue;
      // Day calendars are date strings / sparse arrays — skip those.
      if (typeof c === 'string') continue;
      var label = c.label || c.summary || c.name || '';
      var start = parseMs(c.startDate);
      var end = parseMs(c.endDate);
      if (!label || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      var kind = phaseKind(label);
      if (!kind) continue;
      out.push({ label: String(label), kind: kind, start: start, end: end });
    }
    return out;
  }

  function leagueSeasonWindow(scoreboard) {
    var leagues = (scoreboard && scoreboard.leagues) || [];
    var season = (leagues[0] && leagues[0].season) || null;
    if (!season) return null;
    var start = parseMs(season.startDate);
    var end = parseMs(season.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start: start, end: end, year: season.year != null ? Number(season.year) : null };
  }

  /**
   * @param {object} scoreboard ESPN site scoreboard JSON
   * @param {number} [nowMs] injectable clock
   * @returns {{status:'in'|'off'|'unknown', phase:string|null, source:string, label:string|null}}
   */
  function resolveLeagueSeasonStatus(scoreboard, nowMs) {
    var now = Number.isFinite(nowMs) ? nowMs : Date.now();
    var phases = labeledCalendarPhases(scoreboard);
    if (phases.length) {
      for (var i = 0; i < phases.length; i++) {
        var p = phases[i];
        // ESPN endDate is typically exclusive-ish end-of-window; treat [start, end] inclusive of end instant.
        if (now >= p.start && now <= p.end) {
          if (p.kind === 'off') {
            return { status: STATUS.OFF, phase: p.label, source: 'calendar', label: OFF_SEASON_LABEL };
          }
          // Preseason, regular, and postseason are all active competition.
          return { status: STATUS.IN, phase: p.label, source: 'calendar', label: p.label };
        }
      }
      // Labeled calendar present but now outside every window → off until next supported phase.
      return { status: STATUS.OFF, phase: null, source: 'calendar-gap', label: OFF_SEASON_LABEL };
    }

    var win = leagueSeasonWindow(scoreboard);
    if (win) {
      if (now < win.start || now > win.end) {
        return { status: STATUS.OFF, phase: null, source: 'season-window', label: OFF_SEASON_LABEL };
      }
      var topType = scoreboard && scoreboard.season && scoreboard.season.type;
      var phase =
        Number(topType) === 1
          ? 'Preseason'
          : Number(topType) === 3
            ? 'Postseason'
            : Number(topType) === 2
              ? 'Regular Season'
              : 'In season';
      return { status: STATUS.IN, phase: phase, source: 'season-window', label: phase };
    }

    // No authoritative window. Do NOT infer from empty events or bare season.type.
    return { status: STATUS.UNKNOWN, phase: null, source: 'insufficient', label: null };
  }

  /** Legacy boolean helper for tests: only true when status === 'in'. */
  function isInSeason(scoreboard, nowMs) {
    return resolveLeagueSeasonStatus(scoreboard, nowMs).status === STATUS.IN;
  }

  return {
    STATUS: STATUS,
    OFF_SEASON_LABEL: OFF_SEASON_LABEL,
    resolveLeagueSeasonStatus: resolveLeagueSeasonStatus,
    isInSeason: isInSeason,
    labeledCalendarPhases: labeledCalendarPhases,
    leagueSeasonWindow: leagueSeasonWindow,
    phaseKind: phaseKind
  };
});
