"""Local backend tests (standard Python library only; does not test installed Node packages)."""
from pathlib import Path
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.error, socket
SRC=Path(__file__).resolve().parents[1]/'server.py'

def request(url, method='GET', body=None, admin=False, gateway=True):
  headers={'Content-Type':'application/json'}
  if gateway: headers['X-GramPath-Gateway']='test-private-tunnel'
  if admin: headers['X-GramPath-Admin']='test-admin-secret'
  data=json.dumps(body).encode() if body is not None else None
  try:
    with urllib.request.urlopen(urllib.request.Request(url,data=data,headers=headers,method=method),timeout=3) as r:
      return r.status,json.loads(r.read())
  except urllib.error.HTTPError as e:
    return e.code,json.loads(e.read())

with tempfile.TemporaryDirectory() as folder:
  shutil.copy2(SRC,Path(folder)/'server.py')
  listener=socket.socket(); listener.bind(('127.0.0.1',0)); port=listener.getsockname()[1];listener.close()
  proc=subprocess.Popen([sys.executable,'-u','server.py','--port',str(port),'--no-browser'],cwd=folder,env={**os.environ,'GRAMPATH_GATEWAY_TOKEN':'test-private-tunnel','GRAMPATH_ADMIN_KEY':'test-admin-secret','GRAMPATH_ENABLE_ADMIN':'true'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  try:
    base=f'http://127.0.0.1:{port}'
    for _ in range(50):
      try:
        if request(base+'/api/health')[0]==200:break
      except Exception:time.sleep(.1)
    else:raise AssertionError('Backend did not start')
    assert request(base+'/api/health',gateway=False)[0]==403,'Must reject direct requests'
    assert request(base+'/server.py')[0]==404,'Must not expose source code'
    assert request(base+'/grampath.sqlite3')[0]==404,'Must not expose database'
    assert request(base+'/api/admin/schemes')[0]==403,'Must reject unauthorized admin'
    template={'category':'ews','level':'dashmottar','domicile':'yes','study':'up','recognised':'yes','passed':'yes','application_type':'fresh'}
    for income,status in ((150000,'likely'),(225000,'review'),(400000,'unlikely')):
      code,data=request(base+'/api/eligibility','POST',{**template,'income':income})
      assert code==200 and data['status']==status,(code,data)
    assert request(base+'/api/eligibility','POST',{**template,'domicile':'no','income':150000})[1]['status']=='unlikely'
    changed={'id':'test-record','level':'dashmottar','title':'Editable real SQLite record','description':'Smoke test','source_url':'https://scholarship.up.gov.in/','notes':'Test only'}
    assert request(base+'/api/admin/schemes','POST',changed,admin=True)[0]==200
    assert any(i['id']=='test-record' for i in request(base+'/api/schemes')[1]['schemes'])
    print('PASS: eligibility changes with inputs, SQLite updates persist, private API and admin authorization work.')
  finally:
    proc.terminate()
    try:proc.wait(timeout=4)
    except subprocess.TimeoutExpired:proc.kill()
