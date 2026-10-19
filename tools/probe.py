"""네이버 배구 문자중계·라인업 API 주소 탐색 (한 번 쓰고 지우는 도구).
결과는 probe/ 폴더에 저장 → probe 브랜치로 푸시."""
import json, os, re, sys
import requests

GID = sys.argv[1]
OUT = "probe"
os.makedirs(OUT, exist_ok=True)
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
     "Accept": "application/json, text/plain, */*", "Referer": f"https://m.sports.naver.com/game/{GID}/relay",
     "Origin": "https://m.sports.naver.com", "Accept-Language": "ko-KR,ko;q=0.9"}
API = "https://api-gw.sports.naver.com"
report = {}

def get(url, save=None):
    try:
        r = requests.get(url, headers=H, timeout=15)
        body = r.text
        report[url] = {"status": r.status_code, "len": len(body), "head": body[:400]}
        if save and r.status_code == 200:
            open(os.path.join(OUT, save), "w", encoding="utf-8").write(body)
        return r.status_code, body
    except Exception as e:
        report[url] = {"error": str(e)}
        return None, ""

# 1) 웹페이지와 JS 묶음에서 API 경로 찾기
found_paths = set()
for tab in ("relay", "lineup", "record", "preview", ""):
    st, html = get(f"https://m.sports.naver.com/game/{GID}/{tab}".rstrip("/"), save=f"page_{tab or 'base'}.html")
    for m in re.findall(r'["\'`](/schedule/games/[^"\'`\s]{0,120})', html):
        found_paths.add(m)
    scripts = set(re.findall(r'src="([^"]+\.js)"', html))
    for src in list(scripts)[:60]:
        url = src if src.startswith("http") else "https://m.sports.naver.com" + src
        try:
            js = requests.get(url, headers=H, timeout=15).text
        except Exception:
            continue
        for m in re.findall(r'["\'`](/schedule/games/[^"\'`\s]{0,120})', js):
            found_paths.add(m)
        for m in re.findall(r'["\'`]([^"\'`\s]{0,60}(?:relay|lineup|textRelay|text-relay)[^"\'`\s]{0,80})["\'`]', js):
            if "/" in m:
                found_paths.add("JS:" + m)
report["_found_paths"] = sorted(found_paths)

# 2) 후보 주소 직접 시도
cands = ["relay", "relay?set=1", "relay?setNo=1", "relay?inning=1", "relays", "text-relay", "textRelay",
         "lineup", "lineups", "starting-lineup", "record", "records", "preview", "game-record", "player-record"]
for c in cands:
    get(f"{API}/schedule/games/{GID}/{c}", save="api_" + re.sub(r"\W", "_", c) + ".json")
for p in sorted(found_paths):
    if p.startswith("/schedule/games/"):
        u = API + p.replace("${gameId}", GID).replace("{gameId}", GID)
        if "${" not in u and u not in report:
            get(u, save="found_" + re.sub(r"\W", "_", p)[:60] + ".json")

json.dump(report, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps({k: (v.get("status"), v.get("len")) if isinstance(v, dict) else v for k, v in report.items()}, ensure_ascii=False, indent=1))
