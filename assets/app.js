/* V-리그 남자부 정적 대시보드 — data/*.json 을 읽어 8개 탭을 렌더링 */

const DATA = {};
const FILES = ["meta", "teams", "schedule", "standings", "players", "news", "events", "last_season", "profiles", "tickets"];

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
  const tk = (DATA.tickets && DATA.tickets.teams) || {};
  ((DATA.teams && DATA.teams.teams) || []).forEach(t => { TEAM[t.name] = { ...t, ticket: tk[t.name] || null }; });
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
  const realTeams = !!(TEAM[g.home] && TEAM[g.away]);
  const preview = g.state === "scheduled" && realTeams;
  const canOpen = (live || fin || preview) && g.gid && !String(g.gid).startsWith("seed");
  const watch = watchLinks(g);
  const more = canOpen ? ` <b class="more">${live ? "문자중계 ›" : fin ? "상세 ›" : "미리보기 ›"}</b>` : "";
  return `<div class="game ${live ? "is-live" : ""} ${mine ? "is-mine" : ""} ${canOpen ? "clickable" : ""}"${canOpen ? ` data-gid="${esc(g.gid)}" role="button" tabindex="0"` : ""}>
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
    ${watch}
    <div class="game-meta">
      <span>${esc(g.venue || "")}</span>
      <span class="${live ? "status-live" : ""}">${esc(status)}${more}</span>
    </div>
  </div>`;
}

/* 생중계 · 예매 버튼 */
const NAVER_GAME = (gid) => `https://m.sports.naver.com/game/${encodeURIComponent(gid)}`;
function watchLinks(g, big) {
  if (!g.gid || String(g.gid).startsWith("seed")) return "";
  const btns = [];
  const today = todayStr();
  if (g.state === "live") {
    if (g.stream && g.stream.url) btns.push(`<a class="wbtn live" href="${esc(g.stream.url)}" target="_blank" rel="noopener">▶ 생중계 보기</a>`);
    else btns.push(`<a class="wbtn live" href="${NAVER_GAME(g.gid)}" target="_blank" rel="noopener">▶ 네이버 중계</a>`);
  } else if (g.state === "scheduled" && g.date === today && g.stream && g.stream.url) {
    btns.push(`<a class="wbtn" href="${esc(g.stream.url)}" target="_blank" rel="noopener">📺 중계 채널</a>`);
  }
  if (g.state === "scheduled" && g.date >= today && g.kind === "regular" && !g.neutral) {
    const tk = ticketOf(g.home);
    if (tk) btns.push(`<a class="wbtn ticket" href="${esc(tk.url)}" target="_blank" rel="noopener">🎟️ 예매</a>`);
  }
  if (big && g.state === "final") btns.push(`<a class="wbtn" href="${NAVER_GAME(g.gid)}/video" target="_blank" rel="noopener">🎬 하이라이트</a>`);
  return btns.length ? `<div class="wbtns">${btns.join("")}</div>` : "";
}
function ticketOf(team) {
  const t = (TEAM[team] || {}).ticket;
  return t && t.url ? t : null;
}

