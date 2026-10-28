"""티켓링크 배구 구단 페이지 주소 형식 확인 (임시)."""
import json, os, re, requests
OUT = "probe"; os.makedirs(OUT, exist_ok=True)
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
     "Accept-Language": "ko-KR,ko;q=0.9"}
rep = {}
def get(url, save=None):
    try:
        r = requests.get(url, headers=H, timeout=20, allow_redirects=True)
        t = r.text
        title = re.search(r"<title>(.*?)</title>", t, re.S)
        og = re.search(r'property="og:title" content="([^"]*)"', t)
        links = sorted(set(re.findall(r'(/sports/[A-Za-z0-9_/-]{2,60})', t)))[:80]
        rep[url] = {"status": r.status_code, "final": r.url, "len": len(t), "title": title.group(1).strip()[:120] if title else None,
                    "og": og.group(1) if og else None, "links": links,
                    "team_hits": [w for w in ("현대캐피탈", "스카이워커스", "대한항공", "점보스", "우리카드", "배구") if w in t]}
        if save: open(os.path.join(OUT, save), "w", encoding="utf-8").write(t)
    except Exception as e:
        rep[url] = {"error": str(e)}
get("https://www.ticketlink.co.kr/sports/volleyball/event/176", "event176.html")
get("https://www.ticketlink.co.kr/sports/volleyball", "volley.html")
get("https://www.ticketlink.co.kr/sports", "sports.html")
for c in range(136, 150):
    get(f"https://www.ticketlink.co.kr/sports/{c}/133")
for u in ["https://mapi.ticketlink.co.kr/mapi/sports/teams/133", "https://mapi.ticketlink.co.kr/mapi/sports/team/133",
          "https://www.ticketlink.co.kr/sports/volleyball/133", "https://m.ticketlink.co.kr/sports/volleyball/133"]:
    get(u)
# 홈 HTML·JS에서 스포츠 경로 규칙 찾기
st = rep.get("https://www.ticketlink.co.kr/sports", {})
try:
    html = open(os.path.join(OUT, "sports.html"), encoding="utf-8").read()
    js_urls = [u if u.startswith("http") else "https://www.ticketlink.co.kr" + u for u in re.findall(r'src="([^"]+\.js[^"]*)"', html)][:40]
    hits = set()
    for u in js_urls:
        try:
            js = requests.get(u, headers=H, timeout=20).text
            for m in re.findall(r'["\'`]([^"\'`]{0,40}(?:volleyball|VOLLEYBALL|categoryId|sportsTeam|/sports/)[^"\'`]{0,80})["\'`]', js):
                hits.add(m)
        except Exception:
            pass
    rep["_js_hits"] = sorted(hits)[:300]
except Exception as e:
    rep["_js_err"] = str(e)
json.dump(rep, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
