"""Dependency-free O-D-A JSON-RPC 2.0 starter. Stdout is protocol-only."""
import json, pathlib, sys
MANIFEST=json.loads((pathlib.Path(__file__).parent/"plugin-manifest.json").read_text(encoding="utf-8"))
def handle(method, params):
    if method=="plugin.getManifest": return MANIFEST
    if method=="plugin.healthCheck": return {"status":"READY","network":"broker-only"}
    if method=="plugin.normalizePayload":
        value=params.get("input",{}).get("identifier","FIXTURE-1")
        return {"externalId":value,"key":value}
    raise ValueError("Method not implemented by starter")
for line in sys.stdin:
    try:
        request=json.loads(line); result=handle(request["method"],request.get("params",{}))
        response={"jsonrpc":"2.0","id":request["id"],"result":result}
    except Exception as error:
        response={"jsonrpc":"2.0","id":request.get("id","unknown"),"error":{"code":-32601,"message":str(error)}}
    print(json.dumps(response,separators=(",",":")),flush=True)
