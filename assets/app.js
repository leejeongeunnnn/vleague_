/* V-리그 남자부 정적 대시보드 — data/*.json 을 읽어 8개 탭을 렌더링 */

const DATA = {};
const FILES = ["meta", "teams", "schedule", "standings", "players", "news", "events", "last_season"];

/* ---------- 마이팀 (보는 사람 브라우저에 저장) ---------- */
const MYTEAM_KEY = "vleague_myteam";
let MY_TEAM = null;
function loadMyTeam() { try { MY_TEAM = localStorage.getItem(MYTEAM_KEY) || null; } catch (e) { MY_TEAM = null; } }
function saveMyTeam(name) {
  MY_TEAM = name || null;
  try { name ? localStorage.setItem(MYTEAM_KEY, name) : localStorage.removeItem(MYTEAM_KEY); } catch (e) { /* 이번 방문 동안만 유지 */ }
}
const isMine = (name) => !!MY_TEAM && name === MY_TEAM;

/* 어두운 구단색은 어두운 배경에서 안 보이므로 밝게 보정 */
function readable(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return "#94a3b8";
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= 0.35) return hex;
  const mix = (c) => Math.round(c + (255 - c) * 0.45);
  return `#${[mix(r), mix(g), mix(b)].map(x => x.toString(16).padStart(2, "0")).join("")}`;
}

async function loadAll() {
  await Promise.all(FILES.map(async (f) => {
    try {
      const res = await fetch(`data/${f}.json?t=${Date.now()}`, { cache: "no-store" });
      DATA[f] = res.ok ? await res.json() : null;
    } catch (e) { DATA[f] = null; }
  }));
  await loadLive();
}

/* ---------- 실시간 점수 (live 브랜치의 live.json) ----------
   경기 중엔 Actions가 1분마다 live 브랜치에 live.json 을 올린다.
   GitHub Pages 를 다시 빌드하지 않으므로 빠르다. API 한도(시간당 60회)를 넘으면 raw 주소로 대체. */
const FALLBACK_REPO = "leejeongeunnnn/vleague_";
function repoSlug() {
  const h = location.hostname;
  if (h.endsWith(".github.io")) {
    const repo = location.pathname.split("/").filter(Boolean)[0];
    if (repo) return `${h.split(".")[0]}/${repo}`;
  }
  return FALLBACK_REPO;
}
async function fetchLive() {
  const slug = repoSlug();
  const tries = [
    () => fetch(`https://api.github.com/repos/${slug}/contents/live.json?ref=live`, { cache: "no-store", headers: { Accept: "application/vnd.github.raw+json" } }),
    () => fetch(`https://raw.githubusercontent.com/${slug}/live/live.json?t=${Date.now()}`, { cache: "no-store" }),
  ];
  for (const t of tries) {
    try { const r = await t(); if (r.ok) return await r.json(); } catch (e) { /* 다음 방법 */ }
  }
  return null;
}
async function loadLive() {
  const L = await fetchLive();
  DATA.live = L;
  if (!L || L.date !== todayStr() || !Array.isArray(L.games) || !DATA.schedule) return;
  const games = (DATA.schedule.games || []).slice();
  const idx = Object.fromEntries(games.map((g, i) => [g.gid, i]));
  L.games.forEach(g => {
    if (g.gid in idx) {
      const old = games[idx[g.gid]];
      games[idx[g.gid]] = { ...old, ...g, sets: g.sets || old.sets };
    } else games.push(g);
  });
  DATA.schedule = { ...DATA.schedule, games };
}

/* ---------- 유틸 ---------- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const emptyBox = (msg) => `<div class="empty">${esc(msg)}</div>`;
const WD = ["일", "월", "화", "수", "목", "금", "토"];
function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function dateLabel(d) {
  const dt = new Date(d + "T00:00:00+09:00");
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WD[dt.getDay()]})`;
}
function daysBetween(a, b) { return Math.round((new Date(b + "T00:00:00+09:00") - new Date(a + "T00:00:00+09:00")) / 86400000); }
const fmt3 = (v) => (v == null || v === "" || !isFinite(v)) ? "-" : Number(v).toFixed(3);

let TEAM = {};
function buildTeamMap() {
  TEAM = {};
  ((DATA.teams && DATA.teams.teams) || []).forEach(t => { TEAM[t.name] = t; });
}
const colorOf = (name) => readable((TEAM[name] || {}).color || "#64748b");
const dot = (name) => `<span class="dot" style="background:${colorOf(name)}"></span>`;

function allGames() {
  const g = (DATA.schedule && DATA.schedule.games) || [];
  return g.slice().sort((a, b) => (a.date + (a.time || "99")).localeCompare(b.date + (b.time || "99")));
}
const KIND_LABEL = { regular: "정규리그", cup: "컵대회", ps: "봄배구", allstar: "올스타전" };

/* ---------- 순위 계산 (결과에서 직접 집계) ----------
   수집기가 공식 순위를 못 가져와도 경기 결과만 있으면 순위표를 만든다.
   승점: 3-0/3-1 승 3점, 3-2 승 2점, 2-3 패 1점 */
