"""선수 프로필 데이터 주소 탐색 (임시). 결과는 probe 브랜치."""
import json, os, re
import requests
OUT = "probe"; os.makedirs(OUT, exist_ok=True)
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
     "Accept": "*/*", "Accept-Language": "ko-KR,ko;q=0.9", "Referer": "https://m.sports.naver.com/volleyball/index"}
report = {}
def get(url, save=None, hdr=None):
    try:
        r = requests.get(url, headers={**H, **(hdr or {})}, timeout=20)
        report[url] = {"status": r.status_code, "len": len(r.text), "ct": r.headers.get("content-type", ""), "head": r.text[:300]}
        if save and r.status_code == 200:
            open(os.path.join(OUT, save), "w", encoding="utf-8").write(r.text)
        return r.status_code, r.text
    except Exception as e:
        report[url] = {"error": str(e)}; return None, ""

def scan(base, html, tag):
    paths = set()
    for src in set(re.findall(r'src="([^"]+\.js[^"]*)"', html))[:80] if False else list(set(re.findall(r'src="([^"]+\.js[^"]*)"', html)))[:80]:
        url = src if src.startswith("http") else base + src
        st, js = get(url)
        report.pop(url, None)
        for m in re.findall(r'["\'`]((?:https?://[a-z0-9.-]+)?/[A-Za-z0-9_./${}-]*(?:player|Player|roster|Roster|team|Team|member)[A-Za-z0-9_./${}?=&-]*)["\'`]', js):
            paths.add(m)
    report[f"_paths_{tag}"] = sorted(paths)[:400]

# 네이버
st, html = get("https://m.sports.naver.com/volleyball/record/kovo?seasonCode=824", save="naver_record.html")
scan("https://m.sports.naver.com", html, "naver_record")
st, html = get("https://m.sports.naver.com/team/index?category=kovo&teamCode=1005", save="naver_team.html")
scan("https://m.sports.naver.com", html, "naver_team")
API = "https://api-gw.sports.naver.com"
hdr = {"Origin": "https://m.sports.naver.com", "Accept": "application/json"}
for p in ["/team/kovo/1005/players", "/team/kovo/1005", "/teams/kovo/1005/players", "/team/players?categoryId=kovo&teamCode=1005",
          "/players?categoryId=kovo&teamCode=1005", "/statistics/categories/kovo/seasons/824/players", "/statistics/categories/kovo/seasons/824/teams",
          "/statistics/categories/kovo/seasons/824/players?sortField=point", "/player/kovo/0001873", "/players/kovo/0001873",
          "/statistics/categories/kovo/players/0001873"]:
    get(API + p, save="naverapi" + re.sub(r"\W", "_", p)[:70] + ".json", hdr=hdr)
# KOVO
st, html = get("https://www.kovo.co.kr/", save="kovo_home.html")
scan("https://www.kovo.co.kr", html, "kovo")
for u in ["https://www.kovo.co.kr/team/21110_team-player.asp?t_code=1005", "https://www.kovo.co.kr/team/21111_team-player.asp?s_part=1&t_code=1005",
          "https://www.kovo.co.kr/team/player-list?teamCode=1005", "https://www.kovo.co.kr/kovo/team/player?tcode=1005",
          "https://api.kovo.co.kr/team/players?teamCode=1005", "https://www.kovo.co.kr/team/21111_player-info.asp?p_code=0001873"]:
    get(u, save="kovo_" + re.sub(r"\W", "_", u[23:])[:60] + ".html")
json.dump(report, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
