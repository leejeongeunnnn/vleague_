"""KOVO 예매 경로 찾기 (임시)."""
import json, os, re, requests
OUT = "probe"; os.makedirs(OUT, exist_ok=True)
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
     "Accept-Language": "ko-KR,ko;q=0.9"}
rep = {}
html = requests.get("https://www.kovo.co.kr/", headers=H, timeout=20).text
srcs = re.findall(r'(?:src|href)="([^"]+\.js)"', html)
seen, queue, hits = set(), list(srcs), set()
while queue and len(seen) < 120:
    s = queue.pop(0)
    url = s if s.startswith("http") else "https://www.kovo.co.kr" + (s if s.startswith("/") else "/" + s)
    if url in seen:
        continue
    seen.add(url)
    try:
        js = requests.get(url, headers=H, timeout=20).text
    except Exception:
        continue
    for m in re.findall(r'["\'`](\.?/?assets/[A-Za-z0-9_.-]+\.js)["\'`]', js):
        queue.append("/" + m.lstrip("./"))
    for m in re.findall(r'["\'`]([^"\'`\n]{0,80}(?:ticket|Ticket|TICKET|reserv|Reserv|booking|ticketlink)[^"\'`\n]{0,120})["\'`]', js):
        hits.add(m)
rep["_js_count"] = len(seen)
rep["_hits"] = sorted(hits)[:500]
H2 = {**H, "Origin": "https://www.kovo.co.kr", "Referer": "https://www.kovo.co.kr/", "Accept": "application/json"}
for p in ["/tickets", "/ticket", "/tickets/games", "/games/tickets", "/ticket/link", "/tickets/teams", "/teams/1005/ticket", "/teams/1005"]:
    try:
        r = requests.get("https://api.kovo.co.kr" + p, headers=H2, timeout=20)
        rep["api" + p] = [r.status_code, r.text[:600]]
    except Exception as e:
        rep["api" + p] = str(e)
json.dump(rep, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