function computeTable(games, teams) {
  const T = {};
  teams.forEach(n => { T[n] = { team: n, games: 0, w: 0, l: 0, pts: 0, sw: 0, sl: 0, pw: 0, pl: 0, hasPts: true, form: [] }; });
  games.filter(g => g.state === "final" && g.sh != null && g.sa != null).forEach(g => {
    const sh = +g.sh, sa = +g.sa;
    [[g.home, sh, sa, 0], [g.away, sa, sh, 1]].forEach(([n, my, op, side]) => {
      const r = T[n]; if (!r) return;
      r.games++; r.sw += my; r.sl += op;
      const win = my > op;
      if (win) { r.w++; r.pts += op <= 1 ? 3 : 2; } else { r.l++; r.pts += my === 2 ? 1 : 0; }
      r.form.push(win ? "W" : "L");
      if (Array.isArray(g.sets) && g.sets.length) {
        g.sets.forEach(s => { r.pw += +s[side]; r.pl += +s[1 - side]; });
      } else r.hasPts = false;
    });
  });
  const rows = Object.values(T).map(r => ({
    ...r,
    set_ratio: r.sl ? r.sw / r.sl : (r.sw ? Infinity : null),
    pt_ratio: (r.hasPts && r.pl) ? r.pw / r.pl : null,
  }));
  // V-리그 순위 기준: 승점 → 승수 → 세트득실률 → 점수득실률
  rows.sort((a, b) => b.pts - a.pts || b.w - a.w || (b.set_ratio || 0) - (a.set_ratio || 0) || (b.pt_ratio || 0) - (a.pt_ratio || 0));
  rows.forEach((r, i) => r.rank = i + 1);
  return rows;
}
function seasonTable() {
  const official = DATA.standings && DATA.standings.rows && DATA.standings.rows.length ? DATA.standings.rows : null;
  const reg = allGames().filter(g => g.kind === "regular");
  const computed = computeTable(reg, Object.keys(TEAM));
  if (official) {
    // 공식 순위에 최근 5경기 흐름만 덧붙임
    const formOf = Object.fromEntries(computed.map(r => [r.team, r.form]));
    return { rows: official.map(r => ({ ...r, form: formOf[r.team] || [] })), source: DATA.standings.source || "공식 순위" };
  }
  if (reg.some(g => g.state === "final")) return { rows: computed, source: "경기 결과로 자동 집계" };
  return null;
}

/* ---------- 경기 카드 ---------- */
function gameCard(g, opts = {}) {
  const live = g.state === "live";
  const fin = g.state === "final";
  const showScore = (fin || live) && g.sh != null && g.sa != null;
  let hw = "", aw = "";
  if (fin) { if (+g.sh > +g.sa) hw = "winner"; else if (+g.sa > +g.sh) aw = "winner"; }
  const sc = (v) => showScore ? esc(v) : "-";
  const mine = isMine(g.home) || isMine(g.away);
  const neutral = g.neutral || g.kind === "cup" || g.kind === "allstar";
  const tag = [KIND_LABEL[g.kind] && g.kind !== "regular" ? KIND_LABEL[g.kind] : "", g.series || ""].filter(Boolean);
  const uniq = [...new Set(tag)].filter((t, i, a) => !(i === 0 && a[1] && a[1].includes(t)));
  let sets = "";
  if (Array.isArray(g.sets) && g.sets.length) {
    sets = `<div class="set-line">${g.sets.map((s, i) =>
      `<span title="${i + 1}세트" class="${live && i === g.sets.length - 1 ? "cur" : ""}"><b class="${+s[1] > +s[0] ? "w" : ""}">${esc(s[1])}</b><i>:</i><b class="${+s[0] > +s[1] ? "w" : ""}">${esc(s[0])}</b></span>`).join("")}</div>`;
  }
  const status = live ? (g.status || "경기 중") : fin ? (g.status || "경기 종료") : g.state === "cancel" ? (g.status || "취소") : (g.time ? `${g.time} 시작` : "시간 미정");
  return `<div class="game ${live ? "is-live" : ""} ${mine ? "is-mine" : ""}">
    ${(uniq.length || live || mine || opts.showDate) ? `<div class="series">${mine ? '<span class="mine-star">⭐</span> ' : ""}${live ? '<span class="live-pill">LIVE</span> ' : ""}${opts.showDate ? `<span class="g-date">${esc(dateLabel(g.date))}</span> ` : ""}${esc(uniq.join(" · "))}</div>` : ""}
    <div class="game-row">
      <span class="game-team">${dot(g.away)}${esc(g.away)}</span>
      <span class="game-score ${aw}">${sc(g.sa)}</span>
    </div>
    <div class="game-row">
      <span class="game-team">${dot(g.home)}${esc(g.home)} ${neutral ? "" : '<span class="home-tag">홈</span>'}</span>
      <span class="game-score ${hw}">${sc(g.sh)}</span>
    </div>
    ${sets}
    <div class="game-meta">
      <span>${esc(g.venue || "")}</span>
      <span class="${live ? "status-live" : ""}">${esc(status)}</span>
    </div>
  </div>`;
}