function showPrice(team) {
  const t = ticketOf(team);
  if (!t || !t.price_img) return;
  GM.gid = "__price";
  document.body.classList.add("gm-lock");
  document.getElementById("game-modal").classList.add("open");
  document.getElementById("gm-body").innerHTML = `<div class="gm-head"><div class="gm-meta">${dot(team)}${esc(team)} · ${esc((TEAM[team] || {}).arena || "")}</div>
    <h3 style="margin-top:6px">💺 2026-27 좌석 가격표</h3>
    <div class="wbtns" style="justify-content:center;margin-top:10px"><a class="wbtn ticket" href="${esc(t.url)}" target="_blank" rel="noopener">🎟️ KOVO에서 예매</a>${t.seat_url ? `<a class="wbtn" href="${esc(t.seat_url)}" target="_blank" rel="noopener">👀 좌석 시야 보기</a>` : ""}</div></div>
    <img src="${esc(t.price_img)}" alt="${esc(team)} 좌석 가격표" class="price-img" onerror="this.outerHTML='<div class=&quot;empty&quot;>가격표 이미지를 불러오지 못했어요. 새로고침하거나 KOVO에서 확인해 주세요.</div>'">
    <p class="hint" style="margin-top:8px">출처: 한국배구연맹(KOVO) · 가격은 구단 사정에 따라 바뀔 수 있어요</p>`;
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
  html += rankChartHtml();
  const ls = DATA.last_season;
  if (ls) {
    html += `<div class="sched-sub">📜 지난 시즌 최종 순위 (${esc(ls.season)})</div>`;
    html += rankTable(ls.standings.map(r => ({ ...r })), { foot: "대한항공·현대캐피탈 승점 69 동률 → 다승으로 대한항공 1위" });
  }
  p.innerHTML = html;
  bindRankChart(p);
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
  let html = `<h2 class="section-title">🏐 선수 기록${pl.scope ? ` <span class="hint" style="margin:0">${esc(pl.scope)} ${pl.games || ""}경기</span>` : ""}</h2>`;
  if (pl.scope === "컵대회") html += `<p class="hint">정규리그가 시작되면(10월 31일~) 정규리그 기록으로 자동으로 바뀌어요.</p>`;
  if (keys.length) {
    if (!PL_CAT || !keys.includes(PL_CAT)) PL_CAT = keys[0];
    const c = cats[PL_CAT];
    const cols = c.columns || [];
    let rows = c.rows.slice();
    if (PL_SORT) rows.sort((a, b) => (parseFloat(b[PL_SORT]) || 0) - (parseFloat(a[PL_SORT]) || 0));
    html += `<div class="stage-tabs">${keys.map(k => `<button class="stage-chip ${k === PL_CAT ? "active" : ""}" data-pc="${esc(k)}">${esc(k)}</button>`).join("")}</div>
      <div class="card table-scroll"><table class="stats"><thead><tr><th>#</th><th style="text-align:left">선수</th><th style="text-align:left">팀</th>
      ${cols.map(col => `<th data-ps="${esc(col)}">${esc(col)}${PL_SORT === col ? " ▼" : ""}</th>`).join("")}</tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${isMine(r.team) ? "mine-row" : ""}"><td class="num">${i + 1}</td><td class="pname"><a class="plink" data-pteam="${esc(r.team)}" data-pname="${esc(r.name)}">${esc(r.name)}</a>${r.pos ? `<div class="gm-pos">${esc(r.pos)}</div>` : ""}</td><td class="pteam">${dot(r.team)}${esc(r.team)}</td>
        ${cols.map(col => `<td class="num">${esc(r[col] == null ? "-" : r[col])}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div><p class="hint">${c.note ? esc(c.note) + "<br>" : ""}출처: ${esc(pl.source || "-")} · 열 제목을 누르면 정렬 · 이름을 누르면 프로필</p>`;
  } else {
    html += emptyBox("이번 시즌 개인 기록은 정규시즌 개막(10월 31일) 후 경기 결과가 쌓이면 표시됩니다.");
  }
  html += compareHtml();
  const ls = DATA.last_season;
  if (ls && ls.awards) {
    html += `<div class="sched-sub">🏅 지난 시즌 (${esc(ls.season)}) 시상</div><div class="card">${ls.awards.map(a =>
      `<div class="mt-pl ${isMine(a.team) ? "mine" : ""}"><span>${esc(a.award)}</span><span class="num"><b>${esc(a.name)}</b> · ${dot(a.team)}${esc(a.team)}</span></div>`).join("")}</div>`;
  }
  p.innerHTML = html;
  p.querySelectorAll("[data-pc]").forEach(b => b.onclick = () => { PL_CAT = b.dataset.pc; PL_SORT = null; renderPlayers(); });
  p.querySelectorAll("th[data-ps]").forEach(th => th.onclick = () => { PL_SORT = th.dataset.ps; renderPlayers(); });
  p.querySelectorAll(".plink").forEach(a => a.onclick = () => openProfile(a.dataset.pteam, a.dataset.pname));
  p.querySelectorAll("[data-cmp]").forEach(se => se.onchange = () => { CMP[+se.dataset.cmp] = se.value; renderPlayers(); });
}

/* ---------- 선수단 · 프로필 ---------- */
const POS_ORDER = ["S", "OH", "OP", "MB", "L"];
const POS_FULL = { S: "세터", OH: "아웃사이드 히터", OP: "아포짓", MB: "미들블로커", L: "리베로" };
let SQ_TEAM = null, SQ_OPEN = null;
function seasonLine(team, name) {
  const rs = ((DATA.players || {}).roster || {})[team] || [];
  return rs.find(r => r.name === name);
}
function openProfile(team, name) {
  SQ_TEAM = team; SQ_OPEN = name; showTab("squad"); renderSquad();
  setTimeout(() => { const el = document.querySelector(`.pf-card[data-open="1"]`); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 60);
}
const seasonShort = (x) => {
  const m = /^(\d{2})(\d{2})-\d{2}(\d{2})\s*\[(.)\]/.exec(x || "");
  return m ? `${m[2]}-${m[3]} ${({ 정: "정규", 컵: "컵", 챔: "챔프", 플: "PO", 준: "준PO" })[m[4]] || m[4]}` : (x || "");
};
const fmtN = (v, d = 0) => v == null || v === "" ? "-" : Number(v).toFixed(d);
function profileCard(team, p) {
  const open = SQ_OPEN === p.name;
  const sl = seasonLine(team, p.name);
  const scope = (DATA.players || {}).scope || "";
  const badges = [p.foreign ? '<span class="pf-ik">외국인</span>' : "", p.asia ? '<span class="pf-ik">아시아쿼터</span>' : ""].join("");
  const body = [
    p.age != null ? `${p.age}세` : "", p.height ? `${p.height}cm` : "", p.weight ? `${p.weight}kg` : ""].filter(Boolean).join(" · ");
  let html = `<div class="card pf-card ${open ? "open" : ""}" data-open="${open ? 1 : 0}" data-pn="${esc(p.name)}" role="button" tabindex="0">
    <div class="pf-head">
      ${p.img ? `<img class="pf-img" src="${esc(p.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
      <div class="pf-no" style="color:${colorOf(team)}">${p.no ?? ""}</div>
      <div class="pf-names"><div class="pf-name">${esc(p.name)}</div><div class="pf-jp">${esc(POS_FULL[p.pos] || p.pos)}${body ? " · " + esc(body) : ""}</div></div>
      <div class="pf-badges">${badges}</div>
    </div>
    ${sl ? `<div class="pf-stat">${esc(scope)} ${sl.g}경기 ${sl.s}세트 · <b>${sl.pts}점</b></div>` : ""}`;
  if (open) {
    html += `${p.nation && p.nation !== "한국" ? `<div class="pf-row"><span>🌏</span><span>${esc(p.nation)}</span></div>` : ""}
      ${p.school ? `<div class="pf-row"><span>🎓</span><span>${esc(p.school)}</span></div>` : ""}
      ${p.birth ? `<div class="pf-row"><span>🎂</span><span>${esc(p.birth)}</span></div>` : ""}`;
    if (p.career && p.career.length) {
      html += `<div class="table-scroll" style="margin-top:6px"><table class="gm-tbl"><thead><tr><th class="l">시즌</th><th>경기</th><th>득점</th><th>공격%</th><th>블로킹/S</th><th>서브/S</th><th>리시브%</th><th>디그/S</th>${p.pos === "S" ? "<th>세트/S</th>" : ""}</tr></thead><tbody>
        ${p.career.map(c => `<tr><td class="l" style="white-space:nowrap">${esc(seasonShort(c.season))}</td><td>${fmtN(c.g)}</td><td>${fmtN(c.pts)}</td><td>${fmtN(c.atk, 1)}</td><td>${fmtN(c.blk, 2)}</td><td>${fmtN(c.srv, 2)}</td><td>${fmtN(c.rcv, 1)}</td><td>${fmtN(c.dig, 2)}</td>${p.pos === "S" ? `<td>${fmtN(c.set, 2)}</td>` : ""}</tr>`).join("")}
        </tbody></table></div><div class="hint" style="margin:4px 0 0">공격% = 공격 종합 성공률 · 리시브% = 리시브 효율 · /S = 세트당</div>`;
    }
    if (p.history && p.history.length) html += `<div class="pf-hist">${p.history.map(h => `<div>· ${esc(h)}</div>`).join("")}</div>`;
  } else html += `<div class="pf-more">눌러서 프로필 보기 ›</div>`;
  return html + `</div>`;
}
function renderSquad() {
  const p = document.getElementById("panel-squad");
  const pr = (DATA.profiles || {}).teams || {};
  const teams = ((DATA.teams && DATA.teams.teams) || []).map(t => t.name);
  if (!SQ_TEAM || !teams.includes(SQ_TEAM)) SQ_TEAM = (MY_TEAM && teams.includes(MY_TEAM)) ? MY_TEAM : teams[0];
  let html = `<h2 class="section-title">👥 선수단</h2>
    <div class="stage-tabs">${teams.map(t => `<button class="stage-chip ${t === SQ_TEAM ? "active" : ""}" data-sq="${esc(t)}" style="${t === SQ_TEAM ? `background:${colorOf(t)};border-color:${colorOf(t)};color:#0b0f17` : ""}">${esc(t)}</button>`).join("")}</div>`;
  const lst = pr[SQ_TEAM] || [];
  if (!lst.length) {
    html += emptyBox("선수 프로필을 아직 받지 못했어요. 자동 수집이 하루 한 번 KOVO에서 받아와요.");
  } else {
    const t = TEAM[SQ_TEAM] || {};
    const n = lst.length, ages = lst.filter(x => x.age != null).map(x => x.age), hs = lst.filter(x => x.height).map(x => x.height);
    const avg = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "-";
    html += `<div class="pf-summary"><div><b>${n}명</b><span>등록 선수</span></div><div><b>${avg(ages)}세</b><span>평균 나이</span></div>
      <div><b>${avg(hs)}cm</b><span>평균 키</span></div><div><b>${esc(t.coach || "-")}</b><span>감독</span></div>
      <div><b>${lst.filter(x => x.foreign || x.asia).length}명</b><span>외국인·아쿼</span></div></div>`;
    POS_ORDER.concat([""]).forEach(pos => {
      const grp = lst.filter(x => pos ? x.pos === pos : !POS_ORDER.includes(x.pos));
      if (!grp.length) return;
      html += `<div class="sched-sub">${esc(POS_FULL[pos] || "기타")} <span class="hint" style="margin:0">${grp.length}명</span></div>
        <div class="pf-grid">${grp.map(x => profileCard(SQ_TEAM, x)).join("")}</div>`;
    });
    html += `<p class="hint" style="margin-top:12px">출처: 한국배구연맹(KOVO) · ${esc((DATA.profiles || {}).updated_at || "")} 기준 · 사진 © KOVO</p>`;
  }
  p.innerHTML = html;
  p.querySelectorAll("[data-sq]").forEach(b => b.onclick = () => { SQ_TEAM = b.dataset.sq; SQ_OPEN = null; renderSquad(); });
  p.querySelectorAll(".pf-card").forEach(c => c.onclick = (e) => {
    if (e.target.closest("a")) return;
    SQ_OPEN = SQ_OPEN === c.dataset.pn ? null : c.dataset.pn; renderSquad();
  });
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
      <div class="wbtns" style="margin-top:8px">
        <a class="wbtn" href="https://map.naver.com/p/search/${encodeURIComponent(a.city.split(" ")[0] + " " + a.name)}" target="_blank" rel="noopener">🗺️ 지도</a>
        ${a.team && ticketOf(a.team) ? `<a class="wbtn ticket" href="${esc(ticketOf(a.team).url)}" target="_blank" rel="noopener">🎟️ 예매</a>` : ""}
        ${a.team && ticketOf(a.team) && ticketOf(a.team).price_img ? `<button class="wbtn" data-price="${esc(a.team)}">💺 좌석 가격표</button>` : ""}
      </div>
    </div>`).join("")}</div>`;
  p.querySelectorAll("[data-price]").forEach(b => b.onclick = () => showPrice(b.dataset.price));
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
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><button class="btn-ghost" id="mt-change">팀 바꾸기</button>
      ${ticketOf(MY_TEAM) ? `<a class="wbtn ticket" href="${esc(ticketOf(MY_TEAM).url)}" target="_blank" rel="noopener">🎟️ 홈경기 예매</a>` : ""}</div></div>
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

/* ---------- 경기 상세: 문자중계 · 세트별 선발 ---------- */
const POS = { S: "세터", OH: "아웃사이드 히터", OP: "아포짓", MB: "미들블로커", L: "리베로" };
const GM = { gid: null, set: null, relay: null, loading: false, newestFirst: true };
async function openGame(gid) {
  GM.gid = gid; GM.set = null; GM.relay = null;
  document.body.classList.add("gm-lock");
  document.getElementById("game-modal").classList.add("open");
  renderGameModal();
  const g0 = allGames().find(x => x.gid === gid);
  if (g0 && g0.state === "scheduled") return;
  if (!liveRelay(gid)) {
    GM.loading = true; renderGameModal();
    try {
      const r = await fetch(`data/games/${encodeURIComponent(gid)}.json?t=${Date.now()}`, { cache: "no-store" });
      GM.relay = r.ok ? await r.json() : null;
    } catch (e) { GM.relay = null; }
    GM.loading = false;
    if (GM.gid === gid) renderGameModal();
  }
}
function closeGame() {
  GM.gid = null;
  document.body.classList.remove("gm-lock");
  document.getElementById("game-modal").classList.remove("open");
}
function liveRelay(gid) {
  const L = DATA.live;
  return L && L.relay && L.relay[gid] ? L.relay[gid] : null;
}
/* 득점 장면 문장에서 선수 이름별 득점 집계 */
function topScorers(R, side) {
  const cnt = {};
  Object.values(R.sets || {}).forEach(st => (st.relay || []).forEach(e => {
    if (e[2] !== "S" || e[1] !== (side === "home" ? 1 : 0)) return;
    const [name, ...rest] = e[3].split(" ");
    if (!rest.length || name === "팀득점") return;
    const kind = /블로킹|블록킹/.test(e[3]) ? "b" : /서브/.test(e[3]) ? "s" : "a";
    cnt[name] = cnt[name] || { n: name, t: 0, a: 0, b: 0, s: 0 }; cnt[name].t++; cnt[name][kind]++;
  }));
  return Object.values(cnt).sort((x, y) => y.t - x.t).slice(0, 5);
}
function lineupBlock(lst, team) {
  if (!lst || !lst.length) return `<div class="hint">라인업 정보 없음</div>`;
  const start = lst.slice(0, 6), rest = lst.slice(6);
  const row = (p, i) => `<div class="lu-row"><span class="lu-no">${i}</span><b>${esc(p.n)}</b><span class="lu-pos">${esc(POS[p.p] || p.p)}</span></div>`;
  return `<div class="lu-team">${dot(team)}<b>${esc(team)}</b></div>${start.map((p, i) => row(p, i + 1)).join("")}
    ${rest.length ? `<div class="lu-sub">${rest.map(p => `${esc(p.n)} <span class="lu-pos">${esc(POS[p.p] || p.p)}</span>`).join(" · ")}</div>` : ""}`;
}
function relayBlock(st, g) {
  const rel = st.relay || [];
  if (!rel.length) return `<div class="empty">아직 중계 내용이 없어요.</div>`;
  // 랠리별로 묶기
  const rallies = [];
  let cur = null;
  rel.forEach(e => {
    if (!cur || cur.no !== e[0]) { cur = { no: e[0], items: [] }; rallies.push(cur); }
    cur.items.push(e);
  });
  let ph = 0, pa = 0;
  rallies.forEach(r => {
    const last = r.items[r.items.length - 1];
    const hs = Math.max(...r.items.map(e => e[4])), as = Math.max(...r.items.map(e => e[5]));
    r.hs = hs; r.as = as;
    r.win = hs > ph ? "home" : as > pa ? "away" : null;
    ph = hs; pa = as;
    r.flag = r.items.every(e => e[2] === "F") ? last[3] : null;
  });
  const list = GM.newestFirst ? rallies.slice().reverse() : rallies;
  return list.map(r => {
    if (r.flag) return `<div class="rl-flag">${esc(r.flag === "경기종료" ? "세트 종료" : r.flag === "경기시작" ? "세트 시작" : r.flag)} · ${r.as}:${r.hs}</div>`;
    const wteam = r.win === "home" ? g.home : r.win === "away" ? g.away : null;
    const lines = r.items.filter(e => e[2] !== "F").map(e => {
      const team = e[1] === 1 ? g.home : e[1] === 0 ? g.away : "";
      if (e[2] === "I" || e[2] === "O") return `<div class="rl-line chg">🔄 ${esc(team)} 교체 ${e[2] === "I" ? "IN" : "OUT"}&nbsp;<b>${esc(e[3])}</b></div>`;
      const cls = e[2] === "S" ? "pt" : e[2] === "T" ? "team" : "";
      return `<div class="rl-line ${cls}"><span class="dot sm" style="background:${colorOf(team)}"></span>${esc(e[3])}</div>`;
    }).join("");
    if (!lines) return "";
    return `<div class="rl-rally" style="${wteam ? `border-left-color:${colorOf(wteam)}` : ""}">
      <div class="rl-head">${wteam ? `${dot(wteam)}<b>${esc(wteam)} 득점</b>` : `<b>랠리 ${r.no}</b>`}<span class="rl-score">${esc(g.away)} <b>${r.as}</b> : <b>${r.hs}</b> ${esc(g.home)}</span></div>
      ${lines}</div>`;
  }).join("");
}
/* 세트 흐름: 랠리마다 (원정 − 홈) 점수 차. 위 = 원정 리드, 아래 = 홈 리드 */
function flowChart(st, g) {
  const pts = [[0, 0, 0]];
  let ph = 0, pa = 0;
  (st.relay || []).forEach(e => {
    if (e[4] !== ph || e[5] !== pa) { ph = e[4]; pa = e[5]; pts.push([pts.length, pa, ph]); }
  });
  if (pts.length < 3) return "";
  // 최다 연속 득점
  const run = { home: 0, away: 0 };
  let cur = null, len = 0;
  for (let i = 1; i < pts.length; i++) {
    const who = pts[i][1] > pts[i - 1][1] ? "away" : "home";
    len = who === cur ? len + 1 : 1; cur = who;
    run[who] = Math.max(run[who], len);
  }
  const diffs = pts.map(p => p[1] - p[2]);
  const M = Math.max(3, ...diffs.map(Math.abs));
  const W = 600, H = 170, padL = 8, padR = 8, padT = 14, padB = 14;
  const x = (i) => padL + (W - padL - padR) * i / (pts.length - 1);
  const y = (d) => padT + (H - padT - padB) * (1 - (d + M) / (2 * M));
  const line = diffs.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d).toFixed(1)}`).join("");
  const area = `${line}L${x(diffs.length - 1).toFixed(1)},${y(0)}L${x(0)},${y(0)}Z`;
  const ca = colorOf(g.away), ch = colorOf(g.home);
  const uid = "f" + Math.random().toString(36).slice(2, 8);
  const grid = [M, Math.round(M / 2), -Math.round(M / 2), -M].filter((v, i, a) => v && a.indexOf(v) === i);
  return `<div class="card flow-card">
    <div class="flow-legend"><span><i style="background:${ca}"></i>${esc(g.away)} 리드 ▲</span><span><i style="background:${ch}"></i>${esc(g.home)} 리드 ▼</span></div>
    <div class="flow-wrap" data-flow='${JSON.stringify(pts)}' data-away="${esc(g.away)}" data-home="${esc(g.home)}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="flow-svg" role="img" aria-label="세트 점수 차 흐름">
      <defs>
        <clipPath id="${uid}u"><rect x="0" y="0" width="${W}" height="${y(0)}"/></clipPath>
        <clipPath id="${uid}d"><rect x="0" y="${y(0)}" width="${W}" height="${H - y(0)}"/></clipPath>
      </defs>
      ${grid.map(v => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="flow-grid"/>`).join("")}
      <path d="${area}" fill="${ca}" fill-opacity=".28" clip-path="url(#${uid}u)"/>
      <path d="${area}" fill="${ch}" fill-opacity=".28" clip-path="url(#${uid}d)"/>
      <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="flow-zero"/>
      <path d="${line}" class="flow-line" vector-effect="non-scaling-stroke"/>
      <line class="flow-cross" x1="0" x2="0" y1="0" y2="${H}" style="display:none" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="flow-tip" style="display:none"></div></div>
    <div class="flow-foot">점선 = ${Math.round(M / 2)}점·${M}점 차 · 최다 연속 득점 · ${dot(g.away)}${esc(g.away)} <b>${run.away}점</b> &nbsp; ${dot(g.home)}${esc(g.home)} <b>${run.home}점</b> · 최대 점수 차 <b>${Math.max(...diffs.map(Math.abs))}점</b></div>
  </div>`;
}
function bindFlow(root) {
  root.querySelectorAll(".flow-wrap").forEach(w => {
    const pts = JSON.parse(w.dataset.flow), svg = w.querySelector("svg"), tip = w.querySelector(".flow-tip"), cross = w.querySelector(".flow-cross");
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((cx - r.width * 8 / 600) / (r.width * 584 / 600) * (pts.length - 1))));
      const px = (8 + 584 * i / (pts.length - 1));
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.style.display = "";
      const [n, a, h] = pts[i];
      tip.innerHTML = `${n ? n + "번째 득점" : "시작"} · ${esc(w.dataset.away)} <b>${a}</b> : <b>${h}</b> ${esc(w.dataset.home)}`;
      tip.style.display = "";
      tip.style.left = Math.min(Math.max(px / 600 * r.width, 70), r.width - 70) + "px";
    };
    const hide = () => { tip.style.display = "none"; cross.style.display = "none"; };
    w.addEventListener("mousemove", move); w.addEventListener("touchmove", move, { passive: true });
    w.addEventListener("touchstart", move, { passive: true });
    w.addEventListener("mouseleave", hide);
  });
}

