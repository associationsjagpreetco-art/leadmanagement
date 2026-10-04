const express=require('express'),XLSX=require('xlsx'),{createClient}=require('@libsql/client'),crypto=require('crypto'),path=require('path');
const db=createClient({url:process.env.TURSO_DATABASE_URL||'file:local.db',authToken:process.env.TURSO_AUTH_TOKEN});
const S=(sql,...args)=>({sql,args}),q=async(s,...a)=>(await db.execute(S(s,...a))).rows.map(r=>({...r})),one=async(s,...a)=>(await q(s,...a))[0],run=async(s,...a)=>{const r=await db.execute(S(s,...a));return{changes:r.rowsAffected}};
const now=()=>new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,19),today=()=>now().slice(0,10);
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const cfg=async()=>({default_seq:1,daily_target:50,channels:'Email,Instagram,WhatsApp,LinkedIn,Call,Contact Form',...Object.fromEntries((await q('SELECT k,v FROM settings')).map(r=>[r.k,r.v]))});
const render=(b,l)=>(b||'').replace(/{{\s*(\w+)\s*}}/g,(m,k)=>l[k]??'');
const ready=(async()=>{await db.executeMultiple(`CREATE TABLE IF NOT EXISTS sequences(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE IF NOT EXISTS steps(id INTEGER PRIMARY KEY,seq_id INT,day INT,label TEXT,body TEXT);
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY,name,business,niche,website,email,phone,instagram,contact,problem,personalization,channel,first_contact,status TEXT DEFAULT 'New',temp TEXT DEFAULT 'Cold',response,call_booked INT DEFAULT 0,proposal_sent INT DEFAULT 0,amount REAL DEFAULT 0,revenue REAL DEFAULT 0,notes,seq_id INT,replied_at,replied_after_fu INT DEFAULT 0,created_at TEXT);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,lead_id INT,step_id INT,day INT,label,body,due TEXT,status TEXT DEFAULT 'pending',sent_at TEXT,channel);
CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY,lead_id INT,type,text,channel,at TEXT);
CREATE TABLE IF NOT EXISTS settings(k PRIMARY KEY,v);
CREATE INDEX IF NOT EXISTS i_t ON tasks(lead_id,status);CREATE INDEX IF NOT EXISTS i_a ON activities(lead_id);CREATE INDEX IF NOT EXISTS i_l ON leads(status)`);
 if(!await one('SELECT 1 x FROM sequences')){await run("INSERT INTO sequences(name) VALUES('Default outreach')");
 await db.batch([[0,'Initial Message','Hey {{name}}, I checked {{business}} and noticed {{problem}}. {{personalization}} Open to a quick chat?'],[2,'Follow-up 1','Hey {{name}}, just following up on my previous message about {{business}}...'],[4,'Follow-up 2','Hey {{name}}, wanted to quickly check if you had a chance to look at my note about {{website}}.'],[7,'Follow-up 3','Hey {{name}}, sharing one quick idea for {{business}} — happy to send details if useful.'],[10,'Final Follow-up','Hey {{name}}, last note from me — if now is not the right time, no worries at all.']].map(s=>S('INSERT INTO steps(seq_id,day,label,body) VALUES(1,?,?,?)',...s)),'write')}})();
