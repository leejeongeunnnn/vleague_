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
    return found[0] if found else None


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
        if "sets" not in g and prev and prev.get("sets") and g["state"] == "final":
            g["sets"] = prev["sets"]
        if "sets" not in g and g["state"] in ("final", "live") and budget > 0:
            budget -= 1
            s, raw = naver_detail_sets(g["gid"])
            if s:
                g["sets"] = s
            if raw and not detail_sample_saved:
                debug_dump("naver_detail_sample.json", raw)
                detail_sample_saved = True

    uniq = {g["gid"]: g for g in games}
    games = sorted(uniq.values(), key=lambda g: (g["date"], g["time"] or "99", g["home"]))
    with_sets = sum(1 for g in games if g.get("sets"))
    final = sum(1 for g in games if g["state"] == "final")
    STATUS["schedule"] = f"성공 {len(games)}경기 (종료 {final}, 세트점수 {with_sets})" + (f" · 일부 실패 {len(errors)}" if errors else "")
    print("[OK]", STATUS["schedule"], months)
    return save("schedule.json", {"source": "네이버 스포츠", "games": games})


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
    out = {"date": today.isoformat(), "updated_at": now.strftime("%Y-%m-%d %H:%M:%S"), "games": games}
    if sample:
        out["_sample"] = sample  # 진행 중 응답 구조 확인용
    save("live.json", out)
    for g in games:
        print(f"  {g['time']} {g['away']} {g.get('sa', '-')}:{g.get('sh', '-')} {g['home']} [{g['state']}] {g.get('status', '')} sets={g.get('sets')}")

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
    args = ap.parse_args()

    if args.fixture:
        global naver_games, naver_detail_sets  # noqa: PLW0603
        fx = json.load(open(args.fixture, encoding="utf-8"))
        naver_games = lambda d1, d2: [g for g in fx if d1.isoformat() <= g["gameDate"] <= d2.isoformat()]  # noqa: E731
        naver_detail_sets = lambda gid: (None, None)  # noqa: E731

    if args.live:
        run_live()
        return

    changed = False
    changed |= bool(collect_schedule())
    if not args.skip_news:
        changed |= bool(collect_news())

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