/* ---------- 1. 경기 일정 ---------- */
let SCHED_FILTER = "all";
let SCHED_ALL = false;
function renderSchedule() {
  const p = document.getElementById("panel-schedule");
  const today = todayStr();
  const ev = DATA.events || {};
  let games = allGames();
  if (SCHED_FILTER !== "all") games = games.filter(g => g.kind === SCHED_FILTER);
  if (!SCHED_ALL) games = games.filter(g => { const d = daysBetween(today, g.date); return d >= -10 && d <= 14; });

  let html = `<h2 class="section-title">🔥 경기 일정 &amp; 결과</h2>`;

  // 개막 카운트다운
  const start = ev.regular && ev.regular.start;
  if (start && today < start) {
    const dd = daysBetween(today, start);
    html += `<div class="countdown card"><div class="cd-num">D-${dd}</div><div><div class="cd-title">2026-27 V-리그 정규시즌 개막</div>
      <div class="hint" style="margin:2px 0 0">10월 31일(토) 오후 2시 · 인천 계양체육관 · 대한항공 vs 현대캐피탈 (지난 시즌 챔프전 리매치)</div></div></div>`;
  }

  const liveN = allGames().filter(g => g.date === today && g.state === "live").length;
  const todayN = allGames().filter(g => g.date === today).length;
  if (todayN) {
    html += `<div class="live-banner ${liveN ? "on" : ""}">${liveN ? '<span class="live-dot"></span> 지금 ' + liveN + "경기 진행 중" : "오늘 " + todayN + "경기"}
      <span class="lb-time">${DATA.live && DATA.live.date === today ? `실시간 ${esc(DATA.live.updated_at.slice(11, 16))} 기준` : `갱신 ${esc((DATA.meta || {}).updated_at_kst || "-")}`} · 경기 중엔 1~2분마다 자동 갱신</span></div>`;
  }

  html += `<div class="stage-tabs">${[["all", "전체"], ["regular", "정규리그"], ["cup", "컵대회"], ["ps", "봄배구"]].map(([k, l]) =>
    `<button class="stage-chip ${SCHED_FILTER === k ? "active" : ""}" data-sf="${k}">${l}</button>`).join("")}
    <button class="stage-chip ${SCHED_ALL ? "active" : ""}" data-sall="1">${SCHED_ALL ? "📅 전체 기간" : "📅 최근·다가오는 2주"}</button></div>`;

  if (DATA.schedule && DATA.schedule._seed) {
    html += `<p class="hint">ℹ️ 지금은 개막 전 기사로 채운 일부 일정만 있어요. 자동 수집이 처음 돌면 시즌 전체 일정으로 바뀝니다.</p>`;
  }

  if (!games.length) {
    html += emptyBox(SCHED_ALL ? "표시할 경기가 없습니다." : "앞뒤 2주 안에 경기가 없어요. '전체 기간'을 눌러 보세요.");
  } else {
    const byDate = {};
    games.forEach(g => (byDate[g.date] = byDate[g.date] || []).push(g));
    Object.keys(byDate).sort().forEach(d => {
      html += `<div class="day-group" ${d === today ? 'id="sched-today"' : ""}><div class="day-head">${esc(dateLabel(d))}${d === today ? '<span class="today-badge">오늘</span>' : ""}</div>
        <div class="game-grid">${byDate[d].map(g => gameCard(g)).join("")}</div></div>`;
    });
  }

  // 컵대회 대진 (날짜 확정 전 안내)
  if (ev.cup && (SCHED_FILTER === "all" || SCHED_FILTER === "cup") && today <= "2026-10-25") {
    html += `<div class="sched-sub">🏐 ${esc(ev.cup.name)}</div>
      <div class="card"><div class="hint" style="margin-bottom:8px">${esc(ev.cup.dates)} · ${esc(ev.cup.venue)} — 조별리그 대진 (날짜·시간은 자동 수집되면 위 일정에 표시)</div>
      ${["A", "B"].map(k => `<div class="cup-g"><b>${k}조</b> ${(ev.cup.matchups[k] || []).map(m => `<span class="mu">${esc(m[0])} <i>vs</i> ${esc(m[1])}</span>`).join("")}</div>`).join("")}
      <div class="hint" style="margin:8px 0 0">${esc(ev.cup.knockout)}</div></div>`;
  }
  p.innerHTML = html;
  p.querySelectorAll("[data-sf]").forEach(b => b.onclick = () => { SCHED_FILTER = b.dataset.sf; renderSchedule(); });
  p.querySelector("[data-sall]").onclick = () => { SCHED_ALL = !SCHED_ALL; renderSchedule(); };
}

