import json, os, requests
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
H={"User-Agent":UA,"Origin":"https://www.kovo.co.kr","Referer":"https://www.kovo.co.kr/","Accept-Language":"ko"}
B="https://api.kovo.co.kr"
os.makedirs("out",exist_ok=True)
def g(name,path,params=None):
    try:
        r=requests.get(B+path,params=params,headers=H,timeout=20)
        txt=r.text
        print(name,r.status_code,len(txt),r.url)
        open(f"out/{name}.json","w").write(txt)
        return r.json()
    except Exception as e:
        print(name,"ERR",e); return None
g("main_season","/main/game/season")
g("mains_sched","/mains/games/schedules",{"gender":"MALE"})
g("mains_ended","/mains/games/schedules/ended",{"gender":"MALE"})
g("season_list","/stat/season-list",{"gcode":"001"})
g("bcast","/stat/broadcaster")
for p in [{"gcode":"001","seasonCode":"023","gender":"1","page":0,"size":200},
          {"gcode":"001","gender":"1","page":0,"size":200}]:
    g("gs_"+p.get("seasonCode","none"),"/stat/game-schedule",p)
