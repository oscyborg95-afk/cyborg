const pg = (await import(new URL("node_modules/pg/lib/index.js","file://"+process.cwd()+"/").href)).default;
const url = `postgresql://postgres:${encodeURIComponent(process.env.SB_PW!)}@db.${process.env.SB_REF}.supabase.co:5432/postgres`;
const pool = new pg.Pool({connectionString:url, ssl:{rejectUnauthorized:false}, max:2});
const q = async (t:string,v:any[]=[]) => (await pool.query(t,v)).rows;
const since = new Date().toISOString();
console.log("watching from", since);
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
for (let i=1;i<=12;i++) {
  await sleep(45_000);
  const jobs = await q(`select notification_type, recipient, status, created_at, left(coalesce(last_error,''),80) err from public.tracking_notification_jobs where created_at > $1 order by created_at`,[since]);
  const de = await q(`select source, status, created_at from public.delivery_events where created_at > $1 order by created_at`,[since]);
  console.log(`\n[check ${i} @ ${new Date().toISOString().slice(11,19)}] new jobs=${jobs.length} new delivery_events=${de.length}`);
  for (const d of de) console.log(`   event: ${d.source}/${d.status} @${d.created_at.toISOString().slice(11,19)}`);
  for (const j of jobs) console.log(`   JOB: ${j.notification_type} -> ${j.recipient} [${j.status}] @${j.created_at.toISOString().slice(11,19)} ${j.err?"err="+j.err:""}`);
  if (jobs.length) { console.log("\n*** ENQUEUE RECOVERED ***"); break; }
}
await pool.end();