const ST=['New','Contacted','Follow-up','Replied','Qualified','Call Booked','Proposal Sent','Won','Lost'],LF=['name','business','niche','website','email','phone','instagram','contact','problem','personalization','channel','first_contact','status','temp','response','call_booked','proposal_sent','amount','revenue','notes','seq_id'];
const lead=id=>one('SELECT * FROM leads WHERE id=?',id),actS=(id,type,text,ch)=>S('INSERT INTO activities(lead_id,type,text,channel,at) VALUES(?,?,?,?,?)',id,type,text||'',ch||null,now()),act=(...a)=>db.execute(actS(...a));
async function ins(o){const k=LF.filter(f=>o[f]!==undefined&&o[f]!==null),r=await db.execute(S(`INSERT INTO leads(${k.concat('created_at')}) VALUES(${k.map(()=>'?').concat('?')})`,...k.map(f=>o[f]),now()));return Number(r.lastInsertRowid)}
const updS=(id,o)=>{const k=LF.filter(f=>o[f]!==undefined);return k.length?S(`UPDATE leads SET ${k.map(f=>f+'=?')} WHERE id=?`,...k.map(f=>o[f]),id):null},upd=async(id,o)=>{const s=updS(id,o);if(s)await db.execute(s)};
const seqS=(id,steps,seq,start,ch,sentAt,msg)=>[S('DELETE FROM tasks WHERE lead_id=?',id),...steps.map(s=>{const d=s.day===0;return S('INSERT INTO tasks(lead_id,step_id,day,label,body,due,status,sent_at,channel) VALUES(?,?,?,?,?,?,?,?,?)',id,s.id,s.day,s.label,d?msg:s.body,addDays(start,s.day),d?'sent':'pending',d?sentAt:null,d?ch:null)}),S('UPDATE leads SET seq_id=? WHERE id=?',seq,id)];
const stepsOf=seq=>q('SELECT * FROM steps WHERE seq_id=? ORDER BY day,id',seq);
async function setStatus(id,st){const l=await lead(id);if(l.status===st)return;const u={status:st},sx=[];
 if(st==='Replied'&&l.temp==='Cold')u.temp='Warm';
 if(['Qualified','Call Booked','Proposal Sent'].includes(st))u.temp='Hot';
 if(st==='Call Booked')u.call_booked=1;if(st==='Proposal Sent')u.proposal_sent=1;
 if(st==='Won'&&!l.revenue)u.revenue=l.amount||0;
 if(ST.indexOf(st)>=3){sx.push(S("UPDATE tasks SET status='cancelled' WHERE lead_id=? AND status='pending'",id));
  if(!l.replied_at&&st!=='Lost'){u.replied_at=now();u.replied_after_fu=(await one("SELECT COUNT(*) c FROM tasks WHERE lead_id=? AND status='sent' AND day>0",id)).c}}
 sx.push(updS(id,u),actS(id,'status',l.status+' → '+st));await db.batch(sx,'write')}
const day0=async l=>render((await one('SELECT body FROM steps WHERE seq_id=? AND day=0',l.seq_id||(await cfg()).default_seq))?.body,l);
const LQ=`SELECT * FROM (SELECT l.*,(SELECT due FROM tasks WHERE lead_id=l.id AND status='pending' ORDER BY id LIMIT 1) next_due,(SELECT label FROM tasks WHERE lead_id=l.id AND status='pending' ORDER BY id LIMIT 1) next_label FROM leads l)`;
function leads(g){const w=[],p=[];
 if(g.q){w.push('(name LIKE ? OR business LIKE ? OR email LIKE ? OR phone LIKE ? OR website LIKE ?)');p.push(...Array(5).fill('%'+g.q+'%'))}
 for(const k of['status','temp','niche','channel'])if(g[k]){w.push(k+'=?');p.push(g[k])}
 if(g.from){w.push('first_contact>=?');p.push(g.from)}if(g.to){w.push('first_contact<=?');p.push(g.to)}
 if(g.due==='today'){w.push('next_due=?');p.push(today())}if(g.due==='overdue'){w.push('next_due<?');p.push(today())}if(g.dueby){w.push('next_due<=?');p.push(g.dueby)}
 return q(LQ+(w.length?' WHERE '+w.join(' AND '):'')+' ORDER BY id DESC',...p)}
