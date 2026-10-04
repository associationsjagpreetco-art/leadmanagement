const express=require('express'),XLSX=require('xlsx'),{DatabaseSync}=require('node:sqlite'),path=require('path');
const db=new DatabaseSync(process.env.DB||path.join(__dirname,'crm.db'));
db.exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS sequences(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE IF NOT EXISTS steps(id INTEGER PRIMARY KEY,seq_id INT REFERENCES sequences(id) ON DELETE CASCADE,day INT,label TEXT,body TEXT);
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY,name,business,niche,website,email,phone,instagram,contact,problem,personalization,channel,first_contact,status TEXT DEFAULT 'New',temp TEXT DEFAULT 'Cold',response,call_booked INT DEFAULT 0,proposal_sent INT DEFAULT 0,amount REAL DEFAULT 0,revenue REAL DEFAULT 0,notes,seq_id INT REFERENCES sequences(id),replied_at,replied_after_fu INT DEFAULT 0,created_at TEXT);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,lead_id INT REFERENCES leads(id) ON DELETE CASCADE,step_id INT,day INT,label,body,due TEXT,status TEXT DEFAULT 'pending',sent_at TEXT,channel);
CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY,lead_id INT REFERENCES leads(id) ON DELETE CASCADE,type,text,channel,at TEXT);
CREATE TABLE IF NOT EXISTS settings(k PRIMARY KEY,v);
CREATE INDEX IF NOT EXISTS i_t ON tasks(lead_id,status);CREATE INDEX IF NOT EXISTS i_a ON activities(lead_id);`);
const q=(s,...a)=>db.prepare(s).all(...a),one=(s,...a)=>db.prepare(s).get(...a),run=(s,...a)=>db.prepare(s).run(...a);
const now=()=>new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,19),today=()=>now().slice(0,10);
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const set=(k,d)=>one('SELECT v FROM settings WHERE k=?',k)?.v??d;
const render=(b,l)=>(b||'').replace(/{{\s*(\w+)\s*}}/g,(m,k)=>l[k]??'');
if(!one('SELECT 1 x FROM sequences')){run("INSERT INTO sequences(name) VALUES('Default outreach')");
[[0,'Initial Message','Hey {{name}}, I checked {{business}} and noticed {{problem}}. {{personalization}} Open to a quick chat?'],[2,'Follow-up 1','Hey {{name}}, just following up on my previous message about {{business}}...'],[4,'Follow-up 2','Hey {{name}}, wanted to quickly check if you had a chance to look at my note about {{website}}.'],[7,'Follow-up 3','Hey {{name}}, sharing one quick idea for {{business}} — happy to send details if useful.'],[10,'Final Follow-up','Hey {{name}}, last note from me — if now is not the right time, no worries at all.']].forEach(s=>run('INSERT INTO steps(seq_id,day,label,body) VALUES(1,?,?,?)',...s))}
const ST=['New','Contacted','Follow-up','Replied','Qualified','Call Booked','Proposal Sent','Won','Lost'],LF=['name','business','niche','website','email','phone','instagram','contact','problem','personalization','channel','first_contact','status','temp','response','call_booked','proposal_sent','amount','revenue','notes','seq_id'];
const lead=id=>one('SELECT * FROM leads WHERE id=?',id),act=(id,type,text,ch)=>run('INSERT INTO activities(lead_id,type,text,channel,at) VALUES(?,?,?,?,?)',id,type,text||'',ch||null,now());
function ins(o){const k=LF.filter(f=>o[f]!==undefined&&o[f]!==null);const r=run(`INSERT INTO leads(${k.concat('created_at')}) VALUES(${k.map(()=>'?').concat('?')})`,...k.map(f=>o[f]),now());return Number(r.lastInsertRowid)}
function upd(id,o){const k=LF.filter(f=>o[f]!==undefined);if(k.length)run(`UPDATE leads SET ${k.map(f=>f+'=?')} WHERE id=?`,...k.map(f=>o[f]),id)}
function startSeq(id,seq,start,ch,sentAt,msg){run('DELETE FROM tasks WHERE lead_id=?',id);
 for(const s of q('SELECT * FROM steps WHERE seq_id=? ORDER BY day,id',seq)){const d=s.day===0;run('INSERT INTO tasks(lead_id,step_id,day,label,body,due,status,sent_at,channel) VALUES(?,?,?,?,?,?,?,?,?)',id,s.id,s.day,s.label,d?msg:s.body,addDays(start,s.day),d?'sent':'pending',d?sentAt:null,d?ch:null)}
 run('UPDATE leads SET seq_id=? WHERE id=?',seq,id)}
function setStatus(id,st){const l=lead(id);if(l.status===st)return;const u={status:st};
 if(st==='Replied'&&l.temp==='Cold')u.temp='Warm';
 if(['Qualified','Call Booked','Proposal Sent'].includes(st))u.temp='Hot';
 if(st==='Call Booked')u.call_booked=1;if(st==='Proposal Sent')u.proposal_sent=1;
 if(st==='Won'&&!l.revenue)u.revenue=l.amount||0;
 if(ST.indexOf(st)>=3){run("UPDATE tasks SET status='cancelled' WHERE lead_id=? AND status='pending'",id);
  if(!l.replied_at&&st!=='Lost'){u.replied_at=now();u.replied_after_fu=one("SELECT COUNT(*) c FROM tasks WHERE lead_id=? AND status='sent' AND day>0",id).c}}
 upd(id,u);act(id,'status',l.status+' → '+st)}
const stepBody=t=>one('SELECT body FROM steps WHERE id=?',t.step_id)?.body??t.body;
const day0=l=>render(one('SELECT body FROM steps WHERE seq_id=? AND day=0',l.seq_id||+set('default_seq',1))?.body,l);
const LQ=`SELECT * FROM (SELECT l.*,(SELECT due FROM tasks WHERE lead_id=l.id AND status='pending' ORDER BY id LIMIT 1) next_due,(SELECT label FROM tasks WHERE lead_id=l.id AND status='pending' ORDER BY id LIMIT 1) next_label FROM leads l)`;
function leads(g){const w=[],p=[];
 if(g.q){w.push('(name LIKE ? OR business LIKE ? OR email LIKE ? OR phone LIKE ? OR website LIKE ?)');p.push(...Array(5).fill('%'+g.q+'%'))}
 for(const k of['status','temp','niche','channel'])if(g[k]){w.push(k+'=?');p.push(g[k])}
 if(g.from){w.push('first_contact>=?');p.push(g.from)}if(g.to){w.push('first_contact<=?');p.push(g.to)}
 if(g.due==='today'){w.push('next_due=?');p.push(today())}if(g.due==='overdue'){w.push('next_due<?');p.push(today())}if(g.dueby){w.push('next_due<=?');p.push(g.dueby)}
 return q(LQ+(w.length?' WHERE '+w.join(' AND '):'')+' ORDER BY id DESC',...p)}
const TQ=`SELECT t.*,l.name,l.business,l.niche,l.website,l.problem,l.personalization,l.email,l.phone,l.instagram,l.channel lead_channel,l.temp,l.status lstatus FROM tasks t JOIN leads l ON l.id=t.lead_id WHERE t.status='pending' AND t.id=(SELECT MIN(id) FROM tasks WHERE lead_id=t.lead_id AND status='pending') AND t.due<=? ORDER BY t.due,t.id`;
const due=d=>q(TQ,d).map(t=>({...t,msg:render(stepBody(t),t)}));
const c1=(s,...a)=>one(s,...a).c;
const app=express();app.use(express.json({limit:'50mb'}));app.use(express.static(path.join(__dirname,'public')));
const A=(m,p,f)=>app[m]('/api'+p,(req,res)=>{try{{const o=f(req,res);res.json(o&&o.changes===undefined?o:{ok:1})}}catch(e){console.error(e);res.status(500).send(e.message)}});
A('get','/meta',()=>({today:today(),niches:q("SELECT DISTINCT niche n FROM leads WHERE niche!='' ORDER BY 1").map(r=>r.n),channels:set('channels','Email,Instagram,WhatsApp,LinkedIn,Call,Contact Form').split(',').map(s=>s.trim()).filter(Boolean),seqs:q('SELECT * FROM sequences'),settings:{default_seq:+set('default_seq',1),daily_target:+set('daily_target',50),channels:set('channels','Email,Instagram,WhatsApp,LinkedIn,Call,Contact Form')}}));
A('put','/settings',r=>{for(const k of['default_seq','daily_target','channels'])if(r.body[k]!==undefined)run('INSERT OR REPLACE INTO settings VALUES(?,?)',k,String(r.body[k]))});
A('get','/leads',r=>leads(r.query));
A('post','/leads',r=>({id:ins({status:'New',...r.body})}));
A('get','/leads/:id',r=>{const l=lead(+r.params.id);return{l,msg0:day0(l),tasks:q('SELECT * FROM tasks WHERE lead_id=? ORDER BY id',l.id).map(t=>({...t,msg:t.status==='pending'?render(stepBody(t),l):t.body})),acts:q('SELECT * FROM activities WHERE lead_id=? ORDER BY id DESC',l.id)}});
A('put','/leads/:id',r=>{const{status,...o}=r.body,id=+r.params.id;upd(id,o);if(status)setStatus(id,status)});
A('delete','/leads/:id',r=>run('DELETE FROM leads WHERE id=?',+r.params.id));
A('post','/leads/:id/contact',r=>{const l=lead(+r.params.id),seq=l.seq_id||+set('default_seq',1),ch=r.body.channel||l.channel||'Email',n=now();
 startSeq(l.id,seq,n.slice(0,10),ch,n,r.body.body||day0(l));run("UPDATE leads SET first_contact=?,channel=?,status=CASE WHEN status='New' THEN 'Contacted' ELSE status END WHERE id=?",n.slice(0,10),ch,l.id);act(l.id,'sent','Day 0 · Initial message\n'+(r.body.body||day0(l)),ch)});
A('post','/leads/:id/log',r=>{const id=+r.params.id,{type,text,channel}=r.body,i=ST.indexOf(lead(id).status);act(id,type,text,channel);
 if(type==='reply'){upd(id,{response:text});if(i<3)setStatus(id,'Replied')}if(type==='call'&&i<5)setStatus(id,'Call Booked');if(type==='proposal'&&i<6)setStatus(id,'Proposal Sent')});
const task=id=>one('SELECT * FROM tasks WHERE id=?',id);
A('post','/tasks/:id/sent',r=>{const t=task(+r.params.id),l=lead(t.lead_id),msg=r.body.body||render(stepBody(t),l);
 run("UPDATE tasks SET status='sent',sent_at=?,body=?,channel=? WHERE id=?",now(),msg,l.channel,t.id);act(l.id,'sent',`${t.label} (Day ${t.day})\n${msg}`,l.channel);
 if(['New','Contacted'].includes(l.status))run("UPDATE leads SET status='Follow-up' WHERE id=?",l.id)});
A('post','/tasks/:id/skip',r=>{const t=task(+r.params.id);run("UPDATE tasks SET status='skipped' WHERE id=?",t.id);act(t.lead_id,'skip',t.label+' skipped')});
A('post','/tasks/:id/snooze',r=>{const t=task(+r.params.id),nd=r.body.due,dl=Math.round((Date.parse(nd)-Date.parse(t.due))/864e5);
 for(const x of q("SELECT * FROM tasks WHERE lead_id=? AND status='pending' AND id>=?",t.lead_id,t.id))run('UPDATE tasks SET due=? WHERE id=?',x.id===t.id?nd:addDays(x.due,dl),x.id);act(t.lead_id,'snooze',`${t.label} rescheduled to ${nd}`)});
A('post','/tasks/:id/reply',r=>{const t=task(+r.params.id);act(t.lead_id,'reply',r.body.text||'Marked as replied');if(r.body.text)upd(t.lead_id,{response:r.body.text});setStatus(t.lead_id,'Replied')});
A('get','/followups',r=>due(r.query.by||today()));
A('get','/today',()=>{const t=today(),cont=c1("SELECT COUNT(DISTINCT lead_id) c FROM tasks WHERE status='sent' AND day=0 AND sent_at LIKE ?",t+'%'),tgt=+set('daily_target',50),
 nl=q("SELECT * FROM leads WHERE status='New' ORDER BY (temp='Hot') DESC,(temp='Warm') DESC,id LIMIT ?",Math.max(0,tgt-cont)).map(l=>({...l,msg:day0(l)})),d=due(t);
 return{date:t,contacted:cont,target:tgt,due:d,overdue:d.filter(x=>x.due<t).length,newLeads:nl,newTotal:c1("SELECT COUNT(*) c FROM leads WHERE status='New'"),
 replies:q("SELECT l.*,(SELECT text FROM activities WHERE lead_id=l.id AND type='reply' ORDER BY id DESC LIMIT 1) last_reply FROM leads l WHERE status='Replied' ORDER BY replied_at DESC LIMIT 30"),repliesToday:c1('SELECT COUNT(*) c FROM leads WHERE replied_at LIKE ?',t+'%'),
 hot:q("SELECT * FROM leads WHERE temp='Hot' AND status NOT IN('Won','Lost') ORDER BY id DESC"),
 closing:q("SELECT * FROM leads WHERE status IN('Proposal Sent','Call Booked','Qualified') ORDER BY CASE status WHEN 'Proposal Sent' THEN 0 WHEN 'Call Booked' THEN 1 ELSE 2 END,amount DESC")}});
A('get','/dashboard',()=>{const t=today(),d=due(t),n=s=>c1(`SELECT COUNT(*) c FROM leads WHERE ${s}`);
 const tot=n('1'),contacted=n("status!='New'"),won=n("status='Won'");
 return{total:tot,contactedToday:c1("SELECT COUNT(DISTINCT lead_id) c FROM tasks WHERE status='sent' AND day=0 AND sent_at LIKE ?",t+'%'),fresh:n("status='New'"),hot:n("temp='Hot' AND status NOT IN('Won','Lost')"),warm:n("temp='Warm' AND status NOT IN('Won','Lost')"),cold:n("temp='Cold' AND status NOT IN('Won','Lost')"),dueToday:d.filter(x=>x.due===t).length,overdue:d.filter(x=>x.due<t).length,calls:n('call_booked=1'),proposals:n('proposal_sent=1'),won,lost:n("status='Lost'"),revenue:one("SELECT COALESCE(SUM(revenue),0) c FROM leads WHERE status='Won'").c,conversion:contacted?+(won/contacted*100).toFixed(1):0}});
A('get','/analytics',r=>{const f=r.query.from||'0000',to=r.query.to||'9999',w='first_contact BETWEEN ? AND ?',c=(x='',...a)=>c1(`SELECT COUNT(*) c FROM leads WHERE ${w} ${x}`,f,to,...a),
 g=k=>q(`SELECT COALESCE(NULLIF(${k},''),'—') k,COUNT(*) n,SUM(replied_at IS NOT NULL) replied,SUM(status='Won') won,SUM(CASE WHEN status='Won' THEN revenue ELSE 0 END) revenue FROM leads WHERE ${w} GROUP BY 1 ORDER BY revenue DESC,won DESC,replied DESC`,f,to),
 n=c(),rep=c('AND replied_at IS NOT NULL'),pos=c("AND (status IN('Qualified','Call Booked','Proposal Sent','Won') OR call_booked=1 OR proposal_sent=1)"),won=c("AND status='Won'"),lost=c("AND status='Lost'"),prop=c('AND proposal_sent=1'),wp=c("AND proposal_sent=1 AND status='Won'"),
 fu=c1("SELECT COUNT(DISTINCT t.lead_id) c FROM tasks t JOIN leads l ON l.id=t.lead_id WHERE t.status='sent' AND t.day>0 AND l.first_contact BETWEEN ? AND ?",f,to),fur=c('AND replied_after_fu>0'),
 rev=one(`SELECT COALESCE(SUM(revenue),0) c FROM leads WHERE ${w} AND status='Won'`,f,to).c,p=(a,b)=>b?+(a/b*100).toFixed(1):0;
 return{contacted:n,replyRate:p(rep,n),positiveRate:p(pos,n),calls:c('AND call_booked=1'),proposals:prop,proposalConv:p(wp,prop),winRate:p(won,won+lost),revenue:rev,per100:n?+(rev/n*100).toFixed(0):0,fuConv:p(fur,fu),
 perDay:q("SELECT substr(sent_at,1,10) d,COUNT(DISTINCT lead_id) n FROM tasks WHERE status='sent' AND day=0 AND substr(sent_at,1,10) BETWEEN ? AND ? GROUP BY 1 ORDER BY 1",f,to),niches:g('niche'),channels:g('channel')}});
A('get','/seqs',()=>q('SELECT * FROM sequences').map(s=>({...s,steps:q('SELECT * FROM steps WHERE seq_id=? ORDER BY day,id',s.id)})));
A('post','/seqs',r=>({id:Number(run('INSERT INTO sequences(name) VALUES(?)',r.body.name).lastInsertRowid)}));
A('post','/seqs/:id/steps',r=>run('INSERT INTO steps(seq_id,day,label,body) VALUES(?,?,?,?)',+r.params.id,r.body.day??0,r.body.label||'New step',r.body.body||''));
A('put','/steps/:id',r=>{const id=+r.params.id,{day,label,body}=r.body;run('UPDATE steps SET day=?,label=?,body=? WHERE id=?',day,label,body,id);
 run("UPDATE tasks SET day=?,label=?,due=(SELECT date(first_contact,'+'||?||' days') FROM leads WHERE id=lead_id) WHERE step_id=? AND status='pending' AND (SELECT first_contact FROM leads WHERE id=lead_id) IS NOT NULL",day,label,day,id)});
A('delete','/steps/:id',r=>{run("UPDATE tasks SET status='cancelled' WHERE step_id=? AND status='pending'",+r.params.id);run('DELETE FROM steps WHERE id=?',+r.params.id)});
// ---- import ----
const FM={name:'name|fullname|leadname|contactname|owner|person',business:'business|businessname|company|companyname|brand',niche:'niche|industry|category|vertical',website:'website|url|site|web|link',email:'email|emailaddress|mail',phone:'phone|mobile|whatsapp|number|tel|phonenumber',instagram:'instagram|ig|insta|instagramhandle',contact:'contact|contactinfo|contactmethod',problem:'problemfound|problem|issue|issues|problemidentified',personalization:'personalizationnote|personalization|personalisation|hook|note|notes',first_contact:'firstcontactdate|datecontacted|contacteddate|firstcontact|contactdate|date',channel:'channel|platform|source|medium',status:'status|stage',followup_date:'followupdate|nextfollowup|followup|nextfollowupdate',response:'response|reply|replied',call_booked:'callbooked|call',proposal_sent:'proposalsent|proposal',amount:'amount|dealvalue|value|price|quote',outcome:'wonlost|result|outcome',revenue:'revenue|revenuegenerated|paid'};
const nrm=s=>String(s).toLowerCase().replace(/[^a-z]/g,''),host=s=>String(s||'').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/[/?#].*$/,''),digits=s=>String(s||'').replace(/\D/g,'').slice(-10),yes=v=>/^(y|yes|true|1|done|booked|sent)/i.test(String(v).trim());
function rowObj(r,map){const o={};for(const f in map)if(map[f])o[f]=String(r[map[f]]??'').trim();return o}
const keys=o=>[o.email&&'e:'+o.email.toLowerCase(),digits(o.phone).length>=7&&'p:'+digits(o.phone),o.website&&'w:'+host(o.website)].filter(Boolean);
function plan(rows,map){const seen=new Set();for(const l of q('SELECT email,phone,website FROM leads'))keys(l).forEach(k=>seen.add(k));
 const r={ok:[],dupDb:0,dupFile:0,empty:0};for(const x of rows){const o=rowObj(x,map);if(!(o.name||o.business||o.email||o.phone||o.website)){r.empty++;continue}
  const k=keys(o);if(k.some(z=>seen.has(z))){(k.some(z=>seen._f?.has(z))?r.dupFile++:r.dupDb++);r.ok.push({o,dup:1});continue}
  (seen._f||(seen._f=new Set()));k.forEach(z=>{seen.add(z);seen._f.add(z)});r.ok.push({o,dup:0})}return r}
app.post('/api/import/parse',express.raw({type:'*/*',limit:'50mb'}),(req,res)=>{try{const wb=XLSX.read(req.body,{type:'buffer',cellDates:true}),ws=wb.Sheets[wb.SheetNames[0]],raw=XLSX.utils.sheet_to_json(ws,{defval:''});
 const rows=raw.map(r=>{const o={};for(const k in r)o[k]=r[k] instanceof Date?r[k].toLocaleDateString('en-CA'):r[k];return o}),headers=Object.keys(rows[0]||{}),map={},used=new Set();
 for(const f in FM)map[f]=headers.find(h=>!used.has(h)&&new RegExp('^('+FM[f]+')$').test(nrm(h)))||'',map[f]&&used.add(map[f]);
 res.json({headers,rows,map,fields:Object.keys(FM)})}catch(e){res.status(400).send(e.message)}});
A('post','/import/preview',r=>{const p=plan(r.body.rows,r.body.map);return{total:r.body.rows.length,fresh:p.ok.filter(x=>!x.dup).length,dupDb:p.dupDb,dupFile:p.dupFile,empty:p.empty}});
A('post','/import/commit',r=>{const{rows,map,skipDup=true}=r.body,p=plan(rows,map),seq=+set('default_seq',1);let n=0,sk=0;
 db.exec('BEGIN');try{for(const{o,dup}of p.ok){if(dup&&skipDup){sk++;continue}
  const lo=String(o.status||'').toLowerCase(),oc=String(o.outcome||'').toLowerCase(),fc=(o.first_contact||'').slice(0,10);
  let st=ST.find(s=>s.toLowerCase()===lo)||(/^won/.test(oc)?'Won':/^lost/.test(oc)?'Lost':fc?'Contacted':'New');
  if(o.response&&ST.indexOf(st)<3)st='Replied';
  const amt=parseFloat(String(o.amount).replace(/[^\d.]/g,''))||0,rev=parseFloat(String(o.revenue).replace(/[^\d.]/g,''))||0;
  const id=ins({...o,first_contact:fc||null,status:st,temp:['Qualified','Call Booked','Proposal Sent'].includes(st)?'Hot':st==='Replied'?'Warm':'Cold',call_booked:yes(o.call_booked)||st==='Call Booked'?1:0,proposal_sent:yes(o.proposal_sent)||st==='Proposal Sent'?1:0,amount:amt,revenue:rev||(st==='Won'?amt:0),replied_at:st==='Replied'?(fc||today()):null});
  act(id,'import','Imported from file');
  if(fc&&['Contacted','Follow-up'].includes(st)){startSeq(id,seq,fc,o.channel||null,fc+'T09:00:00','(imported)');const fd=(o.followup_date||'').slice(0,10);
   if(fd)run("UPDATE tasks SET due=? WHERE id=(SELECT MIN(id) FROM tasks WHERE lead_id=? AND status='pending')",fd,id)}n++}
 db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}return{imported:n,skipped:sk,empty:p.empty}});
app.get('/api/export',(req,res)=>{const rows=leads(req.query).map(l=>({Name:l.name,Business:l.business,Niche:l.niche,Website:l.website,Email:l.email,Phone:l.phone,Instagram:l.instagram,Contact:l.contact,'Problem Found':l.problem,'Personalization Note':l.personalization,'First Contact Date':l.first_contact,Channel:l.channel,Status:l.status,Temperature:l.temp,'Next Follow-up':l.next_due,'Next Step':l.next_label,Response:l.response,'Call Booked':l.call_booked?'Yes':'','Proposal Sent':l.proposal_sent?'Yes':'',Amount:l.amount,Revenue:l.revenue,Notes:l.notes})),
 ws=XLSX.utils.json_to_sheet(rows),csv=req.query.format==='csv';res.setHeader('Content-Disposition',`attachment; filename=leads.${csv?'csv':'xlsx'}`);
 if(csv)res.type('csv').send(XLSX.utils.sheet_to_csv(ws));else{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Leads');res.send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}))}});
app.listen(process.env.PORT||3000,()=>console.log('Lead CRM → http://localhost:'+(process.env.PORT||3000)));
