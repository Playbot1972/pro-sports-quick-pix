/**
 * Pro Sports Win — sportsbook handoff service (v2).
 * Normalize picks → match markets → adapter link builders → user places wager in licensed book.
 */
(function (global) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const STORAGE_STATE = 'psw_handoff_state';
  const STORAGE_BOOK = 'psw_handoff_book';

  const DESTINATION_ORDER = ['betslip', 'event', 'market', 'league', 'home', 'copy_only'];

  const US_STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
    'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
    'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  ];

  /** In-app market tab → canonical taxonomy (book adapters map from here). */
  const MARKET_TAXONOMY = {
    'MLB|HR': { key: 'mlb.player.home_run', family: 'player_prop', bookSearch: ['home run', 'to hit a home run', 'hr'] },
    'MLB|Ks': { key: 'mlb.player.strikeouts', family: 'player_prop', bookSearch: ['strikeouts', 'pitcher strikeouts', 'k\'s'] },
    'MLB|Hits': { key: 'mlb.player.hits', family: 'player_prop', bookSearch: ['hits', 'player hits'] },
    'MLB|Total Bases': { key: 'mlb.player.total_bases', family: 'player_prop', bookSearch: ['total bases', 'tb'] },
    'MLB|RBI': { key: 'mlb.player.rbi', family: 'player_prop', bookSearch: ['rbi', 'runs batted in'] },
    'NFL|TDs': { key: 'nfl.player.touchdown', family: 'player_prop', bookSearch: ['anytime touchdown', 'td scorer'] },
    'NFL|Pass Yds': { key: 'nfl.player.pass_yards', family: 'player_prop', bookSearch: ['passing yards'] },
    'NFL|Rush Yds': { key: 'nfl.player.rush_yards', family: 'player_prop', bookSearch: ['rushing yards'] },
    'NFL|Rec Yds': { key: 'nfl.player.rec_yards', family: 'player_prop', bookSearch: ['receiving yards'] },
    'NFL|Receptions': { key: 'nfl.player.receptions', family: 'player_prop', bookSearch: ['receptions'] },
    'NBA|Points': { key: 'nba.player.points', family: 'player_prop', bookSearch: ['points'] },
    'NBA|Assists': { key: 'nba.player.assists', family: 'player_prop', bookSearch: ['assists'] },
    'NBA|Rebounds': { key: 'nba.player.rebounds', family: 'player_prop', bookSearch: ['rebounds'] },
    'NBA|3PM': { key: 'nba.player.threes', family: 'player_prop', bookSearch: ['threes', '3-pointers'] },
    'NBA|PRA': { key: 'nba.player.pra', family: 'player_prop', bookSearch: ['points rebounds assists', 'pra'] },
    'NHL|Goals': { key: 'nhl.player.goals', family: 'player_prop', bookSearch: ['goals', 'anytime goal'] },
    'NHL|Shots': { key: 'nhl.player.shots', family: 'player_prop', bookSearch: ['shots on goal', 'sog'] },
    'NHL|Assists': { key: 'nhl.player.assists', family: 'player_prop', bookSearch: ['assists'] },
    'NHL|Points': { key: 'nhl.player.points', family: 'player_prop', bookSearch: ['points'] },
    'NHL|Goalie Saves': { key: 'nhl.player.goalie_saves', family: 'player_prop', bookSearch: ['goalie saves', 'saves'] },
    'Soccer|Goals': { key: 'soccer.player.goals', family: 'player_prop', bookSearch: ['goals', 'anytime goalscorer'] },
    'Soccer|Assists': { key: 'soccer.player.assists', family: 'player_prop', bookSearch: ['assists'] },
    'Soccer|Shots': { key: 'soccer.player.shots', family: 'player_prop', bookSearch: ['shots'] },
    'Soccer|SOT': { key: 'soccer.player.shots_on_target', family: 'player_prop', bookSearch: ['shots on target'] },
    'Soccer|GK Saves': { key: 'soccer.player.gk_saves', family: 'player_prop', bookSearch: ['goalkeeper saves'] },
  };

  const SPORT_LEAGUE = {
    MLB: 'MLB',
    NFL: 'NFL',
    NBA: 'NBA',
    NHL: 'NHL',
    Soccer: 'MLS',
  };

  function storageGet(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch (_) {
      return '';
    }
  }

  function storageSet(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (_) {}
  }

  function getUserState() {
    return String(storageGet(STORAGE_STATE) || '')
      .trim()
      .toUpperCase()
      .slice(0, 2);
  }

  function setUserState(code) {
    storageSet(STORAGE_STATE, String(code || '').toUpperCase().slice(0, 2));
  }

  function getPreferredBookId() {
    return storageGet(STORAGE_BOOK);
  }

  function setPreferredBookId(id) {
    storageSet(STORAGE_BOOK, id);
    refreshHandoffBars();
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatGameTime(g) {
    if (!g || !g.gameDate) return '';
    try {
      const d = new Date(g.gameDate);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    } catch (_) {
      return '';
    }
  }

  function eventLabelFromPick(raw) {
    const team = raw.teamAbbr || raw.team || '';
    const opp = raw.oppTeamAbbr || '';
    if (team && opp) return team + ' vs ' + opp;
    if (raw.game && raw.game.homeAbbr && raw.game.awayAbbr) {
      return raw.game.awayAbbr + ' @ ' + raw.game.homeAbbr;
    }
    return team || 'Today\'s slate';
  }

  function lineDisplayFromContext(ctx, raw) {
    const sport = ctx.sport;
    const opt = ctx.option;
    if (sport === 'MLB' && opt === 'HR') return '1+ HR';
    if (sport === 'MLB' && opt === 'Ks') return (raw.dir || 'Over') + ' ' + (raw.kLine || '') + ' K';
    if (raw.dir && raw.line != null && raw.line !== '') return raw.dir + ' ' + raw.line;
    if (sport === 'NFL' && opt === 'TDs' && raw.td != null) return String(raw.td) + ' TD (season context)';
    return raw.statLabel || opt || '';
  }

  function marketLabelFromTaxonomy(tax, ctx, raw) {
    if (!tax) return String(ctx.option || 'Player prop');
    if (ctx.sport === 'MLB' && ctx.option === 'HR') return '1+ Home Run (player prop)';
    if (ctx.sport === 'MLB' && ctx.option === 'Ks') {
      return (raw.dir || 'Over') + ' ' + (raw.kLine || '') + ' Strikeouts';
    }
    if (raw.dir && raw.line != null && raw.line !== '') {
      return (raw.dir || 'Over') + ' ' + raw.line + ' ' + (raw.statLabel || ctx.option);
    }
    return (tax.bookSearch && tax.bookSearch[0]) || ctx.option;
  }

  /** Market matcher — PSW tabs → canonical taxonomy + book-facing labels. */
  const MarketMatcher = {
    resolve(ctx) {
      const key = String(ctx.sport || '') + '|' + String(ctx.option || '');
      const tax = MARKET_TAXONOMY[key] || {
        key: 'generic.player_prop',
        family: 'player_prop',
        bookSearch: [ctx.option || 'player prop'],
      };
      return tax;
    },
    searchQuery(np) {
      const parts = [
        np.player.name,
        np.market.bookLabel,
        np.market.canonicalKey,
        np.event.label,
        np.league,
      ];
      return parts.filter(Boolean).join(' ');
    },
  };

  function joinUrl(base, path) {
    if (!path) return base;
    const b = String(base || '').replace(/\/?$/, '/');
    const p = String(path).replace(/^\//, '');
    return b + p;
  }

  /**
   * Build destination candidates for a book. Partner betslip URLs can be added per adapter when available.
   * @param {object} adapter
   * @param {object} np normalized pick
   * @returns {Array<{tier:string,kind:string,url:string,label:string,prefilledAvailable:boolean,userHint:string}>}
   */
  function buildAdapterDestinations(adapter, np) {
    const out = [];
    const sport = np.sport;

    if (typeof adapter.buildBetslipUrl === 'function') {
      const betslip = adapter.buildBetslipUrl(np);
      if (betslip && betslip.url) {
        out.push({
          tier: 'betslip',
          kind: 'betslip',
          url: betslip.url,
          label: betslip.label || ('Open prefilled slip on ' + adapter.shortName),
          prefilledAvailable: !!betslip.prefilledAvailable,
          userHint: 'Prefilled when available — review and submit in ' + adapter.shortName + '.',
        });
      }
    }

    if (typeof adapter.buildEventUrl === 'function') {
      const ev = adapter.buildEventUrl(np);
      if (ev && ev.url) {
        out.push({
          tier: 'event',
          kind: 'event',
          url: ev.url,
          label: ev.label || ('Open game on ' + adapter.shortName),
          prefilledAvailable: false,
          userHint: 'Opens the game page — find this player prop in the book.',
        });
      }
    }

    const marketPath = adapter.marketPaths && adapter.marketPaths[sport];
    if (marketPath) {
      out.push({
        tier: 'market',
        kind: 'market',
        url: joinUrl(adapter.homeUrl, marketPath),
        label: 'Open ' + sport + ' player props on ' + adapter.shortName,
        prefilledAvailable: false,
        userHint: 'Opens the props section — search for: ' + np.handoff.searchQuery,
      });
    }

    const leaguePath = adapter.leaguePaths && adapter.leaguePaths[sport];
    if (leaguePath) {
      out.push({
        tier: 'league',
        kind: 'league',
        url: joinUrl(adapter.homeUrl, leaguePath),
        label: 'Open ' + sport + ' on ' + adapter.shortName,
        prefilledAvailable: false,
        userHint: 'Opens the league — use search or copy text to find this market.',
      });
    }

    out.push({
      tier: 'home',
      kind: 'home',
      url: adapter.homeUrl,
      label: 'Open ' + adapter.shortName,
      prefilledAvailable: false,
      userHint: 'Copy the bet or search for: ' + np.handoff.searchQuery,
    });

    return out;
  }

  function pickBestDestination(candidates) {
    if (!candidates || !candidates.length) {
      return {
        tier: 'copy_only',
        kind: 'copy_only',
        url: '',
        label: 'Copy bet and search in sportsbook',
        prefilledAvailable: false,
        userHint: 'No supported link — copy the bet and search manually.',
      };
    }
    const sorted = candidates.slice().sort(function (a, b) {
      return DESTINATION_ORDER.indexOf(a.tier) - DESTINATION_ORDER.indexOf(b.tier);
    });
    return sorted[0];
  }

  function createAdapter(def) {
    const adapter = Object.assign(
      {
        shortName: def.name.split(' ')[0],
        buildDestinations(np) {
          return buildAdapterDestinations(adapter, np);
        },
        mapMarket(np) {
          const tax = np.market && np.market.canonicalKey
            ? { key: np.market.canonicalKey, bookSearch: np.market.bookSearchTerms || [] }
            : MarketMatcher.resolve({ sport: np.sport, option: np.market.tabLabel });
          return tax;
        },
      },
      def,
    );
    return adapter;
  }

  const ADAPTERS = [
    createAdapter({
      id: 'draftkings',
      name: 'DraftKings',
      homeUrl: 'https://sportsbook.draftkings.com/',
      leaguePaths: {
        MLB: 'leagues/baseball/mlb',
        NFL: 'leagues/football/nfl',
        NBA: 'leagues/basketball/nba',
        NHL: 'leagues/hockey/nhl',
        Soccer: 'leagues/soccer',
      },
      marketPaths: {
        MLB: 'leagues/baseball/mlb?category=player-props',
        NFL: 'leagues/football/nfl?category=player-props',
        NBA: 'leagues/basketball/nba?category=player-props',
        NHL: 'leagues/hockey/nhl?category=player-props',
      },
      states: [
        'AZ', 'CO', 'CT', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'NH', 'NJ', 'NY', 'NC', 'OH',
        'OR', 'PA', 'TN', 'VT', 'VA', 'WV', 'WY', 'DC',
      ],
      buildEventUrl(np) {
        if (!np.event.eventId || np.sport !== 'MLB') return null;
        return null;
      },
      buildBetslipUrl() {
        return null;
      },
    }),
    createAdapter({
      id: 'fanduel',
      name: 'FanDuel',
      homeUrl: 'https://sportsbook.fanduel.com/',
      leaguePaths: {
        MLB: 'navigation/mlb',
        NFL: 'navigation/nfl',
        NBA: 'navigation/nba',
        NHL: 'navigation/nhl',
        Soccer: 'soccer',
      },
      marketPaths: {
        MLB: 'navigation/mlb?tab=player-props',
        NFL: 'navigation/nfl?tab=player-props',
        NBA: 'navigation/nba?tab=player-props',
        NHL: 'navigation/nhl?tab=player-props',
      },
      states: [
        'AZ', 'CO', 'CT', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'MD', 'MA', 'MI', 'NJ', 'NY', 'NC', 'OH', 'PA', 'TN',
        'VT', 'VA', 'WV', 'WY', 'DC',
      ],
      buildBetslipUrl() {
        return null;
      },
    }),
    createAdapter({
      id: 'betmgm',
      name: 'BetMGM',
      homeUrl: 'https://sports.betmgm.com/',
      leaguePaths: {
        MLB: 'en/sports/baseball-11/betting/usa-9/mlb-75',
        NFL: 'en/sports/football-11/betting/usa-9/nfl-35',
        NBA: 'en/sports/basketball-7/betting/usa-9/nba-6004',
        NHL: 'en/sports/ice-hockey-12/betting/usa-9/nhl-34',
        Soccer: 'en/sports/soccer-4',
      },
      states: [
        'AZ', 'CO', 'DC', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'MD', 'MA', 'MI', 'MS', 'NV', 'NJ', 'NY', 'NC', 'OH',
        'PA', 'TN', 'VA', 'WV', 'WY',
      ],
      buildBetslipUrl() {
        return null;
      },
    }),
    createAdapter({
      id: 'caesars',
      name: 'Caesars Sportsbook',
      shortName: 'Caesars',
      homeUrl: 'https://www.caesars.com/sportsbook-and-casino',
      leaguePaths: {},
      marketPaths: {},
      states: [
        'AZ', 'CO', 'DC', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'MD', 'MA', 'MI', 'NJ', 'NY', 'NC', 'OH', 'PA', 'TN',
        'VA', 'WV', 'WY',
      ],
      buildBetslipUrl() {
        return null;
      },
    }),
  ];

  function getAdapter(id) {
    return ADAPTERS.find(function (a) {
      return a.id === id;
    });
  }

  function booksForState(stateCode) {
    const st = String(stateCode || '').toUpperCase();
    if (!st) return ADAPTERS.slice();
    return ADAPTERS.filter(function (b) {
      return b.states.indexOf(st) >= 0;
    });
  }

  const HandoffService = {
    normalize(raw, ctx) {
      if (!raw || !ctx) return null;
      const g = raw.game || null;
      const tax = MarketMatcher.resolve(ctx);
      const eventId = String(raw.gamePk || (g && (g.gamePk || g.id)) || '').trim();
      const espnId = raw.espnId != null ? String(raw.espnId) : '';
      const mlbId = raw.playerId != null ? String(raw.playerId) : '';
      const lineDisplay = lineDisplayFromContext(ctx, raw);
      const bookLabel = marketLabelFromTaxonomy(tax, ctx, raw);

      const np = {
        schemaVersion: SCHEMA_VERSION,
        sport: ctx.sport,
        league: SPORT_LEAGUE[ctx.sport] || ctx.sport,
        market: {
          tabLabel: ctx.option,
          canonicalKey: tax.key,
          family: tax.family,
          bookLabel: bookLabel,
          bookSearchTerms: tax.bookSearch || [],
        },
        player: {
          name: String(raw.player || '').trim(),
          teamAbbr: raw.teamAbbr || raw.team || '',
          opponentAbbr: raw.oppTeamAbbr || '',
          position: raw.pos || '',
        },
        event: {
          label: eventLabelFromPick(raw),
          startTimeIso: g && g.gameDate ? String(g.gameDate) : '',
          startTimeDisplay: formatGameTime(g),
          venue: (g && g.venue && g.venue.name) || '',
          status: (g && g.status && (g.status.detailedState || g.status.abstractGameState)) || '',
          eventId: eventId,
        },
        externalIds: {
          espnAthleteId: espnId,
          mlbGamePk: ctx.sport === 'MLB' ? eventId : '',
          providerNote: 'Partner event/player IDs can be bound in adapters when available.',
        },
        selection: {
          side: raw.dir || '',
          line: raw.line != null ? raw.line : raw.kLine != null ? raw.kLine : raw.hr,
          lineDisplay: lineDisplay,
          statLabel: raw.statLabel || ctx.option,
        },
        legs: [
          {
            legIndex: 0,
            marketKey: tax.key,
            playerName: String(raw.player || '').trim(),
            lineDisplay: lineDisplay,
            side: raw.dir || '',
          },
        ],
        odds: {
          american: null,
          decimal: null,
          display: 'See live odds in your sportsbook',
          source: 'not_integrated',
        },
        sportsbook: null,
        state: getUserState(),
        handoff: {
          copyText: '',
          searchQuery: '',
          destination: null,
          destinationTier: 'copy_only',
          prefilledAvailable: false,
          userHint: '',
        },
      };

      np.handoff.searchQuery = MarketMatcher.searchQuery(np);
      return np;
    },

    resolveDestination(np, bookId) {
      const adapter = getAdapter(bookId);
      if (!adapter || !np) return null;
      const candidates = adapter.buildDestinations(np);
      const best = pickBestDestination(candidates);
      return {
        book: { id: adapter.id, name: adapter.name, shortName: adapter.shortName },
        best: best,
        candidates: candidates,
        stateAllowed: !getUserState() || adapter.states.indexOf(getUserState()) >= 0,
      };
    },

    enrich(np, bookId) {
      if (!np) return null;
      const resolved = bookId ? HandoffService.resolveDestination(np, bookId) : null;
      const adapter = bookId ? getAdapter(bookId) : null;
      if (adapter) {
        np.sportsbook = { id: adapter.id, name: adapter.name, shortName: adapter.shortName };
      }
      const dest = resolved ? resolved.best : null;
      np.handoff.destination = dest;
      np.handoff.destinationTier = dest ? dest.tier : 'copy_only';
      np.handoff.prefilledAvailable = !!(dest && dest.prefilledAvailable);
      np.handoff.userHint = dest ? dest.userHint : 'Copy the bet and search in your sportsbook.';
      np.handoff.copyText = HandoffService.formatCopyText(np, adapter);
      np.handoff.deepLinkKind = dest ? dest.kind : 'copy_only';
      np.handoff.deepLinkUrl = dest ? dest.url : '';
      np.handoff.deepLinkLabel = dest ? dest.label : 'Choose a sportsbook';
      np.handoff.statusLabel = HandoffService.destinationStatusLabel(dest);
      return np;
    },

    formatCopyText(np, adapter) {
      if (!np) return '';
      const bookName = (adapter && adapter.name) || (np.sportsbook && np.sportsbook.name) || 'your sportsbook';
      const parts = [
        np.sport + ' — ' + np.player.name,
        np.selection.lineDisplay || np.market.bookLabel,
        np.event.label,
      ];
      if (np.event.startTimeDisplay) parts.push('game ' + np.event.startTimeDisplay);
      parts.push('odds: ' + (np.odds.display || 'check book'));
      parts.push('book: ' + bookName);
      const pref = np.handoff.prefilledAvailable ? 'Prefilled slip may be available in app.' : 'Find market in app (prefilled when available).';
      parts.push(pref);
      parts.push('Entertainment pick — verify line in ' + bookName + '. Not affiliated.');
      return parts.filter(Boolean).join(' · ');
    },

    destinationStatusLabel(dest) {
      if (!dest) return 'Copy + search';
      if (dest.prefilledAvailable) return 'Prefilled when available';
      if (dest.tier === 'event') return 'Open event';
      if (dest.tier === 'market') return 'Open market';
      if (dest.tier === 'league') return 'Open league';
      if (dest.tier === 'home') return 'Open book';
      return 'Copy + search';
    },
  };

  let _resolver = null;

  function registerPickResolver(fn) {
    _resolver = fn;
  }

  function resolvePickAtIndex(idx) {
    if (typeof _resolver !== 'function') return null;
    const resolved = _resolver(idx);
    if (!resolved || !resolved.raw) return null;
    const np = HandoffService.normalize(resolved.raw, resolved.ctx);
    if (!np) return null;
    const bookId = getPreferredBookId();
    return HandoffService.enrich(np, bookId || null);
  }

  function copyTextRobust(text) {
    if (global.copyTextRobust) return global.copyTextRobust(text);
    if (navigator.clipboard && global.isSecureContext !== false) {
      return navigator.clipboard.writeText(text).catch(function () {});
    }
    return Promise.resolve();
  }

  function showToast(msg, kind) {
    if (typeof global.showToast === 'function') global.showToast(msg, kind || '', 'center');
  }

  function trackHandoff(name, params) {
    if (typeof global.trackEvent === 'function') global.trackEvent(name, params || {});
  }

  function leaveDisclaimer(bookName, dest) {
    let extra = '';
    if (dest && dest.prefilledAvailable) {
      extra = ' A prefilled slip may open when supported — always review before submitting.';
    } else {
      extra = ' You may need to search or paste your pick — prefilled slip when available via partner links only.';
    }
    return (
      'You are leaving Pro Sports Win for ' +
      bookName +
      '.' +
      extra +
      ' Place any wager only in their licensed app. 21+ where legal.'
    );
  }

  function openUrl(url, bookName, dest) {
    if (!url) {
      showToast('No link — copy the bet and use View market for search hints.', 'error');
      return;
    }
    if (!global.confirm(leaveDisclaimer(bookName, dest))) return;
    global.open(url, '_blank', 'noopener,noreferrer');
  }

  function copyBet(idx) {
    const np = resolvePickAtIndex(idx);
    if (!np) {
      showToast('No pick to copy.', 'error');
      return;
    }
    const bookId = getPreferredBookId();
    if (bookId) HandoffService.enrich(np, bookId);
    copyTextRobust(np.handoff.copyText).then(function () {
      showToast('Bet copied — paste in your sportsbook.', 'success');
      trackHandoff('handoff_copy_bet', {
        sport: np.sport,
        market: np.market.tabLabel,
        book: bookId || '',
        tier: np.handoff.destinationTier,
      });
    });
  }

  function onOpenBookTap(idx) {
    global._handoffModalPickIdx = idx;
    const bookId = getPreferredBookId();
    if (!bookId) {
      openChooser(idx);
      return;
    }
    openSportsbookForPick(idx, bookId);
  }

  function openSportsbookForPick(idx, bookId) {
    const np = resolvePickAtIndex(idx);
    if (!np) {
      showToast('No pick loaded.', 'error');
      return;
    }
    const adapter = getAdapter(bookId);
    if (!adapter) {
      openChooser(idx);
      return;
    }
    setPreferredBookId(bookId);
    HandoffService.enrich(np, bookId);
    const dest = np.handoff.destination;
    trackHandoff('handoff_open_book', {
      sport: np.sport,
      market: np.market.tabLabel,
      book: bookId,
      tier: np.handoff.destinationTier,
      prefilled: np.handoff.prefilledAvailable,
    });
    openUrl(dest && dest.url, adapter.name, dest);
  }

  function viewMatchingMarket(idx) {
    global._handoffModalPickIdx = idx;
    const np = resolvePickAtIndex(idx);
    if (!np) {
      showToast('No pick loaded.', 'error');
      return;
    }
    const bookId = getPreferredBookId();
    if (bookId) HandoffService.enrich(np, bookId);
    trackHandoff('handoff_view_market', { sport: np.sport, market: np.market.tabLabel });
    renderMarketModal(np);
  }

  function renderChooserModal(idx) {
    const modal = global.document.getElementById('handoffModal');
    const body = global.document.getElementById('handoffModalBody');
    const title = global.document.getElementById('handoffModalTitle');
    if (!modal || !body || !title) return;
    const st = getUserState();
    const list = booksForState(st);
    const np = resolvePickAtIndex(idx);
    title.textContent = 'Choose sportsbook';
    let html =
      '<p class="handoff-modal-lead">Select your state and sportsbook. We open the best supported link (prefilled slip when available, otherwise event, market, or league).</p>';
    html +=
      '<label class="handoff-state-label">Your state<select id="handoffStateSelect" class="handoff-state-select" onchange="PSWHandoff.onStateChange(this.value)">';
    html += '<option value="">Select state…</option>';
    US_STATES.forEach(function (code) {
      html += '<option value="' + code + '"' + (code === st ? ' selected' : '') + '>' + code + '</option>';
    });
    html += '</select></label>';
    if (st && !list.length) {
      html += '<p class="handoff-modal-warn">No books in our MVP list for ' + escapeHtml(st) + '. Copy bet still works.</p>';
    }
    html += '<div class="handoff-book-grid">';
    const show = list.length ? list : ADAPTERS;
    show.forEach(function (adapter) {
      let sub = 'Open book';
      if (np) {
        const preview = HandoffService.resolveDestination(np, adapter.id);
        if (preview && preview.best) {
          sub = preview.best.prefilledAvailable
            ? 'Prefilled when available'
            : HandoffService.destinationStatusLabel(preview.best);
        }
      }
      html +=
        '<button type="button" class="handoff-book-btn" onclick="PSWHandoff.openSportsbookForPick(' +
        idx +
        ", '" +
        adapter.id +
        '\')">' +
        escapeHtml(adapter.shortName) +
        '<span class="handoff-book-sub">' +
        escapeHtml(sub) +
        '</span></button>';
    });
    html += '</div>';
    html +=
      '<button type="button" class="handoff-copy-all-btn" onclick="PSWHandoff.copyBet(' +
      idx +
      ')">Copy bet</button>';
    body.innerHTML = html;
    modal.style.display = 'flex';
  }

  function renderMarketModal(np) {
    const modal = global.document.getElementById('handoffModal');
    const body = global.document.getElementById('handoffModalBody');
    const title = global.document.getElementById('handoffModalTitle');
    if (!modal || !body || !title) return;
    const pickIdx = global._handoffModalPickIdx != null ? global._handoffModalPickIdx : 0;
    const st = getUserState();
    const list = booksForState(st);
    const show = list.length ? list : ADAPTERS;
    title.textContent = 'Matching market';
    let html = '<div class="handoff-market-card">';
    html += '<div class="handoff-dest-pill">' + escapeHtml(np.handoff.statusLabel || 'Copy + search') + '</div>';
    html += '<div class="handoff-market-title">' + escapeHtml(np.selection.lineDisplay) + '</div>';
    html +=
      '<div class="handoff-market-meta">' +
      escapeHtml(np.market.bookLabel) +
      ' · ' +
      escapeHtml(np.player.name) +
      ' · ' +
      escapeHtml(np.event.label) +
      '</div>';
    if (np.event.startTimeDisplay) {
      html += '<div class="handoff-market-meta">' + escapeHtml(np.event.startTimeDisplay) + '</div>';
    }
    html += '<p class="handoff-modal-lead" style="margin:10px 0">' + escapeHtml(np.handoff.userHint) + '</p>';
    html += '<pre class="handoff-copy-block">' + escapeHtml(np.handoff.copyText) + '</pre>';
    html +=
      '<p class="handoff-modal-lead"><strong>Search hint:</strong> ' + escapeHtml(np.handoff.searchQuery) + '</p>';
    html += '<div class="handoff-actions-row">';
    html +=
      '<button type="button" class="handoff-action-btn primary" onclick="PSWHandoff.copyBet(' +
      pickIdx +
      ')">Copy bet</button>';
    html +=
      '<button type="button" class="handoff-action-btn" onclick="PSWHandoff.closeModal()">Close</button>';
    html += '</div><div class="handoff-book-grid">';
    show.forEach(function (adapter) {
      const clone = HandoffService.normalize(
        { player: np.player.name, teamAbbr: np.player.teamAbbr, oppTeamAbbr: np.player.opponentAbbr, game: { gameDate: np.event.startTimeIso } },
        { sport: np.sport, option: np.market.tabLabel },
      );
      const enriched = HandoffService.enrich(clone, adapter.id);
      const dest = enriched.handoff.destination;
      html +=
        '<button type="button" class="handoff-book-btn" onclick="PSWHandoff.openSportsbookForPick(' +
        pickIdx +
        ", '" +
        adapter.id +
        '\')">' +
        escapeHtml(adapter.shortName) +
        '<span class="handoff-book-sub">' +
        escapeHtml(dest ? HandoffService.destinationStatusLabel(dest) : 'Open') +
        '</span></button>';
    });
    html += '</div></div>';
    body.innerHTML = html;
    modal.style.display = 'flex';
  }

  function openChooser(idx) {
    global._handoffModalPickIdx = idx;
    renderChooserModal(idx);
  }

  function closeModal() {
    const modal = global.document.getElementById('handoffModal');
    if (modal) modal.style.display = 'none';
  }

  function onStateChange(code) {
    setUserState(code);
    if (global._handoffModalPickIdx != null) {
      renderChooserModal(global._handoffModalPickIdx);
    }
  }

  function sbButtonLabel() {
    const adapter = getAdapter(getPreferredBookId());
    return adapter ? 'SB: ' + adapter.shortName : 'Open book';
  }

  function handoffBarHtml(idx) {
    const sb = sbButtonLabel();
    const sbCls = getPreferredBookId() ? 'pick-handoff-btn pick-handoff-btn-sb is-set' : 'pick-handoff-btn pick-handoff-btn-sb';
    return (
      '<div class="pick-handoff-bar" role="group" aria-label="Sportsbook handoff">' +
      '<button type="button" class="pick-handoff-btn" onclick="event.stopPropagation();PSWHandoff.copyBet(' +
      idx +
      ')">Copy bet</button>' +
      '<button type="button" class="' +
      sbCls +
      '" onclick="event.stopPropagation();PSWHandoff.onOpenBookTap(' +
      idx +
      ')" title="First time: choose state and book. Then opens best link (prefilled when available).">' +
      escapeHtml(sb) +
      '</button>' +
      '<button type="button" class="pick-handoff-btn" onclick="event.stopPropagation();PSWHandoff.viewMatchingMarket(' +
      idx +
      ')">View market</button>' +
      '</div>'
    );
  }

  function refreshHandoffBars() {
    if (typeof global._injectPickHandoffBars === 'function') {
      global._injectPickHandoffBars();
      global._injectPickHandoffBars(global.document.getElementById('poCards'));
    }
  }

  global.PSWHandoff = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DESTINATION_ORDER: DESTINATION_ORDER,
    MARKET_TAXONOMY: MARKET_TAXONOMY,
    ADAPTERS: ADAPTERS,
    MarketMatcher: MarketMatcher,
    HandoffService: HandoffService,
    normalizePick: HandoffService.normalize,
    formatCopyText: HandoffService.formatCopyText,
    booksForState: booksForState,
    getUserState: getUserState,
    setUserState: setUserState,
    getPreferredBookId: getPreferredBookId,
    setPreferredBookId: setPreferredBookId,
    resolveDestination: HandoffService.resolveDestination,
    enrichHandoff: HandoffService.enrich,
    registerPickResolver: registerPickResolver,
    copyBet: copyBet,
    onOpenBookTap: onOpenBookTap,
    openSportsbookForPick: openSportsbookForPick,
    openChooser: openChooser,
    viewMatchingMarket: viewMatchingMarket,
    closeModal: closeModal,
    onStateChange: onStateChange,
    handoffBarHtml: handoffBarHtml,
    refreshHandoffBars: refreshHandoffBars,
    sbButtonLabel: sbButtonLabel,
  };
})(typeof window !== 'undefined' ? window : globalThis);