/* ---------- 2. 순위 ---------- */
function formChips(form, n = 5) {
  return (form || []).slice(-n).map(f => `<span class="form-chip sm ${f}">${f === "W" ? "승" : "패"}</span>`).join("");
}
function rankTable(rows, opts = {}) {
  const hasRatio = rows.some(r => r.set_ratio != null);
  const hasPt = rows.some(r => r.pt_ratio != null);
  const hasForm = !opts.noForm && rows.some(r => r.form && r.form.length);
  return `<div class="league-card card"><table class="rank"><thead><tr>
    <th>순위</th><th style="text-align:left">팀</th><th>경기</th><th>승</th><th>패</th><th>승점</th>
    ${hasRatio ? "<th>세트<br>득실률</th>" : ""}${hasPt ? '<th class="opt">점수득실률</th>' : ""}${hasForm ? "<th>최근</th>" : ""}
  </tr></thead><tbody>${rows.map(r => `<tr class="${isMine(r.team) ? "mine-row" : ""} ${opts.cut && r.rank === 3 ? "cut" : ""}">
    <td class="num">${r.rank}</td><td class="team">${dot(r.team)} ${esc(r.team)}</td>
    <td class="num">${r.games}</td><td class="num">${r.w}</td><td class="num">${r.l}</td><td class="num"><b>${r.pts}</b></td>
    ${hasRatio ? `<td class="num">${r.set_ratio === Infinity ? "MAX" : fmt3(r.set_ratio)}</td>` : ""}${hasPt ? `<td class="num opt">${fmt3(r.pt_ratio)}</td>` : ""}
    ${hasForm ? `<td><span class="form-inline">${formChips(r.form)}</span></td>` : ""}
  </tr>`).join("")}</tbody></table>
  ${opts.foot ? `<div class="hint" style="margin:10px 0 0">${opts.foot}</div>` : ""}</div>`;
}
function renderStandings() {
  const p = document.getElementById("panel-standings");
  const ev = DATA.events || {};
  const cur = seasonTable();
  let html = `<h2 class="section-title">🏆 2026-27 남자부 순위</h2>`;
  if (cur) {
    html += rankTable(cur.rows, { cut: true, foot: `출처: ${esc(cur.source)} · ${esc(ev.points_rule || "")} · 3위까지 봄배구 (3·4위 승점 차 3점 이내면 준PO)` });
  } else {
    html += emptyBox("정규시즌이 10월 31일에 시작해요. 첫 경기가 끝나면 이 자리에 순위표가 나옵니다.");
  }
  const ls = DATA.last_season;
  if (ls) {
    html += `<div class="sched-sub">📜 지난 시즌 최종 순위 (${esc(ls.season)})</div>`;
    html += rankTable(ls.standings.map(r => ({ ...r })), { foot: "대한항공·현대캐피탈 승점 69 동률 → 다승으로 대한항공 1위" });
  }
  p.innerHTML = html;
}

