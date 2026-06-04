/**
 * Pro Sports Win — user-directed sportsbook handoff (MVP).
 * Copy text + open licensed sportsbook apps/sites. No auto-betting or credentials.
 */
(function (global) {
  'use strict';

  const STORAGE_STATE = 'psw_handoff_state';
  const STORAGE_BOOK = 'psw_handoff_book';

  const BOOKS = [
    {
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
      states: [
        'AZ', 'CO', 'CT', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'NH', 'NJ', 'NY', 'NC', 'OH',
        'OR', 'PA', 'TN', 'VT', 'VA', 'WV', 'WY', 'DC',
      ],
    },
    {
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
      states: [
        'AZ', 'CO', 'CT', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'MD', 'MA', 'MI', 'NJ', 'NY', 'NC', 'OH', 'PA', 'TN',
        'VT', 'VA', 'WV', 'WY', 'DC',
      ],
    },
    {
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
    },
    {
      id: 'caesars',
      name: 'Caesars Sportsbook',
      homeUrl: 'https://www.caesars.com/sportsbook-and-casino',
      leaguePaths: {},
      states: [
        'AZ', 'CO', 'DC', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'MD', 'MA', 'MI', 'NJ', 'NY', 'NC', 'OH', 'PA', 'TN',
        'VA', 'WV', 'WY',
      ],
    },
  ];

  const US_STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
    'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
    'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  ];

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
  }

  function getBook(id) {
    return BOOKS.find(function (b) {
      return b.id === id;
    });
  }

  function booksForState(stateCode) {
    const st = String(stateCode || '').toUpperCase();
    if (!st) return BOOKS.slice();
    return BOOKS.filter(function (b) {
      return b.states.indexOf(st) >= 0;
    });
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
      return (
        d.toLocaleString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }) + ''
      );
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

  function marketLabelFromContext(ctx, raw) {
    const sport = ctx.sport;
    const opt = ctx.option;
    if (sport === 'MLB' && opt === 'HR') return '1+ Home Run (player prop)';
    if (sport === 'MLB' && opt === 'Ks') {
      return (raw.dir || 'Over') + ' ' + (raw.kLine || '') + ' Strikeouts';
    }
    if (sport === 'MLB' && opt === 'Hits') {
      return (raw.dir || 'Over') + ' ' + (raw.line || '') + ' Hits';
    }
    if (sport === 'MLB' && opt === 'Total Bases') {
      return (raw.dir || 'Over') + ' ' + (raw.line || '') + ' Total Bases';
    }
    if (sport === 'MLB' && opt === 'RBI') {
      return (raw.dir || 'Over') + ' ' + (raw.line || '') + ' RBI';
    }
    if (sport === 'NFL' && opt === 'TDs') return 'Anytime TD / TD scorer';
    if (raw.dir && raw.line != null && raw.line !== '') {
      return (raw.dir || 'Over') + ' ' + raw.line + ' ' + (raw.statLabel || opt);
    }
    return String(raw.statLabel || opt || 'Player prop');
  }

  function lineDisplayFromContext(ctx, raw) {
    const sport = ctx.sport;
    const opt = ctx.option;
    if (sport === 'MLB' && opt === 'HR') return '1+ HR';
    if (sport === 'MLB' && opt === 'Ks') return (raw.dir || 'Over') + ' ' + (raw.kLine || '') + ' K';
    if (raw.dir && raw.line != null) return raw.dir + ' ' + raw.line;
    if (sport === 'NFL' && opt === 'TDs' && raw.td != null) return String(raw.td) + ' TD (season context)';
    return raw.statLabel || opt || '';
  }

  /**
   * @param {object} raw - in-app pick row
   * @param {{ sport: string, option: string, index?: number }} ctx
   */
  function normalizePick(raw, ctx) {
    if (!raw || !ctx) return null;
    const g = raw.game || null;
    const eventId = String(
      raw.gamePk || (g && (g.gamePk || g.id)) || raw.espnId || '',
    ).trim();
    const marketLabel = marketLabelFromContext(ctx, raw);
    const lineDisplay = lineDisplayFromContext(ctx, raw);
    const startDisplay = formatGameTime(g);
    const book = getBook(getPreferredBookId());
    const np = {
      schemaVersion: 1,
      sport: ctx.sport,
      market: ctx.option,
      player: {
        name: String(raw.player || '').trim(),
        teamAbbr: raw.teamAbbr || raw.team || '',
        opponentAbbr: raw.oppTeamAbbr || '',
        position: raw.pos || '',
        espnId: raw.espnId != null ? String(raw.espnId) : '',
        mlbPlayerId: raw.playerId != null ? String(raw.playerId) : '',
      },
      event: {
        label: eventLabelFromPick(raw),
        startTimeIso: g && g.gameDate ? String(g.gameDate) : '',
        startTimeDisplay: startDisplay,
        venue: (g && g.venue && g.venue.name) || '',
        status: (g && g.status && (g.status.detailedState || g.status.abstractGameState)) || '',
        eventId: eventId,
      },
      selection: {
        side: raw.dir || '',
        line: raw.line != null ? raw.line : raw.kLine != null ? raw.kLine : raw.hr,
        lineDisplay: lineDisplay,
        statLabel: raw.statLabel || ctx.option,
      },
      odds: {
        american: null,
        decimal: null,
        display: 'See live odds in your sportsbook',
      },
      sportsbook: book ? { id: book.id, name: book.name } : null,
      state: getUserState(),
      handoff: {
        copyText: '',
        searchQuery: '',
        deepLinkKind: 'copy_only',
        deepLinkUrl: '',
        deepLinkLabel: '',
      },
    };
    np.handoff.searchQuery = [
      np.player.name,
      np.market,
      np.sport,
      np.event.label,
    ]
      .filter(Boolean)
      .join(' ');
    return np;
  }

  function formatCopyText(np, bookOverride) {
    if (!np) return '';
    const bookName =
      (bookOverride && bookOverride.name) ||
      (np.sportsbook && np.sportsbook.name) ||
      'your sportsbook';
    const parts = [
      np.sport + ' — ' + np.player.name,
      np.selection.lineDisplay || np.market,
      np.event.label,
    ];
    if (np.event.startTimeDisplay) parts.push('game ' + np.event.startTimeDisplay);
    parts.push('odds: ' + (np.odds.display || 'check book'));
    parts.push('book: ' + bookName);
    parts.push('Entertainment pick — verify market & line in ' + bookName + '. Not affiliated.');
    return parts.filter(Boolean).join(' · ');
  }

  function resolveDeepLink(np, book) {
    if (!book) {
      return {
        kind: 'copy_only',
        url: '',
        label: 'Choose a sportsbook',
      };
    }
    const base = book.homeUrl.replace(/\/?$/, '/');
    const path = book.leaguePaths && book.leaguePaths[np.sport];
    if (path) {
      return {
        kind: 'league',
        url: base + path.replace(/^\//, ''),
        label: 'Open ' + np.sport + ' on ' + book.name,
      };
    }
    return {
      kind: 'home',
      url: book.homeUrl,
      label: 'Open ' + book.name,
    };
  }

  function enrichHandoff(np, book) {
    const link = resolveDeepLink(np, book);
    np.sportsbook = book ? { id: book.id, name: book.name } : null;
    np.handoff.copyText = formatCopyText(np, book);
    np.handoff.deepLinkKind = link.kind;
    np.handoff.deepLinkUrl = link.url;
    np.handoff.deepLinkLabel = link.label;
    return np;
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
    if (typeof global.trackEvent === 'function') {
      global.trackEvent(name, params || {});
    }
  }

  function leaveDisclaimer(bookName) {
    return (
      'You are leaving Pro Sports Win for ' +
      bookName +
      '. Place any wager only in their licensed app. 21+ where legal. Entertainment only.'
    );
  }

  function openUrl(url, bookName) {
    if (!url) {
      showToast('No link for this book — copy the bet and search in the app.', 'error');
      return;
    }
    if (!global.confirm(leaveDisclaimer(bookName))) return;
    global.open(url, '_blank', 'noopener,noreferrer');
  }

  let _resolver = null;

  function registerPickResolver(fn) {
    _resolver = fn;
  }

  function resolvePickAtIndex(idx) {
    if (typeof _resolver !== 'function') return null;
    const resolved = _resolver(idx);
    if (!resolved || !resolved.raw) return null;
    const np = normalizePick(resolved.raw, resolved.ctx);
    if (!np) return null;
  const book = getBook(getPreferredBookId()) || null;
    return enrichHandoff(np, book);
  }

  function copyBet(idx) {
    const np = resolvePickAtIndex(idx);
    if (!np) {
      showToast('No pick to copy.', 'error');
      return;
    }
    const book = getBook(getPreferredBookId());
    if (book) enrichHandoff(np, book);
    np.handoff.copyText = formatCopyText(np, book);
    copyTextRobust(np.handoff.copyText).then(function () {
      showToast('Bet copied — paste in your sportsbook.', 'success');
      trackHandoff('handoff_copy_bet', {
        sport: np.sport,
        market: np.market,
        book: (book && book.id) || '',
      });
    });
  }

  function openSportsbookForPick(idx, bookId) {
    const np = resolvePickAtIndex(idx);
    if (!np) {
      showToast('No pick loaded.', 'error');
      return;
    }
    const book = getBook(bookId || getPreferredBookId());
    if (!book) {
      openChooser(idx);
      return;
    }
    setPreferredBookId(book.id);
    enrichHandoff(np, book);
    trackHandoff('handoff_open_book', {
      sport: np.sport,
      market: np.market,
      book: book.id,
      link_kind: np.handoff.deepLinkKind,
    });
    openUrl(np.handoff.deepLinkUrl, book.name);
  }

  function viewMatchingMarket(idx) {
    global._handoffModalPickIdx = idx;
    const np = resolvePickAtIndex(idx);
    if (!np) {
      showToast('No pick loaded.', 'error');
      return;
    }
    const book = getBook(getPreferredBookId());
    enrichHandoff(np, book);
    trackHandoff('handoff_view_market', { sport: np.sport, market: np.market });
    renderMarketModal(np);
  }

  function renderChooserModal(idx) {
    const modal = global.document.getElementById('handoffModal');
    const body = global.document.getElementById('handoffModalBody');
    const title = global.document.getElementById('handoffModalTitle');
    if (!modal || !body || !title) return;
    const st = getUserState();
    const list = booksForState(st);
    title.textContent = 'Open sportsbook';
    let html =
      '<p class="handoff-modal-lead">Pick a licensed sportsbook. We open the event or league when supported; otherwise copy the bet and find the market yourself.</p>';
    html +=
      '<label class="handoff-state-label">Your state (for book list)<select id="handoffStateSelect" class="handoff-state-select" onchange="PSWHandoff.onStateChange(this.value)">';
    html += '<option value="">Select state…</option>';
    US_STATES.forEach(function (code) {
      html +=
        '<option value="' +
        code +
        '"' +
        (code === st ? ' selected' : '') +
        '>' +
        code +
        '</option>';
    });
    html += '</select></label>';
    if (st && !list.length) {
      html +=
        '<p class="handoff-modal-warn">No mapped books for ' +
        escapeHtml(st) +
        ' in this MVP list. You can still copy the bet or open a book manually where legal.</p>';
    }
    html += '<div class="handoff-book-grid">';
    const show = list.length ? list : BOOKS;
    show.forEach(function (book) {
      html +=
        '<button type="button" class="handoff-book-btn" onclick="PSWHandoff.openSportsbookForPick(' +
        idx +
        ", '" +
        book.id +
        '\')">' +
        escapeHtml(book.name) +
        '<span class="handoff-book-sub">' +
        escapeHtml(
          (book.leaguePaths && book.leaguePaths[(resolvePickAtIndex(idx) || {}).sport])
            ? 'Open league'
            : 'Open app',
        ) +
        '</span></button>';
    });
    html += '</div>';
    html +=
      '<button type="button" class="handoff-copy-all-btn" onclick="PSWHandoff.copyBet(' +
      idx +
      ')">Copy bet first</button>';
    body.innerHTML = html;
    modal.style.display = 'flex';
  }

  function renderMarketModal(np) {
    const modal = global.document.getElementById('handoffModal');
    const body = global.document.getElementById('handoffModalBody');
    const title = global.document.getElementById('handoffModalTitle');
    if (!modal || !body || !title) return;
    title.textContent = 'Matching market';
    const st = getUserState();
    const list = booksForState(st);
    const show = list.length ? list : BOOKS;
    let html = '<div class="handoff-market-card">';
    html += '<div class="handoff-market-title">' + escapeHtml(np.selection.lineDisplay) + '</div>';
    html +=
      '<div class="handoff-market-meta">' +
      escapeHtml(np.player.name) +
      ' · ' +
      escapeHtml(np.event.label) +
      '</div>';
    if (np.event.startTimeDisplay) {
      html += '<div class="handoff-market-meta">' + escapeHtml(np.event.startTimeDisplay) + '</div>';
    }
    html +=
      '<pre class="handoff-copy-block">' + escapeHtml(np.handoff.copyText) + '</pre>';
    html +=
      '<p class="handoff-modal-lead">Search hint: <strong>' +
      escapeHtml(np.handoff.searchQuery) +
      '</strong></p>';
    html += '<div class="handoff-actions-row">';
    const pickIdx = global._handoffModalPickIdx != null ? global._handoffModalPickIdx : 0;
    html +=
      '<button type="button" class="handoff-action-btn primary" onclick="PSWHandoff.copyBet(' +
      pickIdx +
      ')">Copy bet</button>';
    html +=
      '<button type="button" class="handoff-action-btn" onclick="PSWHandoff.closeModal()">Close</button>';
    html += '</div>';
    html += '<div class="handoff-book-grid">';
    show.forEach(function (book) {
      const tmp = enrichHandoff(JSON.parse(JSON.stringify(np)), book);
      html +=
        '<button type="button" class="handoff-book-btn" onclick="PSWHandoff.openSportsbookForPick(' +
        pickIdx +
        ", '" +
        book.id +
        '\')">' +
        escapeHtml(book.name) +
        '<span class="handoff-book-sub">' +
        escapeHtml(tmp.handoff.deepLinkLabel) +
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

  function handoffBarHtml(idx) {
    return (
      '<div class="pick-handoff-bar" role="group" aria-label="Sportsbook handoff">' +
      '<button type="button" class="pick-handoff-btn" onclick="event.stopPropagation();PSWHandoff.copyBet(' +
      idx +
      ')">Copy bet</button>' +
      '<button type="button" class="pick-handoff-btn" onclick="event.stopPropagation();PSWHandoff.openChooser(' +
      idx +
      ')">Open book</button>' +
      '<button type="button" class="pick-handoff-btn" onclick="event.stopPropagation();PSWHandoff.viewMatchingMarket(' +
      idx +
      ')">View market</button>' +
      '</div>'
    );
  }

  global.PSWHandoff = {
    SCHEMA_VERSION: 1,
    BOOKS: BOOKS,
    normalizePick: normalizePick,
    formatCopyText: formatCopyText,
    booksForState: booksForState,
    getUserState: getUserState,
    setUserState: setUserState,
    resolveDeepLink: resolveDeepLink,
    enrichHandoff: enrichHandoff,
    registerPickResolver: registerPickResolver,
    copyBet: copyBet,
    openSportsbookForPick: openSportsbookForPick,
    openChooser: openChooser,
    viewMatchingMarket: viewMatchingMarket,
    closeModal: closeModal,
    onStateChange: onStateChange,
    handoffBarHtml: handoffBarHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
