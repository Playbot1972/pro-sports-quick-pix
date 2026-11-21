/**
 * Shared league season status + market eligibility.
 * Season-dependent Quick Pix markets require an active league phase.
 * This app has no next-season futures markets — off-season blocks selection.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      typeof require === 'function' ? require('./league-season-status.js') : root.LeagueSeasonStatus
    );
  } else {
    root.LeagueMarketEligibility = factory(root.LeagueSeasonStatus);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LeagueSeasonStatus) {
  'use strict';

  var OFF = (LeagueSeasonStatus && LeagueSeasonStatus.OFF_SEASON_LABEL) || 'Off-season';
  var UNAVAILABLE_OOS = 'Unavailable during the off-season';

  /**
   * Policy: this app has no next-season futures markets. Every Quick Pix option
   * (HR, Ks, TDs, Points, …) requires a confirmed active league phase.
   * Valid "future" support is limited to upcoming games inside the current season
   * (today's/next slate loaded by Spin) — not published next-season futures.
   */
  function marketRequiresActiveSeason(sport, option) {
    void sport;
    void option;
    return true;
  }

  /**
   * Optional market/event availability overlay (closed, expired, suspended).
   * An active league must not make unavailable markets selectable.
   * @param {{availability?: string, status?: string, closed?: boolean, expired?: boolean, suspended?: boolean}|null|undefined} marketMeta
   */
  function evaluateMarketAvailability(marketMeta) {
    if (!marketMeta || typeof marketMeta !== 'object') return { ok: true, reason: null };
    var raw = String(
      marketMeta.availability || marketMeta.status || ''
    ).toLowerCase();
    if (marketMeta.closed === true || raw === 'closed') {
      return { ok: false, reason: 'This market is closed.' };
    }
    if (marketMeta.expired === true || raw === 'expired') {
      return { ok: false, reason: 'This market has expired.' };
    }
    if (marketMeta.suspended === true || raw === 'suspended') {
      return { ok: false, reason: 'This market is suspended.' };
    }
    if (raw === 'unavailable' || raw === 'inactive') {
      return { ok: false, reason: 'This market is unavailable.' };
    }
    return { ok: true, reason: null };
  }

  /**
   * @param {'in'|'off'|'unknown'} status
   * @param {string} sport
   * @param {string} [option]
   * @param {object} [marketMeta]
   */
  function evaluateMarketEligibility(status, sport, option, marketMeta) {
    var avail = evaluateMarketAvailability(marketMeta);
    if (!avail.ok) {
      return {
        ok: false,
        reason: avail.reason,
        status: status || 'unknown',
        label: status === 'off' ? OFF : null
      };
    }
    if (!marketRequiresActiveSeason(sport, option)) {
      return { ok: true, reason: null, status: status || 'unknown' };
    }
    if (status === 'off') {
      return { ok: false, reason: UNAVAILABLE_OOS, status: 'off', label: OFF };
    }
    if (status === 'unknown') {
      // Do not silently unlock: unknown is not confirmed active.
      return {
        ok: false,
        reason: 'Season status unavailable — markets locked until status is confirmed.',
        status: 'unknown',
        label: null
      };
    }
    if (status === 'in') {
      return { ok: true, reason: null, status: 'in' };
    }
    return {
      ok: false,
      reason: 'Season status unavailable — markets locked until status is confirmed.',
      status: 'unknown',
      label: null
    };
  }

  function badgeLabelForStatus(status) {
    return status === 'off' ? OFF : null;
  }

  return {
    OFF_SEASON_LABEL: OFF,
    UNAVAILABLE_OOS: UNAVAILABLE_OOS,
    marketRequiresActiveSeason: marketRequiresActiveSeason,
    evaluateMarketAvailability: evaluateMarketAvailability,
    evaluateMarketEligibility: evaluateMarketEligibility,
    badgeLabelForStatus: badgeLabelForStatus
  };
});
