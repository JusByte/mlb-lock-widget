// =====================
// USER CONFIG
// =====================
const TEAM_ID = 141;                    // change this, see ABBR_BY_ID below (e.g., 147 for Yankees)

// =====================
// INTERNAL CONFIG
// =====================
const LOOKAROUND_DAYS = 12;             // Default 12
const REFRESH_LIVE_MIN = 0;             // Default 0. Note iOS/iPadOS will still limit how often the widget can refresh
const REFRESH_IDLE_MIN = 30;            // Default 30. Avoids refreshing when there isn't a game
const FORCE_TIMEZONE = null;            // Set to null to use device timezone, otherwise enter a timezone (i.e., America/Toronto)

const ABBR_BY_ID = {
  108: "LAA", 109: "ARI", 110: "BAL", 111: "BOS", 112: "CHC", 113: "CIN",
  114: "CLE", 115: "COL", 116: "DET", 117: "HOU", 118: "KC", 119: "LAD",
  120: "WSH", 121: "NYM", 133: "OAK", 134: "PIT", 135: "SD", 136: "SEA",
  137: "SF", 138: "STL", 139: "TB", 140: "TEX", 141: "TOR", 142: "MIN",
  143: "PHI", 144: "ATL", 145: "CWS", 146: "MIA", 147: "NYY", 158: "MIL"
};

const TEAM_ABBR = ABBR_BY_ID[TEAM_ID] || "TEAM";

const fm = FileManager.local();
const cacheDir = fm.cacheDirectory();
const cachePath = fm.joinPath(cacheDir, "mlb_widget_schedule_cache.json");

function addDays(d, days) { const x = new Date(d.getTime()); x.setDate(x.getDate() + days); return x; }
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dfTime() {
  const df = new DateFormatter();
  df.useShortTimeStyle(); df.useNoDateStyle();
  if (FORCE_TIMEZONE) df.timeZone = FORCE_TIMEZONE;
  return df;
}
function dfDayName() {
  const df = new DateFormatter();
  df.dateFormat = "E";
  if (FORCE_TIMEZONE) df.timeZone = FORCE_TIMEZONE;
  return df;
}
function dfMonthDay() {
  const df = new DateFormatter();
  df.dateFormat = "M/d";
  if (FORCE_TIMEZONE) df.timeZone = FORCE_TIMEZONE;
  return df;
}

function timeLabel(now) { return dfTime().string(now).replace(":00", ""); }

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Top line wants date+time
function labelNextDateTime(gameDate, now) {
  const d = new Date(gameDate);
  const t = dfTime().string(d).replace(":00", "");
  const md = dfMonthDay().string(d);

  if (isSameDay(d, now)) return `Today ${md} ${t}`;
  return `${dfDayName().string(d)} ${md} ${t}`;
}

function abbr(teamObj) {
  if (!teamObj) return "???";
  return teamObj.abbreviation || ABBR_BY_ID[teamObj.id] ||
    (teamObj.name ? teamObj.name.slice(0, 3).toUpperCase() : "???");
}

function isFinalStatus(status) {
  const a = (status?.abstractGameState || "").toLowerCase();
  const d = (status?.detailedState || "").toLowerCase();
  return a === "final" || d === "final" || d === "game over" || d === "completed early";
}
function isLiveStatus(status) {
  const a = (status?.abstractGameState || "").toLowerCase();
  const d = (status?.detailedState || "").toLowerCase();
  return a === "live" || d.includes("in progress") || d.includes("review") || d.includes("delayed") || d.includes("suspended");
}

// ▲ for Top, ▼ for Bottom
function inningLabelFromLinescore(ls) {
  if (!ls) return "";
  const inn = ls.currentInning || null;
  const state = (ls.inningState || "").toLowerCase();
  const isTop = (typeof ls.isTopInning === "boolean") ? ls.isTopInning : null;

  if (!inn) return state ? state.toUpperCase() : "";
  if (state.startsWith("top") || isTop === true) return `▲${inn}`;
  if (state.startsWith("bottom") || isTop === false) return `▼${inn}`;
  if (state.startsWith("middle")) return `MID ${inn}`;
  if (state.startsWith("end")) return `END ${inn}`;
  return `${inn}`;
}

