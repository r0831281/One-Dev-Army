import json, pathlib, subprocess, sys
root=pathlib.Path(__file__).parent
requests="\n".join(json.dumps(x) for x in [
 {"jsonrpc":"2.0","id":"1","method":"plugin.getManifest","params":{}},
 {"jsonrpc":"2.0","id":"2","method":"plugin.normalizePayload","params":{"input":{"identifier":"FIXTURE-1"}}}
])+"\n"
run=subprocess.run([sys.executable,str(root/"plugin.py")],input=requests,text=True,capture_output=True,check=True)
rows=[json.loads(line) for line in run.stdout.splitlines()]
passed=rows[0]["result"]["protocolRange"]=="^1.0.0" and rows[1]["result"]["key"]=="FIXTURE-1"
print(json.dumps({"protocolVersion":"1.0","passed":passed,"network":"disabled"}))
raise SystemExit(0 if passed else 1)
