import json, requests

body = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
        "name": "search",
        "arguments": {"query": "资本下乡 城乡融合", "limit": 2},
    },
}

r = requests.post(
    "http://127.0.0.1:8000/mcp",
    json=body,
    headers={"Accept": "application/json, text/event-stream"},
    timeout=30,
)
print("Status:", r.status_code)
for line in r.text.splitlines():
    if line.startswith("data:"):
        d = json.loads(line[5:])
        print(json.dumps(d, indent=2, ensure_ascii=False)[:600])