async function fetchJSON(url) {
  const req = new Request(url);
  req.headers = { "User-Agent": "Scriptable MLB Widget" };
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

async function loadSchedule(now) {
  const start = ymd(addDays(now, -LOOKAROUND_DAYS));
  const end = ymd(addDays(now, LOOKAROUND_DAYS));
  const url =
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${TEAM_ID}` +
    `&startDate=${start}&endDate=${end}&hydrate=linescore,team`;

  try {
    const data = await fetchJSON(url);
    fm.writeString(cachePath, JSON.stringify({ savedAt: Date.now(), data }));
    return data;
  } catch (e) {
    if (fm.fileExists(cachePath)) return JSON.parse(fm.readString(cachePath)).data;
    throw e;
  }
}

function flattenGames(scheduleData) {
  const games = [];
  for (const d of (scheduleData?.dates || [])) for (const g of (d.games || [])) games.push(g);
  games.sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
  return games;
}

function pickLastFinalAndNext(games, now) {
  const pastFinals = games.filter(g => new Date(g.gameDate) <= now && isFinalStatus(g.status));
  const futures = games.filter(g => new Date(g.gameDate) > now && !isFinalStatus(g.status));
  const startedNotLive = games.filter(
    g => new Date(g.gameDate) <= now && !isFinalStatus(g.status) && !isLiveStatus(g.status)
  );
  return {
    lastFinal: pastFinals.length ? pastFinals[pastFinals.length - 1] : null,
    nextGame: futures.length ? futures[0] : (startedNotLive.length ? startedNotLive[startedNotLive.length - 1] : null)
  };
}

async function loadLiveFeed(gamePk) {
  return await fetchJSON(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
}

// Always return home-first info
function extractFromScheduleGame(g) {
  const home = g.teams?.home?.team;
  const away = g.teams?.away?.team;

  return {
    gamePk: g.gamePk,
    homeAbbr: abbr(home),
    awayAbbr: abbr(away),
    homeScore: g.teams?.home?.score ?? 0,
    awayScore: g.teams?.away?.score ?? 0,
    status: g.status,
    gameDate: g.gameDate,
    linescore: g.linescore || null
  };
}

function extractFromLiveFeed(feed) {
  const gd = feed?.gameData;
  const ls = feed?.liveData?.linescore;

  const home = gd?.teams?.home;
  const away = gd?.teams?.away;

  const inning = inningLabelFromLinescore(ls);
  const outs = (typeof ls?.outs === "number") ? ls.outs : null;

  return {
    homeAbbr: abbr(home),
    awayAbbr: abbr(away),
    homeScore: ls?.teams?.home?.runs ?? 0,
    awayScore: ls?.teams?.away?.runs ?? 0,
    inning,
    outs
  };
}

function applyTextStyle(t, { size=12, bold=false, opacity=1, mono=false } = {}) {
  if (mono) {
    if (typeof Font.mediumMonospacedSystemFont === "function") t.font = Font.mediumMonospacedSystemFont(size);
    else if (typeof Font.monospacedSystemFont === "function") t.font = Font.monospacedSystemFont(size);
    else t.font = Font.systemFont(size);
  } else {
    t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  }
  t.textOpacity = opacity;
  return t;
}

function setWidgetURL(w, gamePk) { if (gamePk) w.url = `https://www.mlb.com/gameday/${gamePk}`; }

function buildRectangular(w, model) {
  const top = w.addStack();
  top.layoutHorizontally();

  const left = top.addText(model.topLeft || "");
  applyTextStyle(left, { size: 12, bold: true });

  top.addSpacer();

  const right = top.addText(model.topRight || "");
  applyTextStyle(right, { size: 12, bold: true, mono: true });

  w.addSpacer(2);

  const mid = w.addText(model.midLine || "");
  applyTextStyle(mid, { size: 14, bold: true, mono: true });

  w.addSpacer(2);

  const bottom = w.addText(model.bottomLine || "");
  applyTextStyle(bottom, { size: 11, opacity: 0.85 });
}

function buildInline(w, model) {
  const t = w.addText(model.inline || TEAM_ABBR);
  applyTextStyle(t, { size: 12, bold: true });
}

async function createModel() {
  const now = new Date();
  const schedule = await loadSchedule(now);
  const games = flattenGames(schedule);

  const liveGame = games.find(g => {
    const code = g.status?.codedGameState;
    const detailed = (g.status?.detailedState || "").toLowerCase();
  
    return (
      code === "I" &&
      !detailed.includes("pre-game") &&
      !detailed.includes("warmup")
    );
  });
  const { lastFinal, nextGame } = pickLastFinalAndNext(games, now);

  // LIVE
  if (liveGame) {
    const sched = extractFromScheduleGame(liveGame);
    let inning = inningLabelFromLinescore(sched.linescore);
    let outs = (typeof sched.linescore?.outs === "number") ? sched.linescore.outs : null;

    try {
      // If inning missing from schedule payload, fall back to live feed
      if (!inning) {
        const feed = await loadLiveFeed(liveGame.gamePk);
        const live = extractFromLiveFeed(feed);

        inning = live.inning || inning;
        outs = (live.outs ?? outs);

        sched.homeAbbr = live.homeAbbr || sched.homeAbbr;
        sched.awayAbbr = live.awayAbbr || sched.awayAbbr;
        sched.homeScore = live.homeScore ?? sched.homeScore;
        sched.awayScore = live.awayScore ?? sched.awayScore;
      }
    } catch (_) {}

    const refreshed = timeLabel(now);
    const topLeft = `${sched.homeAbbr} vs ${sched.awayAbbr}`;
    const topRight = inning || "LIVE";
    const midLine = `${sched.homeAbbr} ${sched.homeScore}  –  ${sched.awayScore} ${sched.awayAbbr}`;
    const bottomLine =
      outs === null
        ? `${refreshed}`
        : `${outs} out${outs === 1 ? "" : "s"} • ${refreshed}`;

    return {
      mode: "live",
      gamePk: liveGame.gamePk,
      topLeft, topRight, midLine, bottomLine,
      inline: `${sched.homeAbbr} ${sched.homeScore}-${sched.awayScore} ${topRight}`
    };
  }

  // IDLE (not live)
  const nextInfo = nextGame ? extractFromScheduleGame(nextGame) : null;
  const lastInfo = lastFinal ? extractFromScheduleGame(lastFinal) : null;

  const topLeft = nextInfo ? labelNextDateTime(nextInfo.gameDate, now) : "No upcoming";
  const topRight = ""; // keep top line as just date/time

  const midLine = nextInfo
    ? `${nextInfo.homeAbbr} 0  –  0 ${nextInfo.awayAbbr}`
    : `${TEAM_ABBR} —`;

  const bottomLine = lastInfo
    ? `Prev: ${lastInfo.homeAbbr} ${lastInfo.homeScore}-${lastInfo.awayScore} ${lastInfo.awayAbbr}`
    : "Prev: —";

  const inline = nextInfo
    ? `${topLeft} • ${nextInfo.homeAbbr} 0-0 ${nextInfo.awayAbbr}`
    : `${TEAM_ABBR} • Off`;

  return {
    mode: "idle",
    gamePk: nextInfo ? nextInfo.gamePk : (lastInfo ? lastInfo.gamePk : null),
    nextGameDate: nextInfo ? nextInfo.gameDate : null,
    topLeft, topRight, midLine, bottomLine, inline
  };
}

async function buildWidget() {
  const w = new ListWidget();
  w.setPadding(8, 10, 8, 10);

  let model;
  try {
    model = await createModel();
  } catch (e) {
    const t1 = w.addText(TEAM_ABBR);
    applyTextStyle(t1, { size: 12, bold: true });
    const t2 = w.addText("No connection");
    applyTextStyle(t2, { size: 12, opacity: 0.85 });
    w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
    return w;
  }

  setWidgetURL(w, model.gamePk);

  const fam = config.widgetFamily || "accessoryRectangular";

  if (fam === "accessoryInline") buildInline(w, model);
  else if (fam === "accessoryRectangular") buildRectangular(w, model);
  else {
    const t = w.addText("Use Rect/Inline");
    applyTextStyle(t, { size: 12, bold: true });
  }

  const nowMs = Date.now();
  const liveRefreshAt = nowMs + REFRESH_LIVE_MIN * 60 * 1000;
  const idleRefreshAt = nowMs + REFRESH_IDLE_MIN * 60 * 1000;
  const nextGameStartAt = model.mode === "idle" && model.nextGameDate
    ? new Date(model.nextGameDate).getTime()
    : null;

  const refreshAt = model.mode === "live"
    ? liveRefreshAt
    : Math.min(idleRefreshAt, Math.max(nowMs, nextGameStartAt ?? idleRefreshAt));

  w.refreshAfterDate = new Date(refreshAt);
  return w;
}

// --- run ---
const widget = await buildWidget();

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentAccessoryRectangular();
}

Script.complete();