const TQ=`SELECT t.*,s.body sbody,l.name,l.business,l.niche,l.website,l.problem,l.personalization,l.email,l.phone,l.instagram,l.channel lead_channel,l.temp,l.status lstatus FROM tasks t JOIN leads l ON l.id=t.lead_id LEFT JOIN steps s ON s.id=t.step_id WHERE t.status='pending' AND t.id=(SELECT MIN(id) FROM tasks WHERE lead_id=t.lead_id AND status='pending') AND t.due<=? ORDER BY t.due,t.id`;
const due=async d=>(await q(TQ,d)).map(t=>({...t,msg:render(t.sbody??t.body,t)}));
const taskx=id=>one('SELECT t.*,s.body sbody FROM tasks t LEFT JOIN steps s ON s.id=t.step_id WHERE t.id=?',id);
const app=express();app.use(express.json({limit:'50mb'}));app.use(express.static(path.join(__dirname,'..','public')));
const tok=()=>crypto.createHmac('sha256',process.env.APP_PASSWORD||'x').update('crm-session').digest('hex');
app.post('/api/login',(r,s)=>{if(!process.env.APP_PASSWORD)return s.status(500).send('Set APP_PASSWORD env var');if(r.body.password!==process.env.APP_PASSWORD)return s.status(401).send('Wrong password');
 s.setHeader('Set-Cookie',`crm=${tok()}; HttpOnly; ${process.env.VERCEL?'Secure; ':''}SameSite=Lax; Path=/; Max-Age=2592000`);s.json({ok:1})});
app.use('/api',async(r,s,n)=>{try{await ready}catch(e){return s.status(500).send('DB error: '+e.message)}if(!process.env.APP_PASSWORD)return s.status(500).send('Set APP_PASSWORD env var');
 if((r.headers.cookie||'').match(/crm=(\w+)/)?.[1]!==tok())return s.status(401).send('Login required');n()});
const A=(m,p,f)=>app[m]('/api'+p,async(req,res)=>{try{const o=await f(req,res);res.json(o&&o.changes===undefined?o:{ok:1})}catch(e){console.error(e);res.status(500).send(e.message)}});
A('get','/meta',async()=>{const c=await cfg();return{today:today(),niches:(await q("SELECT DISTINCT niche n FROM leads WHERE niche!='' ORDER BY 1")).map(r=>r.n),channels:c.channels.split(',').map(s=>s.trim()).filter(Boolean),seqs:await q('SELECT * FROM sequences'),settings:{default_seq:+c.default_seq,daily_target:+c.daily_target,channels:c.channels}}});
A('put','/settings',async r=>{for(const k of['default_seq','daily_target','channels'])if(r.body[k]!==undefined)await run('INSERT OR REPLACE INTO settings VALUES(?,?)',k,String(r.body[k]))});
A('get','/leads',r=>leads(r.query));
A('post','/leads',async r=>({id:await ins({status:'New',...r.body})}));
A('get','/leads/:id',async r=>{const l=await lead(+r.params.id);return{l,msg0:await day0(l),tasks:(await q('SELECT t.*,s.body sbody FROM tasks t LEFT JOIN steps s ON s.id=t.step_id WHERE lead_id=? ORDER BY t.id',l.id)).map(t=>({...t,msg:t.status==='pending'?render(t.sbody??t.body,l):t.body})),acts:await q('SELECT * FROM activities WHERE lead_id=? ORDER BY id DESC',l.id)}});
A('put','/leads/:id',async r=>{const{status,...o}=r.body,id=+r.params.id;await upd(id,o);if(status)await setStatus(id,status)});
A('delete','/leads/:id',r=>db.batch([S('DELETE FROM tasks WHERE lead_id=?',+r.params.id),S('DELETE FROM activities WHERE lead_id=?',+r.params.id),S('DELETE FROM leads WHERE id=?',+r.params.id)],'write'));
A('post','/leads/:id/contact',async r=>{const l=await lead(+r.params.id),seq=l.seq_id||(await cfg()).default_seq,ch=r.body.channel||l.channel||'Email',n=now(),msg=r.body.body||await day0(l);
 await db.batch([...seqS(l.id,await stepsOf(seq),seq,n.slice(0,10),ch,n,msg),S("UPDATE leads SET first_contact=?,channel=?,status=CASE WHEN status='New' THEN 'Contacted' ELSE status END WHERE id=?",n.slice(0,10),ch,l.id),actS(l.id,'sent','Day 0 · Initial message\n'+msg,ch)],'write')});
