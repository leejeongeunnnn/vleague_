import json, os, requests
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
H={"User-Agent":UA,"Origin":"https://www.kovo.co.kr","Referer":"https://www.kovo.co.kr/","Accept-Language":"ko"}
B="https://api.kovo.co.kr"
os.makedirs("out",exist_ok=True)
def g(name,path,params=None):
    try:
        r=requests.get(B+path,params=params,headers=H,timeout=20)
        print(name,r.status_code,len(r.text),r.url)
        open(f"out/{name}.json","w").write(r.text)
    except Exception as e:
        print(name,"ERR",e)
base={"season":"023","round":1,"gnum":19,"gcode":"001","hcode":"1009","acode":"1001","page":0,"size":10000,"sort":["ids.rPage,ASC","ids.rIndex,ASC"]}
g("rt","/stat/real-time",base)
g("rt_set1","/stat/real-time",{**base,"rset":1})
g("detail","/stat/game-schedule/19",{"gcode":"001","seasonCode":"023","leagueCode":"201","gender":"1","round":1,"tcode":"1009","acode":"1001","gdate":"2026-11-11"})
g("vp","/stat/view-point",{"gnum":19,"gcode":"001","seasonCode":"023","hcode":"1009","acode":"1001"})
g("stats_games","/stats/games",{"gcode":"001","seasonCode":"023","gnum":19})
g("gs_cup","/stat/game-schedule",{"gcode":"001","seasonCode":"024","gender":"1","page":0,"size":200})
