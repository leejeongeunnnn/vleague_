"""KOVO API 응답 확인 (임시)."""
import json, os, re, requests
OUT = "probe"; os.makedirs(OUT, exist_ok=True)
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
     "Accept": "application/json, text/plain, */*", "Accept-Language": "ko-KR,ko;q=0.9",
     "Origin": "https://www.kovo.co.kr", "Referer": "https://www.kovo.co.kr/"}
rep = {}
def get(path, save):
    url = "https://api.kovo.co.kr" + path
    try:
        r = requests.get(url, headers=H, timeout=25)
        rep[url] = {"status": r.status_code, "len": len(r.text), "head": r.text[:500]}
        open(os.path.join(OUT, save + ".json"), "w", encoding="utf-8").write(r.text)
    except Exception as e:
        rep[url] = {"error": str(e)}
for p, n in [("/teams", "teams"), ("/teams?gender=MALE", "teams_male"), ("/teams/1005/players", "t1005"),
             ("/teams/1005/players?gender=MALE", "t1005g"), ("/players/0001873", "p_hsb"), ("/players/0001873?lang=ko", "p_hsb_ko"),
             ("/players/0001873/season-records", "p_hsb_season"), ("/players/0001873/history", "p_hsb_hist"),
             ("/players/1000639", "p_jang"), ("/stats/players?season=022&league=201&round=0&gender=MALE", "stats")]:
    get(p, n)
json.dump(rep, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