A('post','/leads/:id/log',async r=>{const id=+r.params.id,{type,text,channel}=r.body,i=ST.indexOf((await lead(id)).status);await act(id,type,text,channel);
 if(type==='reply'){await upd(id,{response:text});if(i<3)await setStatus(id,'Replied')}if(type==='call'&&i<5)await setStatus(id,'Call Booked');if(type==='proposal'&&i<6)await setStatus(id,'Proposal Sent')});
A('post','/tasks/:id/sent',async r=>{const t=await taskx(+r.params.id),l=await lead(t.lead_id),msg=r.body.body||render(t.sbody??t.body,l);
 await db.batch([S("UPDATE tasks SET status='sent',sent_at=?,body=?,channel=? WHERE id=?",now(),msg,l.channel||null,t.id),actS(l.id,'sent',`${t.label} (Day ${t.day})\n${msg}`,l.channel),S("UPDATE leads SET status='Follow-up' WHERE id=? AND status IN('New','Contacted')",l.id)],'write')});
A('post','/tasks/:id/skip',async r=>{const t=await taskx(+r.params.id);await db.batch([S("UPDATE tasks SET status='skipped' WHERE id=?",t.id),actS(t.lead_id,'skip',t.label+' skipped')],'write')});
A('post','/tasks/:id/snooze',async r=>{const t=await taskx(+r.params.id),nd=r.body.due,dl=Math.round((Date.parse(nd)-Date.parse(t.due))/864e5);
 await db.batch([...(await q("SELECT * FROM tasks WHERE lead_id=? AND status='pending' AND id>=?",t.lead_id,t.id)).map(x=>S('UPDATE tasks SET due=? WHERE id=?',x.id===t.id?nd:addDays(x.due,dl),x.id)),actS(t.lead_id,'snooze',`${t.label} rescheduled to ${nd}`)],'write')});
A('post','/tasks/:id/reply',async r=>{const t=await taskx(+r.params.id);await act(t.lead_id,'reply',r.body.text||'Marked as replied');if(r.body.text)await upd(t.lead_id,{response:r.body.text});await setStatus(t.lead_id,'Replied')});
A('get','/followups',r=>due(r.query.by||today()));
A('get','/today',async()=>{const t=today(),c=await cfg(),tgt=+c.daily_target,[cont,d,newTotal,replies,repliesToday,hot,closing]=await Promise.all([one("SELECT COUNT(DISTINCT lead_id) c FROM tasks WHERE status='sent' AND day=0 AND sent_at LIKE ?",t+'%'),due(t),one("SELECT COUNT(*) c FROM leads WHERE status='New'"),
 q("SELECT l.*,(SELECT text FROM activities WHERE lead_id=l.id AND type='reply' ORDER BY id DESC LIMIT 1) last_reply FROM leads l WHERE status='Replied' ORDER BY replied_at DESC LIMIT 30"),one('SELECT COUNT(*) c FROM leads WHERE replied_at LIKE ?',t+'%'),
 q("SELECT * FROM leads WHERE temp='Hot' AND status NOT IN('Won','Lost') ORDER BY id DESC"),q("SELECT * FROM leads WHERE status IN('Proposal Sent','Call Booked','Qualified') ORDER BY CASE status WHEN 'Proposal Sent' THEN 0 WHEN 'Call Booked' THEN 1 ELSE 2 END,amount DESC")]),
 nl=await q("SELECT * FROM leads WHERE status='New' ORDER BY (temp='Hot') DESC,(temp='Warm') DESC,id LIMIT ?",Math.max(0,tgt-cont.c)),seq=await stepsOf(c.default_seq),b0=seq.find(s=>s.day===0)?.body;
 return{date:t,contacted:cont.c,target:tgt,due:d,overdue:d.filter(x=>x.due<t).length,newLeads:nl.map(l=>({...l,msg:render(b0,l)})),newTotal:newTotal.c,replies,repliesToday:repliesToday.c,hot,closing}});