function renderGameModal() {
  const body = document.getElementById("gm-body");
  if (!GM.gid || !body || GM.gid === "__price") return;
  const g = allGames().find(x => x.gid === GM.gid);
  if (!g) { body.innerHTML = emptyBox("경기 정보를 찾을 수 없어요."); return; }
  if (g.state === "scheduled") { body.innerHTML = previewHtml(g); return; }
  const R = liveRelay(g.gid) || GM.relay;
  const live = g.state === "live";
  const sets = R && R.sets ? Object.keys(R.sets).map(Number).sort((a, b) => a - b) : [];
  if (GM.set == null || !sets.includes(GM.set)) GM.set = sets.length ? sets[sets.length - 1] : null;
  const st = GM.set != null ? R.sets[String(GM.set)] : null;
  const setScore = (Array.isArray(g.sets) ? g.sets : []).map((s, i) => `<th>${i + 1}세트</th>`).join("");
  let html = `<div class="gm-head">
      <div class="gm-meta">${esc(dateLabel(g.date))} ${esc(g.time || "")} · ${esc(g.venue || "")} · ${esc(g.series || KIND_LABEL[g.kind] || "")}</div>
      <div class="gm-score">
        <div class="gm-t ${+g.sa > +g.sh ? "win" : ""}">${dot(g.away)}${esc(g.away)}<small>원정</small></div>
        <b>${g.sa ?? "-"}<i>:</i>${g.sh ?? "-"}</b>
        <div class="gm-t ${+g.sh > +g.sa ? "win" : ""}">${dot(g.home)}${esc(g.home)}<small>${g.neutral ? "&nbsp;" : "홈"}</small></div>
      </div>
      <div class="td-status ${live ? "on" : ""}">${live ? `<span class="live-dot"></span> ${esc(g.status || "경기 중")} · 1분마다 갱신` : esc(g.status || "")}</div>
      ${watchLinks(g, true)}
    </div>`;
  if (Array.isArray(g.sets) && g.sets.length) {
    html += `<table class="gm-line"><thead><tr><th></th>${setScore}<th>세트</th></tr></thead><tbody>
      <tr><td class="team">${dot(g.away)}${esc(g.away)}</td>${g.sets.map(s => `<td class="${+s[1] > +s[0] ? "scored" : ""}">${s[1]}</td>`).join("")}<td class="tot">${g.sa ?? "-"}</td></tr>
      <tr><td class="team">${dot(g.home)}${esc(g.home)}</td>${g.sets.map(s => `<td class="${+s[0] > +s[1] ? "scored" : ""}">${s[0]}</td>`).join("")}<td class="tot">${g.sh ?? "-"}</td></tr>
    </tbody></table>`;
  }
  if (GM.loading) html += `<div class="empty">불러오는 중...</div>`;
  else if (!R || !sets.length) {
    html += emptyBox(live ? "중계 데이터를 기다리는 중이에요. 1~2분 뒤 자동으로 나타나요." : "이 경기의 문자중계 기록이 아직 없어요. (끝난 경기는 수집 주기에 따라 몇 시간 안에 저장돼요)");
  } else {
    // 득점 TOP
    const ta = topScorers(R, "away"), th = topScorers(R, "home");
    if (ta.length || th.length) {
      const blk = (lst, team) => `<div class="card gm-card"><div class="mt-ph">${dot(team)}${esc(team)} 득점</div>${lst.map(p =>
        `<div class="mt-pl"><span>${esc(p.n)}</span><span class="num"><b>${p.t}점</b> <small>공격 ${p.a} · 블로킹 ${p.b} · 서브 ${p.s}</small></span></div>`).join("") || '<div class="hint">-</div>'}</div>`;
      html += `<div class="gm-two">${blk(ta, g.away)}${blk(th, g.home)}</div><p class="hint" style="margin-top:6px">문자중계 기준 집계 (상대 범실 득점 제외)</p>`;
    }
    html += `<div class="stage-tabs td-tabs">${sets.map(n => `<button class="stage-chip ${n === GM.set ? "active" : ""}" data-gs="${n}">${n}세트${live && n === sets[sets.length - 1] ? " ●" : ""}</button>`).join("")}</div>`;
    html += `<div class="sched-sub">📈 ${GM.set}세트 흐름</div>${flowChart(st, g) || '<div class="hint">득점이 쌓이면 그래프가 나와요.</div>'}`;
    html += `<div class="sched-sub">📋 ${GM.set}세트 선발 라인업</div>
      <div class="gm-two"><div class="card gm-card">${lineupBlock(st.lineup && st.lineup.away, g.away)}</div><div class="card gm-card">${lineupBlock(st.lineup && st.lineup.home, g.home)}</div></div>
      <p class="hint" style="margin-top:6px">1~6번 = 코트에 선 6명 (서브 순서), 아래 = 리베로·교체 명단</p>`;
    html += `<div class="sched-sub">🎙️ ${GM.set}세트 문자중계 <button class="stage-chip" data-gord="1" style="margin-left:auto">${GM.newestFirst ? "최신순" : "처음부터"}</button></div>
      <div class="rl-list">${relayBlock(st, g)}</div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll("[data-gs]").forEach(b => b.onclick = () => { GM.set = +b.dataset.gs; renderGameModal(); });
  bindFlow(body);
  const ob = body.querySelector("[data-gord]");
  if (ob) ob.onclick = () => { GM.newestFirst = !GM.newestFirst; renderGameModal(); };
}

/* ---------- 경기 미리보기 ---------- */
function profileOf(team, name) {
  return (((DATA.profiles || {}).teams || {})[team] || []).find(p => p.name === name) || null;
}
function teamForm(team, n = 5) {
  return allGames().filter(g => g.state === "final" && (g.home === team || g.away === team)).slice(-n).map(g => {
    const mine = g.home === team ? +g.sh : +g.sa, op = g.home === team ? +g.sa : +g.sh;
    return { g, win: mine > op, mine, op, opp: g.home === team ? g.away : g.home };
  });
}
function previewHtml(g) {
  const A = g.away, H = g.home;
  const cur = seasonTable();
  const last = (DATA.last_season && DATA.last_season.standings) || [];
  const rowOf = (t) => cur ? cur.rows.find(r => r.team === t) : null;
  const lastOf = (t) => last.find(r => r.team === t);
  const today = todayStr(), dd = daysBetween(today, g.date);
  let html = `<div class="gm-head">
    <div class="gm-meta">${esc(dateLabel(g.date))} ${esc(g.time || "")} · ${esc(g.venue || "")} · ${esc(g.series || KIND_LABEL[g.kind] || "")}</div>
    <div class="gm-score">
      <div class="gm-t win">${dot(A)}${esc(A)}<small>원정</small></div>
      <b class="td-vs">VS</b>
      <div class="gm-t win">${dot(H)}${esc(H)}<small>${g.neutral ? "&nbsp;" : "홈"}</small></div>
    </div>
    <div class="td-status">${dd === 0 ? "오늘 경기" : dd > 0 ? `D-${dd}` : ""} · 경기 미리보기</div>
    ${watchLinks(g, true)}
  </div>`;

  // 시즌 성적 비교
  const statBox = (t) => {
    const r = rowOf(t), l = lastOf(t), f = teamForm(t);
    return `<div class="card gm-card pv-team" style="border-top:3px solid ${colorOf(t)}">
      <div class="mt-ph">${dot(t)}${esc(t)}</div>
      ${r ? `<div class="pv-big">${r.rank}<small>위</small></div><div class="pv-sub">${r.w}승 ${r.l}패 · 승점 ${r.pts}</div>`
          : `<div class="pv-big">-</div><div class="pv-sub">정규리그 시작 전</div>`}
      ${l ? `<div class="pv-sub">지난 시즌 ${l.rank}위 (${l.w}승 ${l.l}패)</div>` : ""}
      <div class="form-row" style="margin:8px 0 0">${f.length ? f.map(x => `<span class="form-chip sm ${x.win ? "W" : "L"}" title="${esc(x.g.date)} vs ${esc(x.opp)} ${x.mine}:${x.op}">${x.win ? "승" : "패"}</span>`).join("") : '<span class="hint" style="margin:0">최근 경기 없음</span>'}</div>
      <div class="pv-sub" style="margin-top:2px">최근 ${f.length}경기 (컵대회 포함)</div>
    </div>`;
  };
  html += `<div class="sched-sub">📊 두 팀 지금</div><div class="gm-two">${statBox(A)}${statBox(H)}</div>`;

  // 상대 전적
  const meet = allGames().filter(x => x.state === "final" && ((x.home === A && x.away === H) || (x.home === H && x.away === A)));
  const aw = meet.filter(x => (x.home === A ? +x.sh : +x.sa) > (x.home === A ? +x.sa : +x.sh)).length;
  html += `<div class="sched-sub">⚔️ 이번 시즌 맞대결</div><div class="card">`;
  if (meet.length) {
    html += `<div class="pv-h2h"><span>${dot(A)}<b>${esc(A)}</b></span><b class="pv-h2h-n">${aw} : ${meet.length - aw}</b><span><b>${esc(H)}</b>${dot(H)}</span></div>
      ${meet.slice().reverse().map(x => {
        const sa = x.home === A ? x.sh : x.sa, sh = x.home === A ? x.sa : x.sh;
        return `<div class="mt-pl clickable" data-gid="${esc(x.gid)}"><span class="mt-date">${esc(x.date.slice(5).replace("-", "/"))} · ${esc(KIND_LABEL[x.kind] || "")}${x.series ? " " + esc(x.series.replace("컵대회 ", "")) : ""}</span><span class="num"><b>${sa} : ${sh}</b> ›</span></div>`;
      }).join("")}`;
  } else html += `<div class="hint" style="margin:0">이번 시즌 첫 맞대결이에요.</div>`;
  // 지난 시즌 봄배구 맞대결
  const ps = ((DATA.last_season || {}).postseason || []).filter(st => {
    const ser = st.series || [];
    const inSeries = ser.some(x => [x.home, x.away].includes(A) && [x.home, x.away].includes(H));
    const inSummary = st.summary && st.summary.includes(A) && st.summary.includes(H);
    const finalPair = st.stage === "챔피언결정전" && [A, H].includes(st.winner) && ((DATA.last_season || {}).standings || []).slice(0, 2).every(r => [A, H].includes(r.team));
    return inSeries || inSummary || finalPair;
  });
  if (ps.length) html += `<div class="pv-note">📜 지난 시즌 ${ps.map(st => `${esc(st.stage)}에서 만나 <b>${esc(st.winner)}</b> 승리${st.summary ? ` (${esc(st.summary)})` : ""}`).join(" · ")}</div>`;
  html += `</div>`;

  // 주목할 선수
  const all = (DATA.players || {}).all || [];
  const scope = (DATA.players || {}).scope || "";
  const keyBox = (t) => {
    const lst = all.filter(r => r.team === t).sort((a, b) => b.pts - a.pts).slice(0, 3);
    return `<div class="card gm-card"><div class="mt-ph">${dot(t)}${esc(t)}</div>${lst.length ? lst.map(r => {
      const pf = profileOf(t, r.name);
      return `<div class="pv-pl" data-pteam="${esc(t)}" data-pname="${esc(r.name)}">
        ${pf && pf.img ? `<img class="pf-img sm" src="${esc(pf.img)}" alt="" loading="lazy" onerror="this.remove()">` : `<span class="pf-img sm ph"></span>`}
        <div><b>${esc(r.name)}</b> <span class="lu-pos" style="margin:0">${esc(r.pos)}</span>
        <div class="pv-sub">${r.pts}점 · 세트당 ${r.pts_ps} · 공격 ${r.atk_pct}%</div></div></div>`;
    }).join("") : '<div class="hint" style="margin:0">기록 없음</div>'}</div>`;
  };
  html += `<div class="sched-sub">⭐ 주목할 선수 <span class="hint" style="margin:0">${esc(scope)} 득점 순</span></div><div class="gm-two">${keyBox(A)}${keyBox(H)}</div>`;

  // 외국인 · 아시아쿼터
  const fx = (t) => (((DATA.profiles || {}).teams || {})[t] || []).filter(p => p.foreign || p.asia)
    .map(p => `${esc(p.name)} <span class="lu-pos" style="margin:0">${p.asia ? "아시아쿼터" : "외국인"} · ${esc(POS_FULL[p.pos] || p.pos)}${p.nation ? " · " + esc(p.nation) : ""}</span>`).join("<br>") || "-";
  html += `<div class="sched-sub">🌏 외국인 · 아시아쿼터</div><div class="gm-two"><div class="card gm-card"><div class="mt-ph">${dot(A)}${esc(A)}</div><div class="pv-fx">${fx(A)}</div></div><div class="card gm-card"><div class="mt-ph">${dot(H)}${esc(H)}</div><div class="pv-fx">${fx(H)}</div></div></div>`;
  html += `<p class="hint" style="margin-top:10px">세트별 선발 라인업과 문자중계는 경기가 시작되면 이 창에 나와요.</p>`;
  return html;
}

/* ---------- 순위 변동 그래프 ---------- */
let RC_MODE = "rank", RC_FOCUS = null;
function rankHistory() {
  const reg = allGames().filter(g => g.kind === "regular" && g.state === "final");
  if (!reg.length) return null;
  const teams = Object.keys(TEAM);
  const dates = [...new Set(reg.map(g => g.date))].sort();
  return dates.map(d => {
    const rows = computeTable(reg.filter(g => g.date <= d), teams);
    return { date: d, rows: Object.fromEntries(rows.map(r => [r.team, { rank: r.rank, pts: r.pts, w: r.w, l: r.l }])) };
  });
}
function rankChartHtml() {
  const hist = rankHistory();
  if (!hist || hist.length < 2) return `<div class="sched-sub">📈 순위 변동</div>` + emptyBox(hist ? "경기일이 이틀 이상 쌓이면 순위 변동 그래프가 나와요." : "정규리그가 시작되면 날짜별 순위 변동 그래프가 나와요.");
  const teams = Object.keys(TEAM);
  if (!RC_FOCUS || !teams.includes(RC_FOCUS)) RC_FOCUS = (MY_TEAM && teams.includes(MY_TEAM)) ? MY_TEAM : hist[hist.length - 1] && Object.entries(hist[hist.length - 1].rows).sort((a, b) => a[1].rank - b[1].rank)[0][0];
  const isRank = RC_MODE === "rank";
  // 숨겨진 탭에서도 그려지므로 화면 너비 기준 (본문 최대 1080px, 여백·카드 안쪽 여백 제외)
  const W = Math.round(Math.max(300, Math.min(720, Math.min(window.innerWidth, 1080) - 66))), H = W < 480 ? 300 : 280, pL = 26, pR = W < 480 ? 92 : 110, pT = 14, pB = 26;
  const n = hist.length;
  const maxPts = Math.max(3, ...hist.flatMap(h => Object.values(h.rows).map(r => r.pts)));
  const x = (i) => pL + (W - pL - pR) * (n === 1 ? 0.5 : i / (n - 1));
  const y = (v) => isRank ? pT + (H - pT - pB) * (v - 1) / (teams.length - 1) : pT + (H - pT - pB) * (1 - v / maxPts);
  const val = (r) => isRank ? r.rank : r.pts;
  const ticks = isRank ? teams.map((_, i) => i + 1) : [0, Math.round(maxPts / 2), maxPts];
  const xt = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  // 끝 라벨 겹침 방지
  const ends = teams.map(t => ({ t, y: y(val(hist[n - 1].rows[t])) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const endY = Object.fromEntries(ends.map(e => [e.t, e.y]));
  const order = teams.filter(t => t !== RC_FOCUS).concat([RC_FOCUS]);
  const lines = order.map(t => {
    const f = t === RC_FOCUS, c = f ? colorOf(t) : "#475569";
    const d = hist.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val(h.rows[t])).toFixed(1)}`).join("");
    const last = hist[n - 1].rows[t];
    return `<path d="${d}" fill="none" stroke="${c}" stroke-width="${f ? 3 : 1.5}" stroke-linejoin="round" stroke-linecap="round" opacity="${f ? 1 : .9}"/>
      ${f ? hist.map((h, i) => `<circle cx="${x(i)}" cy="${y(val(h.rows[t]))}" r="4" fill="${c}" stroke="#1c2230" stroke-width="2"/>`).join("") : ""}
      <text x="${W - pR + 8}" y="${endY[t] + 4}" class="rc-lab ${f ? "f" : ""}" ${f ? `fill="${c}"` : ""}>${esc(t)} ${isRank ? last.rank + "위" : last.pts}</text>`;
  }).join("");
  return `<div class="sched-sub">📈 ${isRank ? "순위" : "승점"} 변동 <span style="margin-left:auto;display:flex;gap:6px">
      <button class="stage-chip ${isRank ? "active" : ""}" data-rcm="rank">순위</button><button class="stage-chip ${!isRank ? "active" : ""}" data-rcm="pts">승점</button></span></div>
    <div class="card">
      <div class="stage-tabs" style="margin-bottom:8px">${teams.map(t => `<button class="stage-chip ${t === RC_FOCUS ? "active" : ""}" data-rcf="${esc(t)}" style="${t === RC_FOCUS ? `background:${colorOf(t)};border-color:${colorOf(t)};color:#0b0f17` : ""}">${esc(t)}</button>`).join("")}</div>
      <div class="rc-wrap" data-n="${n}" data-w="${W}" data-pr="${pR}">
      <svg viewBox="0 0 ${W} ${H}" class="rc-svg" role="img" aria-label="${isRank ? "순위" : "승점"} 변동 그래프">
        ${ticks.map(v => `<line x1="${pL}" x2="${W - pR}" y1="${y(v)}" y2="${y(v)}" class="flow-grid"/><text x="${pL - 6}" y="${y(v) + 4}" class="rc-tick" text-anchor="end">${v}${isRank ? "" : ""}</text>`).join("")}
        ${xt.map(i => `<text x="${x(i)}" y="${H - 6}" class="rc-tick" text-anchor="middle">${hist[i].date.slice(5).replace("-", "/")}</text>`).join("")}
        ${lines}
        <line class="rc-cross" x1="0" x2="0" y1="${pT}" y2="${H - pB}" style="display:none"/>
      </svg>
      <div class="flow-tip rc-tip" style="display:none"></div></div>
      <div class="hint" style="margin:6px 0 0">선택한 팀만 색으로 강조 · 그래프를 훑으면 그날의 전체 순위</div>
    </div>`;
}
function bindRankChart(root) {
  root.querySelectorAll("[data-rcm]").forEach(b => b.onclick = () => { RC_MODE = b.dataset.rcm; renderStandings(); });
  root.querySelectorAll("[data-rcf]").forEach(b => b.onclick = () => { RC_FOCUS = b.dataset.rcf; renderStandings(); });
  const w = root.querySelector(".rc-wrap");
  if (!w) return;
  const hist = rankHistory(), n = hist.length, svg = w.querySelector("svg"), tip = w.querySelector(".rc-tip"), cross = w.querySelector(".rc-cross");
  const W = +w.dataset.w, pL = 26, pR = +w.dataset.pr;
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), sc = r.width / W;
    const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / sc;
    const i = Math.max(0, Math.min(n - 1, Math.round((cx - pL) / ((W - pL - pR) / Math.max(1, n - 1)))));
    const px = pL + (W - pL - pR) * (n === 1 ? 0.5 : i / (n - 1));
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.style.display = "";
    const rows = Object.entries(hist[i].rows).sort((a, b) => a[1].rank - b[1].rank);
    tip.innerHTML = `<b>${esc(dateLabel(hist[i].date))}</b>` + rows.map(([t, v]) => `<div class="${t === RC_FOCUS ? "f" : ""}">${v.rank}. ${dot(t)}${esc(t)} <span>${v.pts}점 · ${v.w}승 ${v.l}패</span></div>`).join("");
    tip.style.display = "";
    tip.style.left = Math.min(Math.max(px * sc, 95), r.width - 95) + "px";
  };
  const hide = () => { tip.style.display = "none"; cross.style.display = "none"; };
  w.addEventListener("mousemove", move); w.addEventListener("touchstart", move, { passive: true }); w.addEventListener("touchmove", move, { passive: true });
  w.addEventListener("mouseleave", hide);
}

