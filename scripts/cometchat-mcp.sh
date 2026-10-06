#!/bin/bash
# Minimal client for the official CometChat Docs MCP server (https://mcp.cometchat.com/mcp).
# usage: scripts/cometchat-mcp.sh tools/call '{"name":"list_cometchat_bundles","arguments":{}}'
U=https://mcp.cometchat.com/mcp
SID=$(curl -s -m 20 -X POST $U -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -D - -o /dev/null -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"cc","version":"1"}}}' | grep -i mcp-session-id | awk '{print $2}' | tr -d '\r')
curl -s -m 20 -X POST $U -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
curl -s -m 60 -X POST $U -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SID" -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"$1\",\"params\":$2}" | sed -n 's/^data: //p' | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
r=d.get("result",d)
if "content" in r:
  for c in r["content"]: print(c.get("text",c))
elif "contents" in r:
  for c in r["contents"]: print(c.get("text",c))
else: print(json.dumps(r,indent=1))'