A('get','/dashboard',async()=>{const t=today(),[a,ct,d]=await Promise.all([one(`SELECT COUNT(*) total,SUM(status!='New') contacted,SUM(status='New') fresh,SUM(temp='Hot' AND status NOT IN('Won','Lost')) hot,SUM(temp='Warm' AND status NOT IN('Won','Lost')) warm,SUM(temp='Cold' AND status NOT IN('Won','Lost')) cold,SUM(call_booked=1) calls,SUM(proposal_sent=1) proposals,SUM(status='Won') won,SUM(status='Lost') lost,SUM(CASE WHEN status='Won' THEN revenue ELSE 0 END) revenue FROM leads`),one("SELECT COUNT(DISTINCT lead_id) c FROM tasks WHERE status='sent' AND day=0 AND sent_at LIKE ?",t+'%'),due(t)]);
 for(const k in a)a[k]=a[k]||0;return{...a,contactedToday:ct.c,dueToday:d.filter(x=>x.due===t).length,overdue:d.filter(x=>x.due<t).length,conversion:a.contacted?+(a.won/a.contacted*100).toFixed(1):0}});
A('get','/analytics',async r=>{const f=r.query.from||'0000',to=r.query.to||'9999',w='first_contact BETWEEN ? AND ?',g=k=>q(`SELECT COALESCE(NULLIF(${k},''),'—') k,COUNT(*) n,SUM(replied_at IS NOT NULL) replied,SUM(status='Won') won,SUM(CASE WHEN status='Won' THEN revenue ELSE 0 END) revenue FROM leads WHERE ${w} GROUP BY 1 ORDER BY revenue DESC,won DESC,replied DESC`,f,to);
 const[a,fu,perDay,niches,channels]=await Promise.all([one(`SELECT COUNT(*) n,SUM(replied_at IS NOT NULL) rep,SUM(status IN('Qualified','Call Booked','Proposal Sent','Won') OR call_booked=1 OR proposal_sent=1) pos,SUM(status='Won') won,SUM(status='Lost') lost,SUM(proposal_sent=1) prop,SUM(proposal_sent=1 AND status='Won') wp,SUM(call_booked=1) calls,SUM(replied_after_fu>0) fur,SUM(CASE WHEN status='Won' THEN revenue ELSE 0 END) rev FROM leads WHERE ${w}`,f,to),
 one("SELECT COUNT(DISTINCT t.lead_id) c FROM tasks t JOIN leads l ON l.id=t.lead_id WHERE t.status='sent' AND t.day>0 AND l.first_contact BETWEEN ? AND ?",f,to),q("SELECT substr(sent_at,1,10) d,COUNT(DISTINCT lead_id) n FROM tasks WHERE status='sent' AND day=0 AND substr(sent_at,1,10) BETWEEN ? AND ? GROUP BY 1 ORDER BY 1",f,to),g('niche'),g('channel')]);
 for(const k in a)a[k]=a[k]||0;const p=(x,y)=>y?+(x/y*100).toFixed(1):0;
 return{contacted:a.n,replyRate:p(a.rep,a.n),positiveRate:p(a.pos,a.n),calls:a.calls,proposals:a.prop,proposalConv:p(a.wp,a.prop),winRate:p(a.won,a.won+a.lost),revenue:a.rev,per100:a.n?Math.round(a.rev/a.n*100):0,fuConv:p(a.fur,fu.c),perDay,niches,channels}});
