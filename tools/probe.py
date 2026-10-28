"""티켓링크 코드 확인 (임시): KOVO ticketLinkTeamCode 와 실제 티켓링크 팀 페이지 비교."""
import json, os, re, requests
OUT = "probe"; os.makedirs(OUT, exist_ok=True)
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
     "Accept-Language": "ko-KR,ko;q=0.9"}
rep = {"teams": [], "pages": {}}
t = requests.get("https://api.kovo.co.kr/teams", headers={**H, "Origin": "https://www.kovo.co.kr", "Referer": "https://www.kovo.co.kr/"}, timeout=20).json()["payload"]
for x in t:
    if not x.get("visible") or not x.get("ticketLinkTeamCode"):
        continue
    ko = next((y for y in x.get("translations") or [] if y.get("languageCode") == "ko"), {})
    rep["teams"].append([x["code"], x.get("gender"), ko.get("shortName"), x.get("ticketLinkTeamCode")])
for code in sorted({r[3] for r in rep["teams"]}):
    for base in ("https://www.ticketlink.co.kr/sports/volleyball/", "https://m.ticketlink.co.kr/sports/volleyball/"):
        try:
            r = requests.get(base + str(code), headers=H, timeout=20, allow_redirects=False)
            rep["pages"][base + str(code)] = [r.status_code, r.headers.get("location"), len(r.text)]
        except Exception as e:
            rep["pages"][base + str(code)] = str(e)
json.dump(rep, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