/* ---------- 3. 봄배구 · 컵대회 ---------- */
let PS_TAB = "cup";
function renderSpring() {
  const p = document.getElementById("panel-spring");
  const ev = DATA.events || {};
  const ls = DATA.last_season || {};
  let html = `<h2 class="section-title">🌸 봄배구 &amp; 컵대회</h2>
    <div class="stage-tabs">${[["cup", "🏐 컵대회"], ["ps", "🌸 이번 시즌 봄배구"], ["last", "📜 지난 봄배구"]].map(([k, l]) =>
      `<button class="stage-chip ${PS_TAB === k ? "active" : ""}" data-ps="${k}">${l}</button>`).join("")}</div>`;

  if (PS_TAB === "cup" && ev.cup) {
    const cupGames = allGames().filter(g => g.kind === "cup");
    html += `<p class="hint">${esc(ev.cup.dates)} · ${esc(ev.cup.venue)}<br>${esc(ev.cup.new_rules)}</p>`;
    html += `<div class="standings-wrap">`;
    ["A", "B"].forEach(k => {
      const names = ev.cup.groups[k];
      const gg = cupGames.filter(g => names.includes(g.home) && names.includes(g.away));
      const rows = computeTable(gg, names);
      html += `<div><h3 class="team-league-title">${k}조</h3>${rankTable(rows, { noForm: true })}</div>`;
    });
    html += `</div><div class="card"><b>토너먼트</b><div class="hint" style="margin:6px 0 0">${esc(ev.cup.knockout)}</div></div>`;
    const ko = cupGames.filter(g => /준결승|결승|4강/.test(g.series || ""));
    if (ko.length) html += `<div class="game-grid">${ko.map(g => gameCard(g, { showDate: true })).join("")}</div>`;
    const grp = cupGames.filter(g => !ko.includes(g));
    if (grp.length) html += `<div class="sched-sub">조별리그 경기</div><div class="game-grid">${grp.map(g => gameCard(g, { showDate: true })).join("")}</div>`;
  }

  if (PS_TAB === "ps") {
    const ps = ev.postseason || {};
    const psGames = allGames().filter(g => g.kind === "ps");
    html += `<div class="card">${[["준플레이오프", ps.semi], ["플레이오프", ps.po], ["챔피언결정전", ps.final]].map(([n, s]) => s ? `
      <div class="ps-game" style="margin-bottom:10px"><div class="ps-badge">${n.replace("플레이오프", "PO").replace("챔피언결정전", "챔프전")}</div>
      <div class="ps-info"><div class="ps-match">${n}</div>${esc(s.start)} 시작 · ${esc(s.format)}${s.rule ? `<br><span class="ps-rules">${esc(s.rule)}</span>` : ""}</div></div>` : "").join("")}</div>`;
    const cur = seasonTable();
    if (cur) {
      const r = cur.rows;
      html += `<div class="card"><b>지금 순위대로라면</b><div class="ps-info" style="margin-top:6px">
        챔프전 직행: ${dot(r[0].team)}<b>${esc(r[0].team)}</b><br>
        플레이오프: ${dot(r[1].team)}${esc(r[1].team)} vs ${dot(r[2].team)}${esc(r[2].team)}
        ${r[3] && (r[2].pts - r[3].pts) <= 3 ? `<br>준PO 성립 (3·4위 ${r[2].pts - r[3].pts}점 차): ${esc(r[2].team)} vs ${esc(r[3].team)}` : ""}
      </div></div>`;
    }
    html += psGames.length ? `<div class="game-grid">${psGames.map(g => gameCard(g, { showDate: true })).join("")}</div>` : emptyBox("봄배구는 2027년 4월에 열립니다.");
  }

  if (PS_TAB === "last" && ls.postseason) {
    html += `<p class="hint">${esc(ls.title || "")}</p>`;
    ls.postseason.forEach(st => {
      html += `<div class="card"><div class="ps-match">${esc(st.stage)} <span class="hint">(${esc(st.format)})</span> → 🏅 ${dot(st.winner)}${esc(st.winner)}</div>
        ${st.series ? st.series.map(s => `<div class="ps-info">${esc(s.date)} · ${esc(s.away)} <b>${s.sa} : ${s.sh}</b> ${esc(s.home)} (홈)</div>`).join("") : ""}
        ${st.summary ? `<div class="ps-info">${esc(st.summary)}</div>` : ""}</div>`;
    });
  }
  p.innerHTML = html;
  p.querySelectorAll("[data-ps]").forEach(b => b.onclick = () => { PS_TAB = b.dataset.ps; renderSpring(); });
}