A('get','/seqs',async()=>{const s=await q('SELECT * FROM sequences'),st=await q('SELECT * FROM steps ORDER BY day,id');return s.map(x=>({...x,steps:st.filter(y=>y.seq_id===x.id)}))});
A('post','/seqs',async r=>{await run('INSERT INTO sequences(name) VALUES(?)',r.body.name);return{id:(await one('SELECT MAX(id) m FROM sequences')).m}});
A('post','/seqs/:id/steps',r=>run('INSERT INTO steps(seq_id,day,label,body) VALUES(?,?,?,?)',+r.params.id,r.body.day??0,r.body.label||'New step',r.body.body||''));
A('put','/steps/:id',async r=>{const id=+r.params.id,{day,label,body}=r.body;await db.batch([S('UPDATE steps SET day=?,label=?,body=? WHERE id=?',day,label,body,id),S("UPDATE tasks SET day=?,label=?,due=(SELECT date(first_contact,'+'||?||' days') FROM leads WHERE id=lead_id) WHERE step_id=? AND status='pending' AND (SELECT first_contact FROM leads WHERE id=lead_id) IS NOT NULL",day,label,day,id)],'write')});
A('delete','/steps/:id',r=>db.batch([S("UPDATE tasks SET status='cancelled' WHERE step_id=? AND status='pending'",+r.params.id),S('DELETE FROM steps WHERE id=?',+r.params.id)],'write'));
// ---- import ----
const FM={name:'name|fullname|leadname|contactname|owner|person',business:'business|businessname|company|companyname|brand',niche:'niche|industry|category|vertical',website:'website|url|site|web|link',email:'email|emailaddress|mail',phone:'phone|mobile|whatsapp|number|tel|phonenumber',instagram:'instagram|ig|insta|instagramhandle',contact:'contact|contactinfo|contactmethod',problem:'problemfound|problem|issue|issues|problemidentified',personalization:'personalizationnote|personalization|personalisation|hook|note|notes',first_contact:'firstcontactdate|datecontacted|contacteddate|firstcontact|contactdate|date',channel:'channel|platform|source|medium',status:'status|stage',followup_date:'followupdate|nextfollowup|followup|nextfollowupdate',response:'response|reply|replied',call_booked:'callbooked|call',proposal_sent:'proposalsent|proposal',amount:'amount|dealvalue|value|price|quote',outcome:'wonlost|result|outcome',revenue:'revenue|revenuegenerated|paid'};
const nrm=s=>String(s).toLowerCase().replace(/[^a-z]/g,''),host=s=>String(s||'').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/[/?#].*$/,''),digits=s=>String(s||'').replace(/\D/g,'').slice(-10),yes=v=>/^(y|yes|true|1|done|booked|sent)/i.test(String(v).trim());
const rowObj=(r,map)=>{const o={};for(const f in map)if(map[f])o[f]=String(r[map[f]]??'').trim();return o},keys=o=>[o.email&&'e:'+o.email.toLowerCase(),digits(o.phone).length>=7&&'p:'+digits(o.phone),o.website&&'w:'+host(o.website)].filter(Boolean);
async function plan(rows,map){const seen=new Set(),fl=new Set();for(const l of await q('SELECT email,phone,website FROM leads'))keys(l).forEach(k=>seen.add(k));
 const r={ok:[],dupDb:0,dupFile:0,empty:0};for(const x of rows){const o=rowObj(x,map);if(!(o.name||o.business||o.email||o.phone||o.website)){r.empty++;continue}
  const k=keys(o);if(k.some(z=>seen.has(z))){k.some(z=>fl.has(z))?r.dupFile++:r.dupDb++;r.ok.push({o,dup:1});continue}k.forEach(z=>{seen.add(z);fl.add(z)});r.ok.push({o,dup:0})}return r}
app.post('/api/import/parse',express.raw({type:'*/*',limit:'50mb'}),(req,res)=>{try{const wb=XLSX.read(req.body,{type:'buffer',cellDates:true}),ws=wb.Sheets[wb.SheetNames[0]],
 rows=XLSX.utils.sheet_to_json(ws,{defval:''}).map(r=>{const o={};for(const k in r)o[k]=r[k] instanceof Date?r[k].toLocaleDateString('en-CA'):r[k];return o}),headers=Object.keys(rows[0]||{}),map={},used=new Set();
 for(const f in FM){map[f]=headers.find(h=>!used.has(h)&&new RegExp('^('+FM[f]+')$').test(nrm(h)))||'';if(map[f])used.add(map[f])}res.json({headers,rows,map,fields:Object.keys(FM)})}catch(e){res.status(400).send(e.message)}});
A('post','/import/preview',async r=>{const p=await plan(r.body.rows,r.body.map);return{total:r.body.rows.length,fresh:p.ok.filter(x=>!x.dup).length,dupDb:p.dupDb,dupFile:p.dupFile,empty:p.empty}});
A('post','/import/commit',async r=>{const{rows,map,skipDup=true}=r.body,p=await plan(rows,map),seq=+(await cfg()).default_seq,steps=await stepsOf(seq);let n=0,sk=0;
 for(const{o,dup}of p.ok){if(dup&&skipDup){sk++;continue}
  const lo=String(o.status||'').toLowerCase(),oc=String(o.outcome||'').toLowerCase(),fc=(o.first_contact||'').slice(0,10);
  let st=ST.find(s=>s.toLowerCase()===lo)||(/^won/.test(oc)?'Won':/^lost/.test(oc)?'Lost':fc?'Contacted':'New');if(o.response&&ST.indexOf(st)<3)st='Replied';
  const amt=parseFloat(String(o.amount).replace(/[^\d.]/g,''))||0,rev=parseFloat(String(o.revenue).replace(/[^\d.]/g,''))||0,
  id=await ins({...o,first_contact:fc||null,status:st,temp:['Qualified','Call Booked','Proposal Sent'].includes(st)?'Hot':st==='Replied'?'Warm':'Cold',call_booked:yes(o.call_booked)||st==='Call Booked'?1:0,proposal_sent:yes(o.proposal_sent)||st==='Proposal Sent'?1:0,amount:amt,revenue:rev||(st==='Won'?amt:0),replied_at:st==='Replied'?(fc||today()):null}),sx=[actS(id,'import','Imported from file')];
  if(fc&&['Contacted','Follow-up'].includes(st)){sx.push(...seqS(id,steps,seq,fc,o.channel||null,fc+'T09:00:00','(imported)'));const fd=(o.followup_date||'').slice(0,10);
   if(fd)sx.push(S("UPDATE tasks SET due=? WHERE id=(SELECT MIN(id) FROM tasks WHERE lead_id=? AND status='pending')",fd,id))}
  await db.batch(sx,'write');n++}return{imported:n,skipped:sk,empty:p.empty}});
app.get('/api/export',async(req,res)=>{try{const rows=(await leads(req.query)).map(l=>({Name:l.name,Business:l.business,Niche:l.niche,Website:l.website,Email:l.email,Phone:l.phone,Instagram:l.instagram,Contact:l.contact,'Problem Found':l.problem,'Personalization Note':l.personalization,'First Contact Date':l.first_contact,Channel:l.channel,Status:l.status,Temperature:l.temp,'Next Follow-up':l.next_due,'Next Step':l.next_label,Response:l.response,'Call Booked':l.call_booked?'Yes':'','Proposal Sent':l.proposal_sent?'Yes':'',Amount:l.amount,Revenue:l.revenue,Notes:l.notes})),
 ws=XLSX.utils.json_to_sheet(rows),csv=req.query.format==='csv';res.setHeader('Content-Disposition',`attachment; filename=leads.${csv?'csv':'xlsx'}`);
 if(csv)res.type('csv').send(XLSX.utils.sheet_to_csv(ws));else{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Leads');res.send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}))}}catch(e){res.status(500).send(e.message)}});
module.exports=app;
if(require.main===module)app.listen(process.env.PORT||3000,()=>console.log('Lead CRM → http://localhost:'+(process.env.PORT||3000)));
