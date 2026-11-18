"""GramPath AI: localhost-only Python backend. Use the authenticated Node gateway for requests."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from datetime import date
import argparse
import hmac
import json
import os
import sqlite3
import threading
import traceback
import webbrowser

ROOT=Path(__file__).resolve().parent
ADMIN_SECRET=os.environ.get('GRAMPATH_ADMIN_KEY','')
GATEWAY_TOKEN=os.environ.get('GRAMPATH_GATEWAY_TOKEN','')
# No admin access without an intentionally supplied/gateway-generated secret.
def admin_authorized(header):
  if not ADMIN_SECRET or not isinstance(header,str): return False
  return hmac.compare_digest(header,ADMIN_SECRET)
DB = Path(os.environ.get('GRAMPATH_DB_PATH') or ROOT / 'grampath.sqlite3')
SOURCES=[
  {'name':'Official UP scholarship portal','url':'https://scholarship.up.gov.in/','kind':'official','notes':'Final current-year rules, registration, notices and student status must be confirmed here.'},
  {'name':'UP Government budget press note, 20 Feb 2026','url':'https://information.up.gov.in/admin/UploadDocument/CmPress/compressed_25022026123402PN-CM-Vidhan%20Sabha%20Sambodhan-20%20February%2C%202026.pdf','kind':'official','notes':'Announces raising scholarship income ceiling from ₹2 lakh to ₹2.5 lakh. It does not establish implementation for every individual scheme.'},
  {'name':'myScheme: UP Fee Reimbursement Scheme','url':'https://www.myscheme.gov.in/schemes/frs','kind':'official','notes':'States ₹2 lakh for one OBC fee-reimbursement scheme; different scheme notices may differ.'},
  {'name':'UP e-District','url':'https://edistrict.up.gov.in/','kind':'official','notes':'Official government certificate services.'},
  {'name':'UP eSathi','url':'https://esathi.up.gov.in/citizenservices/login/login.aspx','kind':'official','notes':'Citizens can register and apply for e-District services and download certificates.'},
  {'name':'DigiLocker','url':'https://www.digilocker.gov.in/','kind':'official','notes':'Access issued digital documents; availability and acceptance vary.'},
  {'name':'National Scholarship Portal','url':'https://scholarships.gov.in/Students','kind':'official','notes':'Separate national scheme portal; do not confuse NSP deadlines with the UP state portal.'},
  {'name':'PFMS','url':'https://pfms.nic.in/','kind':'official','notes':'Official payment information; no live integration in this app.'},
  {'name':'2026–27 Dashmottar schedule reported Oct 6','url':'https://indianexpress.com/article/education/up-scholarship-2026-27-at-scholarship-up-gov-in-eligibility-award-amount-financial-assistance-imporant-dates-10909150/','kind':'secondary','notes':'Reported Oct 31 2026 fresh deadline, Oct 15 2026 renewal; verify later changes via official portal.'}
]
SEEDS=[
 ('up-dashmottar','UP Post-Matric Other Than Intermediate (Dashmottar)','dashmottar','Degree / diploma / B.Tech / postgraduate scholarship pathway','2026-10-31','2026-10-15',1,'https://scholarship.up.gov.in/','Post-Class 12 students. Source-reported 2026 deadlines may have changed. Institution and course must be recognised.'),
 ('up-inter','UP Post-Matric Intermediate (Class 11–12)','inter','For students enrolled in Classes 11 and 12',None,None,1,'https://scholarship.up.gov.in/','Current session dates must be confirmed on the official portal.'),
 ('up-pre','UP Pre-Matric (Class 9–10)','pre','For students enrolled in Classes 9 and 10',None,None,1,'https://scholarship.up.gov.in/','Current session dates must be confirmed on the official portal.')
]
DOCS=[
 ('income','Income certificate','all','Apply through UP e-District or eSathi; check required evidence at the issuing office.','https://esathi.up.gov.in/citizenservices/login/login.aspx',0),
 ('identity','Identity / Aadhaar details','all','Keep official identity information ready; do not share Aadhaar/OTP with this prototype.','https://www.digilocker.gov.in/',0),
 ('residence','UP residence / domicile evidence','all','Check what the selected scheme accepts and request a certificate via e-District if required.','https://edistrict.up.gov.in/',0),
 ('marksheet','Previous class / semester marksheet','all','Use your college or board-issued result or supported DigiLocker issued document.','https://www.digilocker.gov.in/',0),
 ('admission','Current admission / enrollment proof','all','Ask your institution for the valid enrollment and course details.','https://scholarship.up.gov.in/',0),
 ('fees','Fee receipt','dashmottar,inter','Check scheme instructions and keep the actual institutional fee receipt.','https://scholarship.up.gov.in/',0),
 ('photo','Recent photograph','all','Follow the image dimension and file rules shown on the official application.','https://scholarship.up.gov.in/',0),
 ('category','Applicable category certificate','category','Required where the selected scheme asks for category/community proof. EWS is not the same as OBC/SC/ST.','https://edistrict.up.gov.in/',0),
 ('bank','Bank/DBT readiness','all','Check account details and Aadhaar/NPCI mapping where the relevant payment system requires it.','https://scholarships.gov.in/Students',0),
]
RULE_SEEDS=[
 ('general',200000,250000,'https://scholarship.up.gov.in/','General category: ₹2 lakh legacy threshold; Feb 2026 state revision announced to ₹2.5 lakh, implementation requires confirmation.'),
 ('ews',200000,250000,'https://scholarship.up.gov.in/','EWS is preliminarily treated as a General applicant, not a separate guaranteed scheme. Revised limit must be verified.'),
 ('obc',200000,250000,'https://www.myscheme.gov.in/schemes/frs','myScheme UP OBC fee reimbursement lists ₹2 lakh while Feb 2026 UP state press note announces revision; confirm scheme-specific rule.'),
 ('sc',250000,250000,'https://scholarship.up.gov.in/','Frequently published SC post-matric income limit is ₹2.5 lakh. Confirm precise academic-year instructions.'),
 ('st',250000,250000,'https://scholarship.up.gov.in/','Frequently published ST post-matric income limit is ₹2.5 lakh. Confirm precise academic-year instructions.'),
 ('minority',200000,250000,'https://scholarship.up.gov.in/','Reported minority scheme baseline is ₹2 lakh; announced revision must be confirmed for this route.')
]
HELP=[
 ('How do I get an income certificate?','income','Apply through the official UP eSathi/e-District service or ask an authorised service centre. Check the exact current requirements and processing estimates on the portal.','https://esathi.up.gov.in/citizenservices/login/login.aspx'),
 ('My document was rejected','rejected','Read the rejection message, verify name, page quality, expiry and scheme-specific format. Correct only using the official portal and within its announced correction window.','https://scholarship.up.gov.in/'),
 ('How can I verify an issued document?','verify','Use the certificate issuer’s official validation route or a DigiLocker issued document, where the requesting scheme accepts it. A scan cannot establish authenticity.','https://www.digilocker.gov.in/'),
 ('Scholarship approved but no payment','payment','Use the official application portal to inspect status; check PFMS where applicable and ask the bank about DBT/NPCI mapping. Never share passwords, Aadhaar numbers or OTPs.','https://pfms.nic.in/'),
 ('I missed the deadline','deadline','Check for an official revised deadline or correction window; do not assume an extension. Contact the institute scholarship desk or competent department.','https://scholarship.up.gov.in/'),
 ('Where can I get local help?','help','Use e-District and state service-centre directories, or contact your institute. Call or verify opening hours before travelling.','https://edistrict.up.gov.in/')
]

def connect():
  cn=sqlite3.connect(DB,timeout=8)
  cn.row_factory=sqlite3.Row
  return cn

def initialize():
  with connect() as cn:
    cn.executescript('''CREATE TABLE IF NOT EXISTS schemes(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, level TEXT NOT NULL, description TEXT NOT NULL,
      fresh_deadline TEXT, renewal_deadline TEXT, active INTEGER NOT NULL DEFAULT 1,
      source_url TEXT, notes TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT,level TEXT,instructions TEXT,source_url TEXT,estimated_days INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS articles(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,tag TEXT,body TEXT,source_url TEXT);
      CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,description TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS eligibility_rules(category TEXT PRIMARY KEY, confirmed_base_cap INTEGER NOT NULL, announced_cap INTEGER NOT NULL, source_url TEXT, notes TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    ''')
    for data in SEEDS:
      cn.execute('INSERT OR IGNORE INTO schemes(id,title,level,description,fresh_deadline,renewal_deadline,active,source_url,notes) VALUES(?,?,?,?,?,?,?,?,?)',data)
    for data in RULE_SEEDS:
      cn.execute('INSERT OR IGNORE INTO eligibility_rules(category,confirmed_base_cap,announced_cap,source_url,notes) VALUES(?,?,?,?,?)',data)
    for data in DOCS:
      cn.execute('INSERT OR IGNORE INTO documents VALUES(?,?,?,?,?,?)',data)
    if cn.execute('SELECT COUNT(*) FROM articles').fetchone()[0]==0:
      cn.executemany('INSERT INTO articles(title,tag,body,source_url) VALUES(?,?,?,?)',HELP)

def rows(sql,params=()):
  with connect() as cn:
    return [dict(x) for x in cn.execute(sql,params).fetchall()]

def read_income(value):
  if value is None or (isinstance(value, str) and not value.strip()):
    return None

  message = 'Enter annual family income as a whole number from ₹0 to ₹10,00,00,000.'
  if isinstance(value, bool) or not isinstance(value, (int, float, str)):
    raise ValueError(message)
  try:
    income = float(value)
  except (ValueError, OverflowError):
    raise ValueError(message) from None
  if not income.is_integer() or not 0 <= income <= 100_000_000:
    raise ValueError(message)
  return int(income)

def check_eligibility(inp):
  category=inp.get('category','')
  level=inp.get('level','')
  domicile=inp.get('domicile','unknown')
  study=inp.get('study','unknown')
  recognised=inp.get('recognised','unknown')
  passed=inp.get('passed','unknown')
  application_type=inp.get('application_type','fresh')
  for value, options, label in (
    (category, ('', 'general', 'ews', 'obc', 'sc', 'st', 'minority'), 'category'),
    (level, ('', 'pre', 'inter', 'dashmottar'), 'course or class'),
    (domicile, ('yes', 'no', 'unknown'), 'domicile'),
    (study, ('up', 'outside', 'unknown'), 'study location'),
    (recognised, ('yes', 'no', 'unknown'), 'institution recognition'),
    (passed, ('yes', 'no', 'unknown'), 'academic progress'),
    (application_type, ('fresh', 'renewal'), 'application type'),
  ):
    if value not in options:
      raise ValueError(f'Select a valid option for {label}.')
  income = read_income(inp.get('income'))
  checks=[]
  def add(name,status,reason): checks.append({'name':name,'status':status,'reason':reason})
  if category in ('general','ews','obc','sc','st','minority'):
    add('Category','pass','EWS is assessed provisionally on the General route, not as a separate guaranteed scholarship category.' if category=='ews' else 'Covered by one of the general published scholarship categories.')
  else: add('Category','unknown','Select the applicable government category.')
  add('UP domicile','pass' if domicile=='yes' else 'fail' if domicile=='no' else 'unknown', 'UP domicile is usually required. Verify any special outside-state rules separately.')
  add('Study location','pass' if study=='up' else 'unknown','The checker covers study within UP. Outside-UP applications have separate scheme-specific requirements.' if study!='up' else 'You indicated that you study in Uttar Pradesh.')
  add('Course / class','pass' if level in ('pre','inter','dashmottar') else 'unknown', {'pre':'Class 9–10 (pre-matric).','inter':'Class 11–12 (post-matric intermediate).','dashmottar':'Post-Class 12 study (Dashmottar).'} .get(level,'Choose your current academic level.'))
  add('Recognised institution','pass' if recognised=='yes' else 'fail' if recognised=='no' else 'unknown','The college and course must meet the relevant scheme / portal recognition rules.')
  add('Academic progress','pass' if passed=='yes' else 'fail' if passed=='no' else 'unknown','You must satisfy previous exam / progression requirements for your scheme.')
  # Income limits are stored as source-linked, updateable SQLite records.
  # The screening is conservative where 2026-announced revisions are not clearly implemented.
  rule_rows=rows('SELECT * FROM eligibility_rules WHERE category=?',(category,))
  rule=rule_rows[0] if rule_rows else None
  cap_strict=rule['confirmed_base_cap'] if rule else 200000
  cap_announced=rule['announced_cap'] if rule else 250000
  if income is None:
    add('Annual family income','unknown','Enter a non-negative annual family income (₹).')
  elif income<=cap_strict:
    add('Annual family income','pass',f'₹{income:,.0f} is within the baseline ₹{cap_strict:,.0f}. Check final scheme requirements.')
  elif income<=cap_announced:
    add('Annual family income','unknown',f'₹{income:,.0f} exceeds the baseline ₹{cap_strict:,.0f} but is within the announced ₹{cap_announced:,.0f} ceiling. Please verify implementation for this specific category.')
  else:
    add('Annual family income','fail',f'₹{income:,.0f} is above the ₹{cap_announced:,.0f} upper limit in the currently stored scheme information. Other exceptional routes may exist.')
  scheme=rows('SELECT * FROM schemes WHERE level=? AND active=1 ORDER BY id LIMIT 1',(level,))
  scheme=scheme[0] if scheme else None
  deadline=None
  if scheme:
    deadline=scheme['renewal_deadline'] if application_type=='renewal' else scheme['fresh_deadline']
  if deadline:
    days=(date.fromisoformat(deadline)-date.today()).days
    date_note=f'Published/reported {application_type} deadline: {deadline} ({days} day(s) relative to this computer’s date). Verify on official portal for revisions.'
  else:
    days=None
    date_note='No verified 2026–27 deadline is stored for this path; check the official notice.'
  # Deadlines affect submission timing, not academic/income eligibility.
  add('Application timing','unknown' if days is None else ('unknown' if days<0 else 'pass'), date_note)
  statuses=[x['status'] for x in checks if x['name']!='Application timing']
  if 'fail' in statuses:
    status='unlikely'
    heading='Likely not eligible under the standard path'
  elif 'unknown' in statuses:
    status='review'
    heading='Needs official verification'
  else:
    status='likely'
    heading='Meets the checked basic conditions'
  actions=[]
  for x in checks:
    if x['status']!='pass': actions.append(x['reason'])
  if not actions: actions=['Read the current official instructions, prepare the documents, and apply through the government portal.']
  return {'status':status,'heading':heading,'checks':checks,'actions':actions,'scheme':scheme,'days_to_deadline':days,
    'income_review_band':[cap_strict,cap_announced], 'income_rule':rule,
    'disclaimer':'This is a preliminary rule-based screening tool, NOT an official eligibility decision, approval or payment guarantee. Final rules and deadlines must be confirmed at scholarship.up.gov.in.',
    'source_urls':['https://scholarship.up.gov.in/','https://www.myscheme.gov.in/schemes/frs',SOURCES[1]['url']]}

def documents_for(level,category):
  docs=rows('SELECT * FROM documents ORDER BY rowid')
  found=[]
  for d in docs:
    if d['level']=='all' or level in d['level'].split(',') or (d['level']=='category' and category in ('obc','sc','st','minority')):
      found.append(d)
  return found

class Handler(BaseHTTPRequestHandler):
  server_version='GramPath/2.1'
  def gateway_ok(self):
    supplied=self.headers.get('X-GramPath-Gateway','')
    return bool(GATEWAY_TOKEN and supplied and hmac.compare_digest(supplied,GATEWAY_TOKEN))
  def log_message(self,fmt,*args):
    # Avoid logging query parameters or eligibility inputs. No personal documents are uploaded.
    print('[GramPath] request processed')
  def reply(self,data,status=200):
    raw=json.dumps(data,ensure_ascii=False,default=str).encode('utf8')
    self.send_response(status)
    self.send_header('Content-Type','application/json; charset=utf-8')
    self.send_header('Cache-Control','no-store')
    self.send_header('X-Content-Type-Options','nosniff')
    self.send_header('Content-Length',str(len(raw)))
    self.end_headers();self.wfile.write(raw)
  def body(self):
    length=int(self.headers.get('Content-Length','0'))
    if length<0 or length>20000: raise ValueError('Request too large')
    payload=json.loads(self.rfile.read(length) or b'{}')
    if not isinstance(payload,dict): raise ValueError('Expected a JSON object')
    return payload
  def do_GET(self):
    if not self.gateway_ok(): return self.reply({'error':'Gateway authorization required'},403)
    path=urlsplit(self.path).path
    q=parse_qs(urlsplit(self.path).query)
    try:
      if path.startswith('/api/admin/') and not admin_authorized(self.headers.get('X-GramPath-Admin')):
        return self.reply({'error':'Admin key required'},403)
      if path=='/api/health':return self.reply({'ok':True,'database':'SQLite','date':str(date.today()),'scheme_count':len(rows('SELECT id FROM schemes')),'mode':'secured dynamic','admin_enabled':os.environ.get('GRAMPATH_ENABLE_ADMIN')=='true'})
      if path=='/api/schemes':
        data=rows('SELECT * FROM schemes WHERE active=1 ORDER BY level,title')
        search=q.get('q',[''])[0].lower()
        if search:data=[x for x in data if search in (x['title']+' '+x['description']).lower()]
        return self.reply({'schemes':data,'count':len(data)})
      if path=='/api/documents':return self.reply({'documents':documents_for(q.get('level',['dashmottar'])[0],q.get('category',['general'])[0])})
      if path=='/api/articles':return self.reply({'articles':rows('SELECT * FROM articles ORDER BY id')})
      if path=='/api/sources':return self.reply({'sources':SOURCES})
      if path=='/api/admin/schemes':return self.reply({'schemes':rows('SELECT * FROM schemes ORDER BY id')})
      if path=='/api/admin/rules':return self.reply({'rules':rows('SELECT * FROM eligibility_rules ORDER BY category')})
      if path=='/api/admin/feedback':return self.reply({'feedback':rows('SELECT * FROM feedback ORDER BY id DESC LIMIT 30')})
      return self.reply({'error':'Endpoint not found'},404)
    except Exception as ex:
      traceback.print_exc();return self.reply({'error':str(ex)},500)
  def do_POST(self):
    if not self.gateway_ok(): return self.reply({'error':'Gateway authorization required'},403)
    p=urlsplit(self.path).path
    try:
      if p.startswith('/api/admin/') and not admin_authorized(self.headers.get('X-GramPath-Admin')):
        return self.reply({'error':'Admin key required'},403)
      body=self.body()
      if p=='/api/eligibility': return self.reply(check_eligibility(body))
      if p=='/api/admin/schemes':
        ident=body.get('id','').strip()
        if not ident or len(ident)>60 or not all(c.isalnum() or c in '-_' for c in ident): return self.reply({'error':'Use a short alphanumeric id, hyphens or underscores.'},400)
        if body.get('level') not in ('pre','inter','dashmottar'):return self.reply({'error':'Invalid level'},400)
        title=str(body.get('title','')).strip()[:180]
        if not title:return self.reply({'error':'Title required'},400)
        vals=(ident,title,body['level'],str(body.get('description',''))[:400],body.get('fresh_deadline') or None,body.get('renewal_deadline') or None,1,str(body.get('source_url',''))[:600],str(body.get('notes',''))[:500])
        for dt in vals[4:6]:
          if dt:date.fromisoformat(dt)
        with connect() as cn:
          cn.execute('''INSERT INTO schemes(id,title,level,description,fresh_deadline,renewal_deadline,active,source_url,notes) VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,level=excluded.level,description=excluded.description,fresh_deadline=excluded.fresh_deadline,renewal_deadline=excluded.renewal_deadline,source_url=excluded.source_url,notes=excluded.notes,active=1,updated_at=CURRENT_TIMESTAMP''',vals)
        return self.reply({'ok':True,'scheme_id':ident})
      if p=='/api/admin/rules':
        cat=str(body.get('category','')).strip()
        if cat not in [x[0] for x in RULE_SEEDS]:return self.reply({'error':'Invalid category'},400)
        low=int(body.get('confirmed_base_cap'))
        high=int(body.get('announced_cap'))
        if low<0 or high<low or high>10000000:return self.reply({'error':'Invalid income ceilings'},400)
        url=str(body.get('source_url',''))[:600]
        if not url.startswith('https://'):return self.reply({'error':'Provide an HTTPS official source URL'},400)
        notes=str(body.get('notes','')).strip()[:700]
        if not notes:return self.reply({'error':'Add source notes identifying the verified policy'},400)
        with connect() as cn:
          cn.execute('UPDATE eligibility_rules SET confirmed_base_cap=?,announced_cap=?,source_url=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE category=?',(low,high,url,notes,cat))
        return self.reply({'ok':True})
      if p=='/api/feedback':
        kind=str(body.get('kind','issue'))[:40]; description=str(body.get('description','')).strip()[:1000]
        if not description:return self.reply({'error':'Write some feedback.'},400)
        with connect() as cn:cn.execute('INSERT INTO feedback(kind,description) VALUES(?,?)',(kind,description))
        return self.reply({'ok':True})
      return self.reply({'error':'Endpoint not found'},404)
    except (ValueError,TypeError,sqlite3.Error) as e:return self.reply({'error':str(e)},400)
    except Exception as e:traceback.print_exc();return self.reply({'error':str(e)},500)

if __name__=='__main__':
  parser=argparse.ArgumentParser()
  parser.add_argument('--port',type=int,default=8000)
  parser.add_argument('--no-browser',action='store_true')
  args=parser.parse_args()
  if not GATEWAY_TOKEN:
    raise SystemExit('This internal backend must be launched by gateway.js, not directly. Run npm start.')
  initialize()
  url=f'http://127.0.0.1:{args.port}'
  print('\n'+'='*50+'\nGramPath AI – dynamic edition\nOpen: '+url+'\nSQLite: '+str(DB)+'\nCtrl+C to stop\n'+'='*50+'\n')
  if not args.no_browser:threading.Timer(0.8,lambda:webbrowser.open(url)).start()
  ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