/* ---------- 4. 선수 기록 ---------- */
let PL_CAT = null;
let PL_SORT = null;
function renderPlayers() {
  const p = document.getElementById("panel-players");
  const pl = DATA.players || {};
  const cats = pl.categories || {};
  const keys = Object.keys(cats).filter(k => cats[k] && cats[k].rows && cats[k].rows.length);
  let html = `<h2 class="section-title">🏐 선수 기록</h2>`;
  if (keys.length) {
    if (!PL_CAT || !keys.includes(PL_CAT)) PL_CAT = keys[0];
    const c = cats[PL_CAT];
    const cols = c.columns || [];
    let rows = c.rows.slice();
    if (PL_SORT) rows.sort((a, b) => (parseFloat(b[PL_SORT]) || 0) - (parseFloat(a[PL_SORT]) || 0));
    html += `<div class="stage-tabs">${keys.map(k => `<button class="stage-chip ${k === PL_CAT ? "active" : ""}" data-pc="${esc(k)}">${esc(k)}</button>`).join("")}</div>
      <div class="card table-scroll"><table class="stats"><thead><tr><th>#</th><th style="text-align:left">선수</th><th style="text-align:left">팀</th>
      ${cols.map(col => `<th data-ps="${esc(col)}">${esc(col)}${PL_SORT === col ? " ▼" : ""}</th>`).join("")}</tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${isMine(r.team) ? "mine-row" : ""}"><td class="num">${i + 1}</td><td class="pname">${esc(r.name)}</td><td class="pteam">${dot(r.team)}${esc(r.team)}</td>
        ${cols.map(col => `<td class="num">${esc(r[col] == null ? "-" : r[col])}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div><p class="hint">출처: ${esc(pl.source || "-")} · 열 제목을 누르면 그 기준으로 정렬</p>`;
  } else {
    html += emptyBox("이번 시즌 개인 기록은 정규시즌 개막(10월 31일) 후 경기 결과가 쌓이면 표시됩니다.");
  }
  const ls = DATA.last_season;
  if (ls && ls.awards) {
    html += `<div class="sched-sub">🏅 지난 시즌 (${esc(ls.season)}) 시상</div><div class="card">${ls.awards.map(a =>
      `<div class="mt-pl ${isMine(a.team) ? "mine" : ""}"><span>${esc(a.award)}</span><span class="num"><b>${esc(a.name)}</b> · ${dot(a.team)}${esc(a.team)}</span></div>`).join("")}</div>`;
  }
  p.innerHTML = html;
  p.querySelectorAll("[data-pc]").forEach(b => b.onclick = () => { PL_CAT = b.dataset.pc; PL_SORT = null; renderPlayers(); });
  p.querySelectorAll("th[data-ps]").forEach(th => th.onclick = () => { PL_SORT = th.dataset.ps; renderPlayers(); });
}

/* ---------- 5. 경기장 ---------- */
let MAP = null;
function renderArenas() {
  const p = document.getElementById("panel-arenas");
  const arenas = (DATA.teams && DATA.teams.arenas) || [];
  p.innerHTML = `<h2 class="section-title">🏟️ 경기장 안내</h2><div id="map"></div>
    <div class="stadium-grid">${arenas.map(a => `<div class="card stadium-card" style="${a.team ? `border-top:4px solid ${colorOf(a.team)}` : ""}">
      <div class="sc-name">${esc(a.name)}</div>
      <div class="sc-team">${a.team ? `${dot(a.team)}${esc((TEAM[a.team] || {}).full || a.team)} 홈` : esc(a.note || "")}</div>
      <div class="sc-row">📍 ${esc(a.city)}</div>
      ${a.team === "KB손해보험" ? '<div class="sc-row">⚠️ 의정부체육관 재건축으로 이번 시즌 임시 홈</div>' : ""}
      <a href="https://map.naver.com/p/search/${encodeURIComponent(a.city.split(" ")[0] + " " + a.name)}" target="_blank" rel="noopener">네이버 지도에서 보기 ›</a>
    </div>`).join("")}</div>`;
  setTimeout(() => {
    if (typeof L === "undefined") return;
    if (MAP) { MAP.remove(); MAP = null; }
    MAP = L.map("map", { scrollWheelZoom: false }).setView([36.4, 127.6], 7);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles © Esri", maxZoom: 16 }).addTo(MAP);
    arenas.forEach(a => {
      const c = a.team ? colorOf(a.team) : "#94a3b8";
      L.circleMarker([a.lat, a.lng], { radius: isMine(a.team) ? 11 : 8, color: "#fff", weight: 1.5, fillColor: c, fillOpacity: .95 })
        .addTo(MAP).bindPopup(`<b>${esc(a.name)}</b><br>${esc(a.team || a.note || "")}`);
    });
  }, 30);
}

/* ---------- 6. 팀 소개 ---------- */
function teamCard(t) {
  return `<div class="card team-card" style="border-top-color:${colorOf(t.name)}">
    <div class="tc-head"><span class="tc-name">${esc(t.full)}</span><span class="tc-year">🏆 우승 ${t.titles}회</span></div>
    <div class="tc-jp">📍 ${esc(t.city)} · ${esc(t.arena)} &nbsp;|&nbsp; 지난 시즌: ${esc(t.last)}</div>
    <div class="tc-intro">${esc(t.intro)}</div>
    <div class="tc-foot">감독 <b>${esc(t.coach)}</b> · 외국인 <b>${esc(t.foreign || "-")}</b>${t.asia ? ` · 아시아쿼터 <b>${esc(t.asia)}</b>` : ""}</div>
  </div>`;
}
function renderTeams() {
  const p = document.getElementById("panel-teams");
  const ts = (DATA.teams && DATA.teams.teams) || [];
  p.innerHTML = `<h2 class="section-title">📣 팀 소개 (7개 구단)</h2><p class="hint">감독·외국인 선수는 2026-27 개막 전 기준. 우승 횟수는 V-리그 챔피언결정전 기준.</p>
    <div class="team-grid">${ts.map(teamCard).join("")}</div>`;
}

/* ---------- 7. 기사 ---------- */
let NEWS_MINE = false;
function newsList(items) {
  return items.map(n => `<div class="card news-card">
    <div class="news-top">${(n.teams || []).map(t => `<span class="news-cat" style="border:1px solid ${colorOf(t)}">${esc(t)}</span>`).join("")}</div>
    <div class="news-title"><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></div>
    <div class="news-meta"><span>${esc(n.source || "")}</span><span>${esc(n.time || "")}</span></div>
  </div>`).join("");
}
function renderNews() {
  const p = document.getElementById("panel-news");
  let items = (DATA.news && DATA.news.items) || [];
  if (NEWS_MINE && MY_TEAM) items = items.filter(n => (n.teams || []).includes(MY_TEAM));
  p.innerHTML = `<h2 class="section-title">📰 오늘 배구 기사</h2>
    ${MY_TEAM ? `<div class="stage-tabs"><button class="stage-chip ${!NEWS_MINE ? "active" : ""}" data-nm="0">전체</button><button class="stage-chip ${NEWS_MINE ? "active" : ""}" data-nm="1">⭐ ${esc(MY_TEAM)}</button></div>` : ""}
    ${items.length ? newsList(items) : emptyBox("아직 수집된 기사가 없어요. 자동 수집이 돌면 최근 이틀치 남자배구 기사가 모입니다.")}
    <p class="hint">출처: Google 뉴스 검색 (제목·링크만 표시, 본문은 각 언론사에서)</p>`;
  p.querySelectorAll("[data-nm]").forEach(b => b.onclick = () => { NEWS_MINE = b.dataset.nm === "1"; renderNews(); });
}

/* ---------- 0. 마이팀 ---------- */
function renderPicker() {
  const ts = (DATA.teams && DATA.teams.teams) || [];
  return `<p class="hint">응원하는 팀을 고르면 일정·순위·기사에서 그 팀이 강조돼요. (이 브라우저에만 저장)</p>
    <div class="pick-grid">${ts.map(t => `<button class="pick-team ${isMine(t.name) ? "active" : ""}" style="--tc:${colorOf(t.name)}" data-pick="${esc(t.name)}">${dot(t.name)} ${esc(t.full)}</button>`).join("")}</div>`;
}
function renderMyTeam() {
  const p = document.getElementById("panel-myteam");
  if (!MY_TEAM || !TEAM[MY_TEAM]) {
    p.innerHTML = `<h2 class="section-title">⭐ 마이팀 고르기</h2>${renderPicker()}`;
  } else {
    const t = TEAM[MY_TEAM];
    const today = todayStr();
    const games = allGames().filter(g => g.home === MY_TEAM || g.away === MY_TEAM);
    const next = games.filter(g => g.state !== "final" && g.state !== "cancel" && g.date >= today).slice(0, 3);
    const past = games.filter(g => g.state === "final").reverse();
    const cur = seasonTable();
    const me = cur ? cur.rows.find(r => r.team === MY_TEAM) : null;
    const last = (DATA.last_season && DATA.last_season.standings || []).find(r => r.team === MY_TEAM);
    const st = me || last;
    const stLabel = me ? "이번 시즌" : "지난 시즌 최종";
    let html = `<div class="mt-hero" style="--tc:${colorOf(MY_TEAM)}">
      <div class="mt-top"><div><div class="mt-league">V-리그 남자부 · ${esc(t.city)} ${esc(t.arena)}</div><div class="mt-name">${esc(t.full)}</div></div>
      <button class="btn-ghost" id="mt-change">팀 바꾸기</button></div>
      ${st ? `<div class="mt-stats"><div><b>${st.rank}위</b><span>${stLabel}</span></div><div><b>${st.w}승 ${st.l}패</b><span>${st.games}경기</span></div>
        <div><b>${st.pts}</b><span>승점</span></div><div><b>${t.titles}회</b><span>통산 우승</span></div></div>` : ""}
    </div>`;

    html += `<div class="sched-sub">📅 다음 경기</div>`;
    if (next.length) {
      html += next.map(g => {
        const dd = daysBetween(today, g.date);
        return `<div class="mt-next"><div class="mt-next-date">${dd === 0 ? "오늘" : "D-" + dd} · ${esc(dateLabel(g.date))}</div>${gameCard(g)}</div>`;
      }).join("");
    } else html += emptyBox("예정된 경기 정보가 아직 없어요.");

    if (past.length) {
      html += `<div class="sched-sub">🏐 최근 경기</div><div class="form-row">${past.slice(0, 10).reverse().map(g => {
        const mine = g.home === MY_TEAM ? +g.sh : +g.sa, op = g.home === MY_TEAM ? +g.sa : +g.sh;
        return `<span class="form-chip ${mine > op ? "W" : "L"}" title="${esc(g.date)}">${mine > op ? "승" : "패"}</span>`;
      }).join("")}</div>
      <div class="card"><table class="rank mt-results"><tbody>${past.slice(0, 8).map(g => {
        const home = g.home === MY_TEAM, opp = home ? g.away : g.home;
        const mine = home ? +g.sh : +g.sa, op = home ? +g.sa : +g.sh;
        return `<tr><td class="mt-date">${esc(g.date.slice(5).replace("-", "/"))}</td><td>${home ? "vs" : "@"} ${dot(opp)}${esc(opp)} <span class="hint">${esc(KIND_LABEL[g.kind] || "")}</span></td>
          <td class="num"><span class="form-chip sm ${mine > op ? "W" : "L"}">${mine > op ? "승" : "패"}</span> <b>${mine}:${op}</b></td></tr>`;
      }).join("")}</tbody></table></div>`;
    }

    // 상대 전적 (이번 시즌 결과 기준)
    const regPast = past.filter(g => g.kind === "regular");
    if (regPast.length) {
      const h2h = {};
      regPast.forEach(g => {
        const home = g.home === MY_TEAM, opp = home ? g.away : g.home;
        const win = (home ? +g.sh : +g.sa) > (home ? +g.sa : +g.sh);
        h2h[opp] = h2h[opp] || { w: 0, l: 0 }; win ? h2h[opp].w++ : h2h[opp].l++;
      });
      html += `<div class="sched-sub">⚔️ 상대 전적 (정규리그)</div><div class="card">${Object.entries(h2h).map(([o, r]) =>
        `<div class="bar-row"><span>${dot(o)}${esc(o)}</span><div class="bar"><i style="width:${(r.w / (r.w + r.l)) * 100}%"></i></div><b>${r.w}승 ${r.l}패</b></div>`).join("")}</div>`;
    }

    html += `<div class="sched-sub">📣 팀 정보</div>${teamCard(t)}`;
    const news = ((DATA.news && DATA.news.items) || []).filter(n => (n.teams || []).includes(MY_TEAM)).slice(0, 5);
    if (news.length) html += `<div class="sched-sub">📰 ${esc(MY_TEAM)} 기사</div>${newsList(news)}`;
    p.innerHTML = html;
    p.querySelector("#mt-change").onclick = () => { p.innerHTML = `<h2 class="section-title">⭐ 마이팀 바꾸기</h2>${renderPicker()}<button class="btn-ghost danger" id="mt-clear" style="margin-top:12px">마이팀 해제</button>`; bindPicker(p); p.querySelector("#mt-clear").onclick = () => { saveMyTeam(null); renderAll(); }; };
  }
  bindPicker(p);
}
function bindPicker(root) {
  root.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { saveMyTeam(b.dataset.pick); renderAll(); showTab("myteam"); });
}
function updateChip() {
  const c = document.getElementById("myteam-chip");
  c.textContent = MY_TEAM ? `⭐ ${MY_TEAM}` : "⭐ 마이팀 설정";
  if (MY_TEAM) document.documentElement.style.setProperty("--mine", colorOf(MY_TEAM));
  else document.documentElement.style.removeProperty("--mine");
}

/* ---------- 탭 · 전체 렌더 ---------- */
const RENDER = { myteam: renderMyTeam, schedule: renderSchedule, standings: renderStandings, spring: renderSpring, players: renderPlayers, arenas: renderArenas, teams: renderTeams, news: renderNews };
let CUR_TAB = "schedule";
function showTab(name) {
  CUR_TAB = name;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
  if (name === "arenas") renderArenas();
  try { history.replaceState(null, "", "#" + name); } catch (e) { }
}
function renderAll() {
  buildTeamMap();
  updateChip();
  Object.entries(RENDER).forEach(([k, fn]) => { if (k !== "arenas") { try { fn(); } catch (e) { console.error(k, e); document.getElementById("panel-" + k).innerHTML = emptyBox("이 탭을 그리다 오류가 났어요: " + e.message); } } });
  if (CUR_TAB === "arenas") renderArenas();
  const m = DATA.meta || {};
  document.getElementById("updated-at").textContent = `갱신: ${m.updated_at_kst || "—"}`;
}

/* 경기가 있는 날엔 화면을 띄워 둔 채로도 3분마다 새 데이터를 받아 온다 */
function scheduleRefresh() {
  setInterval(async () => {
    if (document.hidden) return;
    const today = todayStr();
    if (!allGames().some(g => g.date === today && g.state !== "final" && g.state !== "cancel")) return;
    await loadAll(); renderAll();
  }, 75 * 1000);
}

(async function init() {
  loadMyTeam();
  document.querySelectorAll(".tab").forEach(t => t.onclick = () => showTab(t.dataset.tab));
  document.getElementById("myteam-chip").onclick = () => showTab("myteam");
  await loadAll();
  renderAll();
  const h = (location.hash || "").slice(1);
  showTab(RENDER[h] ? h : (MY_TEAM ? "myteam" : "schedule"));
  document.getElementById("loader").classList.add("hide");
  scheduleRefresh();
})();
