"""
V-리그 남자부 데이터 수집기 (GitHub Actions에서 실행)

  data/schedule.json  시즌 전체 경기 (컵대회·정규리그·봄배구) + 세트 점수
  data/news.json      최근 이틀치 남자배구 기사 (Google 뉴스)
  data/meta.json      갱신 시각·수집 상태
  data/_debug/*.json  응답 구조 확인용 샘플 (수집이 깨지면 이걸 보고 고침)

순위는 사이트(app.js)가 경기 결과로 직접 집계한다 → 일정만 제대로 받으면 순위도 맞음.

원칙: 수집에 실패하면 기존 파일을 지우지 않고 그대로 둔다.
"""
import argparse
import collections
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import requests

KST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
DEBUG = os.path.join(DATA, "_debug")

# ---- 시즌 설정 (다음 시즌엔 이 숫자만 바꾸면 됨) ----
SEASON = os.environ.get("VL_SEASON", "2026-27")
CUP_START = date(2026, 10, 19)
CUP_END = date(2026, 10, 25)
REG_START = date(2026, 10, 31)
REG_END = date(2027, 4, 2)
PS_END = date(2027, 4, 25)
PO_START = date(2027, 4, 8)      # 네이버 일정 기준 (준PO 4/6, PO 4/8~, 챔프전 4/14~)
FINAL_START = date(2027, 4, 14)
ALLSTAR = date(2027, 1, 17)

TEAMS = ["대한항공", "현대캐피탈", "KB손해보험", "우리카드", "한국전력", "OK저축은행", "삼성화재"]
CUP_GROUPS = {
    "A": {"OK저축은행", "현대캐피탈", "대한항공", "삼성화재"},
    "B": {"한국전력", "KB손해보험", "우리카드"},
}
VENUES = {  # 홈팀 → 경기장 (네이버에 경기장이 비어 있을 때 대비)
    "대한항공": "인천 계양체육관", "현대캐피탈": "천안 유관순체육관", "KB손해보험": "평택 이충문화체육센터",
    "우리카드": "서울 장충체육관", "한국전력": "수원체육관", "OK저축은행": "부산 강서체육관", "삼성화재": "대전 충무체육관",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/126.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": "https://m.sports.naver.com/volleyball/schedule/index?category=kovo",
    "Origin": "https://m.sports.naver.com",
}
NAVER = "https://api-gw.sports.naver.com"

STATUS = {}  # meta.json 에 남길 수집 상태


def now_kst():
    return datetime.now(KST)