/* ---------- 선수 비교 ---------- */
let CMP = [null, null];
const CMP_METRICS = [
  ["pts", "득점", 0], ["pts_ps", "세트당 득점", 2], ["atk_pct", "공격 성공률 %", 1], ["blk_ps", "세트당 블로킹", 2],
  ["ace_ps", "세트당 서브 에이스", 2], ["dig_ps", "세트당 디그", 2], ["rcv_eff", "리시브 효율 %", 1], ["set_ps", "세트당 세트", 2],
];
function cmpKey(r) { return r.team + "|" + r.name; }
function compareHtml() {
  const all = ((DATA.players || {}).all || []).slice().sort((a, b) => a.team.localeCompare(b.team) || b.pts - a.pts);
  if (!all.length) return "";
  const byKey = Object.fromEntries(all.map(r => [cmpKey(r), r]));
  const top = all.slice().sort((a, b) => b.pts - a.pts);
  if (!CMP[0] || !byKey[CMP[0]]) CMP[0] = cmpKey(top[0]);
  if (!CMP[1] || !byKey[CMP[1]]) CMP[1] = cmpKey(top.find(r => cmpKey(r) !== CMP[0]));
  const P = CMP.map(k => byKey[k]);
  const teams = [...new Set(all.map(r => r.team))];
  const sel = (i) => `<select class="cmp-sel" data-cmp="${i}">${teams.map(t => `<optgroup label="${esc(t)}">${all.filter(r => r.team === t).map(r =>
    `<option value="${esc(cmpKey(r))}" ${cmpKey(r) === CMP[i] ? "selected" : ""}>${esc(r.name)} (${esc(r.pos || "-")})</option>`).join("")}</optgroup>`).join("")}</select>`;
  const colA = colorOf(P[0].team), colB = P[0].team === P[1].team ? "#94a3b8" : colorOf(P[1].team);
  const head = (r, i) => {
    const pf = profileOf(r.team, r.name);
    const meta = pf ? [pf.age != null ? pf.age + "세" : "", pf.height ? pf.height + "cm" : ""].filter(Boolean).join(" · ") : "";
    return `<div class="cmp-head">
      ${pf && pf.img ? `<img class="pf-img" src="${esc(pf.img)}" alt="" loading="lazy" onerror="this.remove()">` : `<span class="pf-img ph"></span>`}
      <div class="pf-name" style="color:${i ? colB : colA}">${esc(r.name)}</div><div class="pv-sub">${dot(r.team)}${esc(r.team)}</div>
      <div class="pv-sub">${esc(r.pos || "")}${meta ? " · " + meta : ""}</div><div class="pv-sub">${r.g}경기 ${r.s}세트</div></div>`;
  };
  const lgMax = (k) => Math.max(...all.filter(r => r.s >= 3).map(r => +r[k] || 0), 0.0001);
  const bars = CMP_METRICS.filter(([k]) => (+P[0][k] || 0) + (+P[1][k] || 0) > 0).map(([k, label, d]) => {
    const m = Math.max(lgMax(k), +P[0][k], +P[1][k]);
    const a = Math.max(0, +P[0][k] || 0), b = Math.max(0, +P[1][k] || 0);
    const win = a === b ? -1 : a > b ? 0 : 1;
    return `<div class="cmp-row">
      <div class="cmp-v ${win === 0 ? "w" : ""}">${a.toFixed(d)}</div>
      <div class="cmp-bar l"><i style="width:${(a / m * 100).toFixed(1)}%;background:${colA}"></i></div>
      <div class="cmp-lab">${esc(label)}</div>
      <div class="cmp-bar"><i style="width:${(b / m * 100).toFixed(1)}%;background:${colB}"></i></div>
      <div class="cmp-v ${win === 1 ? "w" : ""}">${b.toFixed(d)}</div></div>`;
  }).join("");
  const lastReg = (r) => { const pf = profileOf(r.team, r.name); return pf && (pf.career || []).find(c => /\[정\]/.test(c.season || "")); };
  const L = P.map(lastReg);
  const lrow = (label, k, d) => `<tr><td>${L[0] ? fmtN(L[0][k], d) : "-"}</td><td class="l" style="text-align:center;color:var(--muted)">${label}</td><td>${L[1] ? fmtN(L[1][k], d) : "-"}</td></tr>`;
  return `<div class="sched-sub">⚖️ 선수 비교</div>
    <div class="card">
      <div class="cmp-pick">${sel(0)}<span class="hint" style="margin:0">vs</span>${sel(1)}</div>
      <div class="cmp-heads">${head(P[0], 0)}${head(P[1], 1)}</div>
      <div class="cmp-bars">${bars}</div>
      <div class="hint" style="margin:6px 0 0">${esc((DATA.players || {}).scope || "")} 기록 · 막대 길이 = 리그 최고 대비 · 더 높은 쪽 숫자 강조</div>
      ${(L[0] || L[1]) ? `<div class="mt-ph" style="margin-top:12px">지난 정규리그 (KOVO 공식)</div>
        <table class="gm-tbl"><thead><tr><th>${esc(P[0].name)}</th><th></th><th>${esc(P[1].name)}</th></tr></thead><tbody>
        <tr><td>${L[0] ? esc(seasonShort(L[0].season)) : "-"}</td><td class="l" style="text-align:center;color:var(--muted)">시즌</td><td>${L[1] ? esc(seasonShort(L[1].season)) : "-"}</td></tr>
        ${lrow("경기", "g", 0)}${lrow("득점", "pts", 0)}${lrow("공격 성공률 %", "atk", 1)}${lrow("세트당 블로킹", "blk", 2)}${lrow("세트당 서브", "srv", 2)}${lrow("리시브 효율 %", "rcv", 1)}${lrow("세트당 디그", "dig", 2)}
        </tbody></table>` : ""}
    </div>`;
}

/* ---------- 탭 · 전체 렌더 ---------- */
const RENDER = { myteam: renderMyTeam, schedule: renderSchedule, standings: renderStandings, spring: renderSpring, players: renderPlayers, squad: renderSquad, arenas: renderArenas, teams: renderTeams, news: renderNews };
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
  if (GM.gid) renderGameModal();
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
  document.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const mp = e.target.closest("#gm-body .mt-pl.clickable[data-gid]");
    if (mp) { openGame(mp.dataset.gid); return; }
    const pv = e.target.closest("#gm-body .pv-pl[data-pname]");
    if (pv) { closeGame(); openProfile(pv.dataset.pteam, pv.dataset.pname); return; }
    const c = e.target.closest(".game.clickable[data-gid]");
    if (c) openGame(c.dataset.gid);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeGame();
    if (e.key === "Enter" && e.target.matches && e.target.matches(".game.clickable[data-gid]")) openGame(e.target.dataset.gid);
  });
  await loadAll();
  renderAll();
  const h = (location.hash || "").slice(1);
  showTab(RENDER[h] ? h : (MY_TEAM ? "myteam" : "schedule"));
  document.getElementById("loader").classList.add("hide");
  scheduleRefresh();
})();
