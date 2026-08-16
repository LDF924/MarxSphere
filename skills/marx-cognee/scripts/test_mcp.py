import json, requests, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

r = requests.post('http://127.0.0.1:8001/mcp',
    json={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'t','version':'1'}}},
    headers={'Accept':'application/json, text/event-stream'})
sid = r.headers.get('Mcp-Session-Id','')
print('Session:', sid)

r2 = requests.post('http://127.0.0.1:8001/mcp',
    json={'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}},
    headers={'Accept':'application/json, text/event-stream','Mcp-Session-Id':sid})

for line in r2.text.splitlines():
    if line.startswith('data:'):
        d = json.loads(line[5:])
        tools = d.get('result',{}).get('tools',[])
        for t in tools:
            print(f"  {t['name']}: {t['description']}")