def load(name, default=None):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save(name, obj):
    """내용이 바뀌었을 때만 저장. 바뀌었으면 True."""
    path = os.path.join(DATA, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    new = json.dumps(obj, ensure_ascii=False, indent=1)
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == new:
                return False
    except FileNotFoundError:
        pass
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    return True


def debug_dump(name, obj):
    try:
        os.makedirs(DEBUG, exist_ok=True)
        with open(os.path.join(DEBUG, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def get_json(url, params=None, tries=3):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=15)
            if r.status_code == 200:
                return r.json()
            last = f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as e:  # noqa: BLE001
            last = str(e)
        time.sleep(1.5 * (i + 1))
    raise RuntimeError(last)


# ---------------------------------------------------------------- 팀·경기 분류
def team_kr(name):
    n = (name or "").replace(" ", "")
    for t in TEAMS:
        if t.replace(" ", "") in n:
            return t
    aliases = {"KB": "KB손해보험", "OK": "OK저축은행", "한전": "한국전력", "현캐": "현대캐피탈", "삼성": "삼성화재",
               "우리": "우리카드", "대항": "대한항공", "점보스": "대한항공", "스카이워커스": "현대캐피탈",
               "스타즈": "KB손해보험", "빅스톰": "한국전력", "읏맨": "OK저축은행", "블루팡스": "삼성화재"}
    for k, v in aliases.items():
        if k in n:
            return v
    return name or ""


def classify(d, home, away, title="", round_code=""):
    """경기 종류(kind)와 표시용 시리즈 이름.
    봄배구·컵대회 토너먼트는 대진 확정 전엔 팀 이름이 'A조 1위', '정규2위' 같은 자리표시로 온다."""
    title, rc = title or "", (round_code or "").lower()
    if "올스타" in title or "allstar" in rc or "all_star" in rc or d == ALLSTAR:
        return "allstar", "올스타전"
    if "cup" in rc or "컵" in title or CUP_START - timedelta(days=3) <= d <= CUP_END + timedelta(days=1):
        for g, mem in CUP_GROUPS.items():
            if home in mem and away in mem and d <= CUP_END - timedelta(days=2):
                return "cup", f"컵대회 {g}조"
        if d >= CUP_END:
            return "cup", "컵대회 결승"
        if d >= CUP_END - timedelta(days=1):
            return "cup", "컵대회 준결승"
        return "cup", "컵대회"
    if d > REG_END or "post" in rc:
        if d < PO_START:
            return "ps", "준플레이오프"
        if d < FINAL_START:
            return "ps", "플레이오프"
        return "ps", "챔피언결정전"
    return "regular", ""


STATE_MAP = {"BEFORE": "scheduled", "READY": "scheduled", "STARTED": "live", "PLAYING": "live",
             "RESULT": "final", "END": "final", "CANCEL": "cancel", "POSTPONED": "cancel", "SUSPENDED": "cancel"}


def to_int(v):
    try:
        return int(str(v).strip())
    except Exception:
        return None


# ---------------------------------------------------------------- 세트 점수 찾기
def find_sets(obj):
    """응답 어디에 있든 세트별 점수를 찾아 [[홈,원정], ...] 로 돌려준다.
    1) homeXxx / awayXxx 처럼 짝을 이루는 숫자 리스트
    2) [{set:1, home:25, away:22}, ...] 처럼 세트별 객체 리스트"""
    found = []

    def walk(o, depth=0):
        if depth > 7 or found:
            return
        if isinstance(o, dict):
            keys = list(o.keys())
            for hk in keys:
                if not re.search(r"home", hk, re.I) or not isinstance(o[hk], list):
                    continue
                ak = re.sub("home", "away", hk, flags=re.I)
                ak = next((k for k in keys if k.lower() == ak.lower()), None)
                if ak and isinstance(o[ak], list) and len(o[hk]) == len(o[ak]) and 3 <= len(o[hk]) <= 5 + 2:
                    h = [to_int(x if not isinstance(x, dict) else next(iter(x.values()), None)) for x in o[hk]]
                    a = [to_int(x if not isinstance(x, dict) else next(iter(x.values()), None)) for x in o[ak]]
                    pairs = [[x, y] for x, y in zip(h, a) if x is not None and y is not None and (x or y)]
                    if pairs and all(0 <= x <= 60 and 0 <= y <= 60 for x, y in pairs) and max(max(p) for p in pairs) >= 15:
                        found.append(pairs)
                        return
            for v in o.values():
                walk(v, depth + 1)
        elif isinstance(o, list):
            if 3 <= len(o) <= 5 and all(isinstance(x, dict) for x in o):
                pairs = []
                for x in o:
                    hk = next((k for k in x if re.search(r"home", k, re.I) and to_int(x[k]) is not None), None)
                    ak = next((k for k in x if re.search(r"away", k, re.I) and to_int(x[k]) is not None), None)
                    if hk and ak:
                        pairs.append([to_int(x[hk]), to_int(x[ak])])
                if len(pairs) == len(o) and max(max(p) for p in pairs) >= 15:
                    found.append(pairs)
                    return
            for v in o:
                walk(v, depth + 1)

    walk(obj)
    if not found:
        return None
    sets = [p for p in found[0] if p[0] or p[1]]  # 아직 안 한 세트(0:0) 제외
    return sets or None


# ---------------------------------------------------------------- 네이버 일정
def naver_games(d1, d2):
    js = get_json(f"{NAVER}/schedule/games", {
        "fields": "basic,schedule", "upperCategoryId": "kvolleyball", "categoryId": "kovo",
        "fromDate": d1.isoformat(), "toDate": d2.isoformat(), "size": 500,
    })
    res = js.get("result") or js
    games = res.get("games") if isinstance(res, dict) else None
    if games is None:
        raise RuntimeError("응답에 games 가 없음: " + json.dumps(js, ensure_ascii=False)[:300])
    return games


def parse_naver(g):
    home = team_kr(g.get("homeTeamName") or g.get("homeTeamShortName"))
    away = team_kr(g.get("awayTeamName") or g.get("awayTeamShortName"))
    dstr = (g.get("gameDate") or g.get("gameDateTime") or "")[:10]
    try:
        d = date.fromisoformat(dstr)
    except Exception:
        return None
    dt = g.get("gameDateTime") or ""
    tbd = g.get("timeTBD") or g.get("timeTbd")
    tm = dt[11:16] if len(dt) >= 16 and not tbd else ""
    if tm == "00:00":
        tm = ""
    code = str(g.get("statusCode") or "").upper()
    state = STATE_MAP.get(code, "scheduled")
    if g.get("cancel") is True:
        state = "cancel"
    kind, series = classify(d, home, away, g.get("title") or g.get("roundName") or "", g.get("roundCode") or "")
    placeholder = home not in TEAMS or away not in TEAMS
    sh, sa = to_int(g.get("homeTeamScore")), to_int(g.get("awayTeamScore"))
    info = (g.get("statusInfo") or "").strip()
    if state == "live":
        status = info or "경기 중"
    elif state == "final":
        status = "경기 종료"
    elif state == "cancel":
        status = info or "취소"
    else:
        status = ""
    out = {
        "gid": str(g.get("gameId") or f"{dstr}-{home}-{away}"),
        "date": dstr, "time": tm, "kind": kind, "series": series,
        "home": home, "away": away,
        "venue": "" if (kind == "ps" and placeholder) else (g.get("stadium") or "").strip() or ("여수 진남체육관" if kind in ("cup", "allstar") else VENUES.get(home, "")),
        "state": state, "status": status,
    }
    if g.get("neutralGround") or kind in ("cup", "allstar"):
        out["neutral"] = True
    if state in ("live", "final") and sh is not None and sa is not None:
        out["sh"], out["sa"] = sh, sa
    sets = find_sets(g)
    if sets:
        out["sets"] = sets
    return out


def naver_detail_sets(gid):
    """세트 점수가 목록 응답에 없으면 경기 상세에서 찾는다 (경기당 한 번만)."""
    for url in (f"{NAVER}/schedule/games/{gid}", f"{NAVER}/schedule/games/{gid}/record"):
        try:
            js = get_json(url, tries=1)
        except Exception:
            continue
        s = find_sets(js)
        if s:
            return s, js
        last = js
    return None, locals().get("last")


def collect_schedule():
    old = load("schedule.json", {}) or {}
    old_by_id = {g["gid"]: g for g in old.get("games", []) if not old.get("_seed")}
    games, months, errors = [], [], []
    start = CUP_START - timedelta(days=5)
    cur = start
    while cur <= PS_END:
        nxt = min(cur + timedelta(days=30), PS_END)
        try:
            raw = naver_games(cur, nxt)
            if raw and not os.path.exists(os.path.join(DEBUG, "naver_game_sample.json")):
                debug_dump("naver_game_sample.json", raw[:3])
            for g in raw:
                p = parse_naver(g)
                if p:
                    games.append(p)
            months.append(f"{cur}~{nxt}: {len(raw)}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{cur}~{nxt}: {e}")
        cur = nxt + timedelta(days=1)

    if errors and not games:
        STATUS["schedule"] = "실패 — 기존 일정 유지: " + errors[0][:160]
        print("[ERROR] 일정 수집 실패:", errors)
        return False

    # 세트 점수: 이미 받은 건 재사용, 새로 끝난 경기만 상세 조회 (한 번에 최대 25경기)
    budget = 25
    detail_sample_saved = os.path.exists(os.path.join(DEBUG, "naver_detail_sample.json"))
    for g in games:
        prev = old_by_id.get(g["gid"])
        # 이전에 '끝난 상태'로 받은 세트 점수만 재사용 (경기 중에 받은 건 미완성이라 다시 받음)
        if "sets" not in g and prev and prev.get("sets") and g["state"] == "final" and prev.get("state") == "final" \
                and len(prev["sets"]) == (g.get("sh") or 0) + (g.get("sa") or 0):
            g["sets"] = prev["sets"]
        if "sets" not in g and g["state"] in ("final", "live") and budget > 0:
            budget -= 1
            s, raw = naver_detail_sets(g["gid"])
            if s:
                g["sets"] = s
            if raw and not detail_sample_saved:
                debug_dump("naver_detail_sample.json", raw)
                detail_sample_saved = True

    try:
        n = save_finished_relays(games)
        if n:
            print(f"[OK] 지난 경기 문자중계 {n}경기 저장")
    except Exception as e:  # noqa: BLE001
        print("[WARN] 문자중계 저장 실패:", e)

    uniq = {g["gid"]: g for g in games}
    games = sorted(uniq.values(), key=lambda g: (g["date"], g["time"] or "99", g["home"]))
    with_sets = sum(1 for g in games if g.get("sets"))
    final = sum(1 for g in games if g["state"] == "final")
    STATUS["schedule"] = f"성공 {len(games)}경기 (종료 {final}, 세트점수 {with_sets})" + (f" · 일부 실패 {len(errors)}" if errors else "")
    print("[OK]", STATUS["schedule"], months)
    changed = save("schedule.json", {"source": "네이버 스포츠", "games": games})
    try:
        changed |= bool(build_player_stats(games))
    except Exception as e:  # noqa: BLE001
        print("[WARN] 선수 기록 집계 실패:", e)
    return changed


# ---------------------------------------------------------------- 뉴스
def detect_teams(text):
    t = text.replace(" ", "")
    hits = []
    for name, keys in {
        "대한항공": ["대한항공"], "현대캐피탈": ["현대캐피탈", "현캐"], "KB손해보험": ["KB손해보험", "KB손보"],
        "우리카드": ["우리카드"], "한국전력": ["한국전력", "한전"], "OK저축은행": ["OK저축은행", "OK금융", "읏맨"],
        "삼성화재": ["삼성화재"],
    }.items():
        if any(k.replace(" ", "") in t for k in keys):
            hits.append(name)
    return hits


LEAGUE = re.compile(r"V리그|V-리그|프로배구|KOVO|컵대회|봄배구|챔프전|남자배구|남자부")
NOISE = re.compile(r"유출|대출|예금|계좌|금리|주가|실적|보험금|해킹|고객|승진|협약|한국전력공사|전기요금|이상형|열애|결혼|예능|미녀|클럽 배구|생활체육|김연경|8구단|女배구|여자배구")
WOMEN = ["흥국생명", "현대건설", "GS칼텍스", "한국도로공사", "도로공사", "정관장", "IBK기업은행", "IBK", "SOOP", "페퍼", "여자부"]


def collect_news(limit=40):
    queries = ["V리그 남자부 when:2d", "남자배구 when:2d", "프로배구 when:2d"] + [f"{t} 배구 when:3d" for t in TEAMS]
    items, seen = [], set()
    ok = 0
    for q in queries:
        url = f"https://news.google.com/rss/search?q={quote(q)}&hl=ko&gl=KR&ceid=KR:ko"
        try:
            r = requests.get(url, headers={"User-Agent": HEADERS["User-Agent"]}, timeout=10)
            r.raise_for_status()
            root = ET.fromstring(r.content)
            ok += 1
        except Exception as e:  # noqa: BLE001
            print("[WARN] news", q, e)
            continue
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            src = (it.findtext("source") or "").strip()
            if src and title.endswith(" - " + src):
                title = title[: -len(" - " + src)]
            key = re.sub(r"\W", "", title)[:40]
            if not title or key in seen:
                continue
            teams = detect_teams(title)
            women = any(w in title for w in WOMEN)
            if NOISE.search(title) or (women and not teams):
                continue  # 은행·전력회사 사고, 연예, 여자부 기사 제외
            if not teams and not LEAGUE.search(title):
                continue  # 구단 이름도 V-리그 언급도 없으면 다른 배구(해외·아마추어) 기사
            seen.add(key)
            pub = it.findtext("pubDate") or ""
            try:
                dt = datetime.strptime(pub, "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=timezone.utc).astimezone(KST)
            except Exception:
                dt = None
            items.append({"title": title, "link": it.findtext("link") or "", "source": src,
                          "time": dt.strftime("%m/%d %H:%M") if dt else "", "ts": dt.timestamp() if dt else 0,
                          "teams": teams})
    if not ok:
        STATUS["news"] = "실패 — 기존 기사 유지"
        return False
    items.sort(key=lambda x: -x["ts"])
    cutoff = now_kst().timestamp() - 3 * 86400
    items = [i for i in items if not i["ts"] or i["ts"] >= cutoff][:limit]
    STATUS["news"] = f"성공 {len(items)}건"
    return save("news.json", {"items": items})


# ---------------------------------------------------------------- 실행
# ---------------------------------------------------------------- 문자중계 · 세트별 선발
RELAY_TYPE = {"SCORE": "S", "P_IN": "I", "P_OUT": "O", "GAME_FLAG": "F"}


def fetch_relay_set(gid, n=None):
    js = get_json(f"{NAVER}/schedule/games/{gid}/relay", {"set": n} if n else None, tries=2)
    return ((js or {}).get("result") or {}).get("textRelayData")


def compact_set(d):
    """네이버 세트 중계 → 작게 줄인 형태
    lineup: {home:[{n,p}], away:[...]}  (1~6번 = 선발, 7번~ = 리베로·교체)
    relay : [[랠리, 홈팀여부(1/0), 종류, 문장, 홈점수, 원정점수], ...]  오래된 순
            종류 S=득점 장면, T=팀 득실점, X=일반, I=교체 투입, O=교체 아웃, F=경기 시작/종료"""
    lu = d.get("lineup") or {}
    lineup = {}
    for side in ("home", "away"):
        lst = []
        for i in range(1, 15):
            name = lu.get(f"{side}PlayerName{i}")
            if not name:
                continue
            lst.append({"n": name, "p": lu.get(f"{side}PlayerPosition{i}") or ""})
        lineup[side] = lst
    rel = []
    for t in sorted(d.get("textRelays") or [], key=lambda t: (t.get("page", 0), t.get("index", 0))):
        typ = RELAY_TYPE.get(t.get("textType"), "T" if t.get("teamAction") else "X")
        home = t.get("home")
        rel.append([t.get("page", 0), 1 if home else 0 if home is False else None, typ,
                    (t.get("text") or "").strip(), t.get("homeScore", 0), t.get("awayScore", 0)])
    return {"lineup": lineup, "relay": rel}


def fetch_game_relay(gid, prev=None, final=False):
    """경기 전체 문자중계. 이미 받은 '끝난 세트'는 prev 에서 재사용."""
    latest_d = fetch_relay_set(gid)
    if not latest_d:
        return prev
    latest = int(latest_d.get("latestSet") or 1)
    sets = dict((prev or {}).get("sets") or {})
    for n in range(1, latest + 1):
        key = str(n)
        if n == latest:
            sets[key] = compact_set(latest_d if int((latest_d.get("lineup") or {}).get("set") or latest) == n
                                    else fetch_relay_set(gid, n) or {})
        elif key not in sets or not (prev or {}).get("done_sets", {}).get(key):
            d = fetch_relay_set(gid, n)
            if d:
                sets[key] = compact_set(d)
    return {"gid": gid, "latest": latest, "sets": sets, "final": final,
            "done_sets": {str(n): True for n in range(1, latest + (1 if final else 0))}}


def save_finished_relays(games, budget=8):
    """끝난 경기 문자중계를 data/games/<gid>.json 에 한 번만 저장 (지난 경기 상세용)."""
    gdir = os.path.join(DATA, "games")
    os.makedirs(gdir, exist_ok=True)
    saved = 0
    for g in sorted(games, key=lambda x: x["date"], reverse=True):
        if g["state"] != "final" or budget <= 0:
            continue
        path = os.path.join(gdir, f"{g['gid']}.json")
        if os.path.exists(path):
            continue
        budget -= 1
        try:
            r = fetch_game_relay(g["gid"], final=True)
        except Exception as e:  # noqa: BLE001
            print("[WARN] relay", g["gid"], e)
            continue
        if r and r.get("sets"):
            r.pop("done_sets", None)
            save(f"games/{g['gid']}.json", r)
            saved += 1
    return saved


# ---------------------------------------------------------------- 선수 기록 (문자중계 집계)
ATTACKS = ("퀵오픈", "백어택", "속공", "오픈", "시간차", "이동공격", "후위공격")
ERR_WORDS = ("아웃", "네트걸림", "라인오버", "오버넷", "포히트", "터치넷", "캐치볼", "더블콘텍트", "기타범실")
POS_KR = {"S": "세터", "OH": "아웃사이드 히터", "OP": "아포짓", "MB": "미들블로커", "L": "리베로"}


def classify_play(rest):
    """'퀵오픈 성공' 같은 문구 → (분류, 결과)  결과: ok / err / fail / try"""
    head, _, tail = rest.partition(" ")
    res = "ok" if tail == "성공" or tail == "정확" else "err" if tail in ERR_WORDS else "fail" if tail == "실패" else "try"
    if head in ATTACKS:
        return "atk", res
    if head in ("서브", "스파이크서브"):
        return "srv", res
    if head == "블록킹":
        return "blk", res
    if rest == "유효 블로킹":
        return "blk_eff", "ok"
    if rest == "블록킹 어시스트":
        return "blk_ast", "ok"
    if head == "디그":
        return "dig", "ok" if tail == "" else "fail"
    if head == "세트":
        return "set", res
    if head == "리시브":
        return "rcv", res
    return None, None


def build_player_stats(games):
    """data/games/*.json 문자중계로 시즌 개인 기록을 만든다.
    정규리그 경기가 하나라도 있으면 정규리그만, 없으면 컵대회 기록."""
    gdir = os.path.join(DATA, "games")
    by_id = {g["gid"]: g for g in games}
    files = []
    for f in sorted(os.listdir(gdir)) if os.path.isdir(gdir) else []:
        gid = f[:-5]
        if f.endswith(".json") and gid in by_id and by_id[gid]["state"] == "final":
            files.append((gid, by_id[gid]))
    reg = [x for x in files if x[1]["kind"] == "regular"]
    scope, use = ("정규리그", reg) if reg else ("컵대회", [x for x in files if x[1]["kind"] == "cup"])
    P = {}

    def pl(team, name):
        k = (team, name)
        if k not in P:
            P[k] = {"name": name, "team": team, "pos": collections.Counter(), "games": set(), "sets": set(),
                    "atk": 0, "atk_ok": 0, "atk_err": 0, "srv": 0, "srv_ok": 0, "srv_err": 0,
                    "blk_ok": 0, "blk_eff": 0, "blk_ast": 0, "dig_ok": 0, "dig_fail": 0,
                    "set": 0, "set_ok": 0, "rcv": 0, "rcv_ok": 0, "rcv_fail": 0}
        return P[k]

    for gid, g in use:
        try:
            R = load(f"games/{gid}.json", {}) or {}
        except Exception:
            continue
        for sn, st in (R.get("sets") or {}).items():
            sk = (gid, sn)
            for side, team in (("home", g["home"]), ("away", g["away"])):
                for x in (st.get("lineup") or {}).get(side, [])[:6]:
                    p = pl(team, x["n"]); p["sets"].add(sk); p["games"].add(gid)
                    if x.get("p"):
                        p["pos"][x["p"]] += 1
                for x in (st.get("lineup") or {}).get(side, [])[6:]:
                    if x.get("p") == "L":
                        pl(team, x["n"])["pos"]["L"] += 1
            for e in st.get("relay") or []:
                if e[1] is None:
                    continue
                team = g["home"] if e[1] == 1 else g["away"]
                name, _, rest = e[3].partition(" ")
                if e[2] in ("I",):
                    p = pl(team, e[3]); p["sets"].add(sk); p["games"].add(gid)
                    continue
                if not rest or e[2] in ("O", "F", "T"):
                    continue
                cat, res = classify_play(rest)
                if not cat:
                    continue
                p = pl(team, name); p["sets"].add(sk); p["games"].add(gid)
                if cat == "atk":
                    p["atk"] += 1; p["atk_ok"] += res == "ok"; p["atk_err"] += res == "err"
                elif cat == "srv":
                    p["srv"] += 1; p["srv_ok"] += res == "ok"; p["srv_err"] += res == "err"
                elif cat == "blk":
                    p["blk_ok"] += res == "ok"
                elif cat == "blk_eff":
                    p["blk_eff"] += 1
                elif cat == "blk_ast":
                    p["blk_ast"] += 1
                elif cat == "dig":
                    p["dig_ok"] += res == "ok"; p["dig_fail"] += res != "ok"
                elif cat == "set":
                    p["set"] += 1; p["set_ok"] += res == "ok"
                elif cat == "rcv":
                    p["rcv"] += 1; p["rcv_ok"] += res == "ok"; p["rcv_fail"] += res in ("fail", "err")

    rows = []
    for p in P.values():
        ns = len(p["sets"])
        if not ns:
            continue
        pos = p["pos"].most_common(1)[0][0] if p["pos"] else ""
        pts = p["atk_ok"] + p["blk_ok"] + p["srv_ok"]
        rows.append({**{k: v for k, v in p.items() if k not in ("pos", "games", "sets")},
                     "pos": POS_KR.get(pos, pos), "g": len(p["games"]), "s": ns, "pts": pts})
    if not rows:
        return save("players.json", {"season": SEASON, "scope": scope, "source": "", "categories": {}})
    maxs = max(r["s"] for r in rows)
    q_sets = max(1, round(maxs * 0.4))      # 세트당 순위 규정 세트
    max_atk = max(r["atk"] for r in rows) or 1
    max_rcv = max(r["rcv"] for r in rows) or 1
    pct = lambda a, b: round(a / b * 100, 1) if b else 0.0  # noqa: E731
    per = lambda a, b: round(a / b, 2) if b else 0.0  # noqa: E731

    def cat(cols, flt, key, fmt, n=30):
        lst = sorted([r for r in rows if flt(r)], key=key, reverse=True)[:n]
        return {"columns": cols, "rows": [{"name": r["name"], "team": r["team"], "pos": r["pos"], **fmt(r)} for r in lst]}

    cats = {
        "득점": cat(["경기", "세트", "득점", "공격", "블로킹", "서브"], lambda r: r["pts"] > 0, lambda r: (r["pts"], r["atk_ok"]),
                  lambda r: {"경기": r["g"], "세트": r["s"], "득점": r["pts"], "공격": r["atk_ok"], "블로킹": r["blk_ok"], "서브": r["srv_ok"]}),
        "공격": cat(["시도", "성공", "범실", "성공률"], lambda r: r["atk"] >= max(15, max_atk * 0.25), lambda r: pct(r["atk_ok"], r["atk"]),
                  lambda r: {"시도": r["atk"], "성공": r["atk_ok"], "범실": r["atk_err"], "성공률": pct(r["atk_ok"], r["atk"])}),
        "블로킹": cat(["세트", "블로킹", "유효", "어시스트", "세트당"], lambda r: r["s"] >= q_sets and r["blk_ok"] > 0, lambda r: per(r["blk_ok"], r["s"]),
                   lambda r: {"세트": r["s"], "블로킹": r["blk_ok"], "유효": r["blk_eff"], "어시스트": r["blk_ast"], "세트당": per(r["blk_ok"], r["s"])}),
        "서브": cat(["세트", "시도", "에이스", "범실", "세트당"], lambda r: r["s"] >= q_sets and r["srv"] > 0, lambda r: per(r["srv_ok"], r["s"]),
                  lambda r: {"세트": r["s"], "시도": r["srv"], "에이스": r["srv_ok"], "범실": r["srv_err"], "세트당": per(r["srv_ok"], r["s"])}),
        "디그": cat(["세트", "성공", "실패", "세트당"], lambda r: r["s"] >= q_sets and r["dig_ok"] > 0, lambda r: per(r["dig_ok"], r["s"]),
                  lambda r: {"세트": r["s"], "성공": r["dig_ok"], "실패": r["dig_fail"], "세트당": per(r["dig_ok"], r["s"])}),
        "세트": cat(["세트", "시도", "정확", "세트당"], lambda r: r["s"] >= q_sets and r["set_ok"] > 0, lambda r: per(r["set_ok"], r["s"]),
                  lambda r: {"세트": r["s"], "시도": r["set"], "정확": r["set_ok"], "세트당": per(r["set_ok"], r["s"])}),
        "리시브": cat(["시도", "정확", "실패", "효율"], lambda r: r["rcv"] >= max(15, max_rcv * 0.25),
                   lambda r: pct(r["rcv_ok"] - r["rcv_fail"], r["rcv"]),
                   lambda r: {"시도": r["rcv"], "정확": r["rcv_ok"], "실패": r["rcv_fail"], "효율": pct(r["rcv_ok"] - r["rcv_fail"], r["rcv"])}),
    }
    notes = {"공격": "성공률 = 성공 ÷ 시도 (시도 상위권만)", "블로킹": f"세트당 순위 · {q_sets}세트 이상 출전",
             "서브": f"에이스 세트당 순위 · {q_sets}세트 이상", "디그": f"세트당 순위 · {q_sets}세트 이상",
             "세트": f"정확한 세트(토스) 세트당 순위 · {q_sets}세트 이상", "리시브": "효율 = (정확 − 실패) ÷ 시도",
             "득점": "득점 = 공격 성공 + 블로킹 + 서브 에이스"}
    for k, v in cats.items():
        v["note"] = notes.get(k, "")
    # 팀별 출전 선수 (프로필 탭 보조용)
    roster = collections.defaultdict(list)
    for r in sorted(rows, key=lambda r: -r["s"]):
        roster[r["team"]].append({"name": r["name"], "pos": r["pos"], "g": r["g"], "s": r["s"], "pts": r["pts"]})
    STATUS["players"] = f"{scope} {len(use)}경기 · {len(rows)}명"
    return save("players.json", {"season": SEASON, "scope": scope, "games": len(use),
                                 "source": f"네이버 문자중계 집계 · {scope} {len(use)}경기",
                                 "categories": cats, "roster": dict(roster)})


# ---------------------------------------------------------------- 선수 프로필 (KOVO 공식 API)
KOVO_API = "https://api.kovo.co.kr"
KOVO_H = {**HEADERS, "Origin": "https://www.kovo.co.kr", "Referer": "https://www.kovo.co.kr/"}


def kovo(path):
    for i in range(3):
        try:
            r = requests.get(KOVO_API + path, headers=KOVO_H, timeout=20)
            if r.status_code == 200:
                js = r.json()
                if (js.get("result") or {}).get("status") == 200:
                    return js.get("payload")
                return None
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.5 * (i + 1))
    return None


def save_photo(code, url):
    """선수 사진을 data/photos/<코드>.<확장자> 로 저장 (이미 있으면 그대로). 사이트 주소 기준 경로를 돌려준다."""
    if not url:
        return None
    ext = os.path.splitext(url.split("?")[0])[1] or ".webp"
    rel = f"data/photos/{code}{ext}"
    path = os.path.join(ROOT, rel)
    if os.path.exists(path) and os.path.getsize(path) > 500:
        return rel
    try:
        r = requests.get(url, headers={"User-Agent": HEADERS["User-Agent"], "Referer": "https://www.kovo.co.kr/"}, timeout=20)
        if r.status_code == 200 and len(r.content) > 500 and r.headers.get("content-type", "").startswith("image"):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(r.content)
            return rel
    except Exception:  # noqa: BLE001
        pass
    return None


def collect_profiles(force=False, max_age_h=20):
    """7개 구단 선수단 + 선수별 프로필·시즌 기록·이력 → data/profiles.json (하루 1번)"""
    old = load("profiles.json", {}) or {}
    if not force and old.get("updated_at"):
        try:
            age = now_kst() - datetime.strptime(old["updated_at"], "%Y-%m-%d %H:%M").replace(tzinfo=KST)
            if age < timedelta(hours=max_age_h):
                return False
        except Exception:  # noqa: BLE001
            pass
    teams = kovo("/teams") or []
    code_of = {}
    for t in teams:
        if t.get("gender") != "MALE" or not t.get("visible"):
            continue
        ko = next((x for x in t.get("translations") or [] if x.get("languageCode") == "ko"), {})
        name = team_kr(ko.get("shortName") or ko.get("name") or "")
        if name in TEAMS and name not in code_of:
            code_of[name] = t["code"]
    if len(code_of) < 7:
        print("[WARN] KOVO 팀 코드 일부 누락:", code_of)
    if not code_of:
        STATUS["profiles"] = "실패 — 기존 프로필 유지"
        return False
    today = now_kst().date()
    out = {}
    for team, code in code_of.items():
        roster = kovo(f"/teams/{code}/players") or []
        lst = []
        for p in roster:
            if not p.get("visible", True):
                continue
            pc = p["playerCode"]
            d = kovo(f"/players/{pc}") or {}
            recs = kovo(f"/players/{pc}/season-records") or []
            hist = kovo(f"/players/{pc}/history") or []
            st = p.get("status") or []
            age = None
            try:
                b = date.fromisoformat(p.get("birthDate") or d.get("birthDate"))
                age = today.year - b.year - ((today.month, today.day) < (b.month, b.day))
            except Exception:  # noqa: BLE001
                pass
            career = []
            for r in recs[:10]:
                career.append({"season": r.get("seasonDivision"), "div": r.get("leagueDivision"),
                               "g": r.get("gameCount"), "s": r.get("setCount"), "pts": r.get("point"),
                               "atk": r.get("attackTotalSuccess"), "blk": r.get("blockingSetSuccess"),
                               "srv": r.get("serveSetSuccess"), "rcv": r.get("receiveSuccess"),
                               "dig": r.get("digSetSuccess"), "set": r.get("setSuccess")})
            img = p.get("image") or d.get("image")
            img = save_photo(pc, img) or img
            lst.append({"code": pc, "name": p.get("name"), "no": p.get("backNumber"), "pos": p.get("position") or "",
                        "birth": p.get("birthDate"), "age": age,
                        "height": d.get("height"), "weight": d.get("weight"),
                        "school": d.get("school"), "nation": d.get("nation"),
                        "foreign": "FOREIGNER" in st and "ASIS_QUARTER" not in st, "asia": "ASIS_QUARTER" in st,
                        "img": img, "career": career,
                        "history": hist[:1] + hist[-4:] if len(hist) > 5 else hist})
            time.sleep(0.15)
        lst.sort(key=lambda x: (x["no"] is None, x["no"] or 0))
        out[team] = lst
        print(f"[OK] {team} 선수 {len(lst)}명")
    if not any(out.values()):
        STATUS["profiles"] = "실패 — 기존 프로필 유지"
        return False
    STATUS["profiles"] = f"성공 {sum(len(v) for v in out.values())}명"
    return save("profiles.json", {"updated_at": now_kst().strftime("%Y-%m-%d %H:%M"), "source": "한국배구연맹(KOVO)", "teams": out})


# ---------------------------------------------------------------- 실시간 (경기 중)
def run_live():
    """오늘 경기만 받아 data/live.json 에 쓴다. 마지막 줄에 CONTINUE / STOP 출력."""
    now = now_kst()
    today = now.date()
    try:
        raw = naver_games(today, today)
    except Exception as e:  # noqa: BLE001
        print("[ERROR] live:", e)
        print("CONTINUE")
        return
    games, sample = [], None
    for g in raw:
        p = parse_naver(g)
        if not p:
            continue
        if p["state"] in ("live", "final") and "sets" not in p:
            s, det = naver_detail_sets(p["gid"])
            if s:
                p["sets"] = s
            if p["state"] == "live" and sample is None:
                sample = {"list": g, "detail": det}
        games.append(p)
    # 문자중계: 진행 중 경기는 매번, 오늘 끝난 경기는 한 번 더 받아 마무리
    cache = load("live_relay_cache.json", {}) or {}
    if cache.get("date") != today.isoformat():
        cache = {"date": today.isoformat(), "games": {}}
    for p in games:
        prev = cache["games"].get(p["gid"])
        if p["state"] == "live" or (p["state"] == "final" and not (prev or {}).get("final")):
            try:
                r = fetch_game_relay(p["gid"], prev, final=p["state"] == "final")
                if r:
                    cache["games"][p["gid"]] = r
            except Exception as e:  # noqa: BLE001
                print("[WARN] relay", p["gid"], e)
    save("live_relay_cache.json", cache)
    relay = {gid: {k: v for k, v in r.items() if k != "done_sets"} for gid, r in cache["games"].items()}
    out = {"date": today.isoformat(), "updated_at": now.strftime("%Y-%m-%d %H:%M:%S"), "games": games, "relay": relay}
    if sample:
        out["_sample"] = sample  # 진행 중 응답 구조 확인용
    save("live.json", out)
    for g in games:
        r = relay.get(g["gid"]) or {}
        n = sum(len(x.get("relay", [])) for x in (r.get("sets") or {}).values())
        print(f"  {g['time']} {g['away']} {g.get('sa', '-')}:{g.get('sh', '-')} {g['home']} [{g['state']}] {g.get('status', '')} sets={g.get('sets')} relay={n}")

    pending = [g for g in games if g["state"] not in ("final", "cancel")]
    if not pending:
        print("STOP")
        return
    if any(g["state"] == "live" for g in pending):
        print("CONTINUE")
        return
    # 아직 시작 전: 40분 안에 시작하는 경기가 있으면 계속, 아니면 다음 예약 실행에 맡김
    soon = False
    for g in pending:
        if not g["time"]:
            soon = True
            continue
        start = datetime.fromisoformat(f"{g['date']}T{g['time']}:00").replace(tzinfo=KST)
        if start - now <= timedelta(minutes=40):
            soon = True
    print("CONTINUE" if soon else "STOP")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="오늘 경기 실시간 점수만 수집 (live.json)")
    ap.add_argument("--fixture", help="네이버 응답 대신 쓸 JSON 파일 (로컬 테스트용)")
    ap.add_argument("--skip-news", action="store_true")
    ap.add_argument("--profiles", action="store_true", help="선수 프로필 강제 갱신")
    ap.add_argument("--only-profiles", action="store_true", help="선수 프로필만 받고 끝")
    args = ap.parse_args()

    if args.fixture:
        global naver_games, naver_detail_sets  # noqa: PLW0603
        fx = json.load(open(args.fixture, encoding="utf-8"))
        naver_games = lambda d1, d2: [g for g in fx if d1.isoformat() <= g["gameDate"] <= d2.isoformat()]  # noqa: E731
        naver_detail_sets = lambda gid: (None, None)  # noqa: E731

    if args.live:
        run_live()
        return
    if args.only_profiles:
        collect_profiles(force=True)
        print(STATUS)
        return

    changed = False
    changed |= bool(collect_schedule())
    if not args.skip_news:
        changed |= bool(collect_news())
    if args.profiles:
        try:
            changed |= bool(collect_profiles(force=True))
        except Exception as e:  # noqa: BLE001
            print("[WARN] 선수 프로필 실패:", e)

    meta = load("meta.json", {}) or {}
    if changed or meta.get("status") != STATUS:
        save("meta.json", {"updated_at_kst": now_kst().strftime("%Y-%m-%d %H:%M"), "season": SEASON, "status": STATUS})
        print("[OK] 변경 저장")
    else:
        print("변경 없음")
    if "실패" in STATUS.get("schedule", "") and "실패" in STATUS.get("news", "실패"):
        sys.exit(0)  # 실패해도 워크플로는 초록색으로 (다음 회차 재시도)


if __name__ == "__main__":
    main()
