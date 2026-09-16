export default async function handler(req,res){
 const days=Math.min(Math.max(parseInt(req.query.days||"30"),7),365);
 try{
  const [krResult,usResult] = await Promise.allSettled([getKR(days),getUS(days)]);
  const kr = krResult.status==="fulfilled" ? krResult.value : emptyRates();
  const us = usResult.status==="fulfilled" ? usResult.value : emptyRates();
  const errors = [];
  if(krResult.status==="rejected") errors.push("한국: "+krResult.reason.message);
  if(usResult.status==="rejected") errors.push("미국: "+usResult.reason.message);

  const policy = await getPolicyHistory();
  const mats=["1Y","2Y","3Y","5Y","10Y","20Y","30Y"],latest={kr:{},us:{}};
  for(const m of mats){latest.kr[m]=lt(kr[m]||[]);latest.us[m]=lt(us[m]||[])}

  res.setHeader("Cache-Control","s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({
    latestDates:{kr:latest.kr["10Y"].date,us:latest.us["10Y"].date},
    latest,
    policyHistory:policy,
    errors
  });
 }catch(e){
  res.status(500).json({error:e.message||"server error"});
 }
}

function emptyRates(){
 return {"1Y":[],"2Y":[],"3Y":[],"5Y":[],"10Y":[],"20Y":[],"30Y":[]};
}

function lt(a){
 if(!a.length)return{date:null,value:null,changeBp:null};
 a=[...a].sort((x,y)=>x.date.localeCompare(y.date));
 let c=a.at(-1),p=a.at(-2);
 return{date:c.date,value:c.value,changeBp:p?(c.value-p.value)*100:null};
}

async function getKR(days){
 const key=process.env.ECOS_API_KEY;
 if(!key) throw Error("ECOS_API_KEY가 Vercel 환경변수에 없습니다.");

 const codes={
  "1Y":"010190000","2Y":"010195000","3Y":"010200000",
  "5Y":"010200001","10Y":"010210000","20Y":"010220000","30Y":"010230000"
 };
 const out=emptyRates();
 const e=new Date(),s=new Date(Date.now()-(days+20)*86400000);
 const f=d=>d.toISOString().slice(0,10).replaceAll("-","");

 const jobs=Object.entries(codes).map(async([m,c])=>{
  const u=`https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/1000/817Y002/D/${f(s)}/${f(e)}/${c}`;
  const r=await fetch(u,{headers:{"User-Agent":"KR-US-Yield-Web/5.0"}});
  if(!r.ok) throw Error(`${m} ECOS HTTP ${r.status}`);
  const j=await r.json();
  if(j.RESULT) throw Error(`${m} ECOS ${j.RESULT.MESSAGE||j.RESULT.CODE}`);
  out[m]=(j.StatisticSearch?.row||[])
    .map(x=>({date:String(x.TIME).replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3"),value:Number(x.DATA_VALUE)}))
    .filter(x=>Number.isFinite(x.value));
 });

 const results=await Promise.allSettled(jobs);
 if(results.every(x=>x.status==="rejected")){
  throw Error("ECOS 국채금리 조회가 모두 실패했습니다. API 키와 ECOS 접근을 확인하세요.");
 }
 return out;
}

async function getUS(days){
 const y=new Date().getUTCFullYear();
 const years=days>45?[y-1,y]:[y];
 const out=emptyRates();
 const map={
  "1Y":"BC_1YEAR","2Y":"BC_2YEAR","3Y":"BC_3YEAR",
  "5Y":"BC_5YEAR","10Y":"BC_10YEAR","20Y":"BC_20YEAR","30Y":"BC_30YEAR"
 };

 for(const yr of years){
  const u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${yr}`;
  const r=await fetch(u,{headers:{"User-Agent":"KR-US-Yield-Web/5.0"}});
  if(!r.ok) throw Error(`U.S. Treasury HTTP ${r.status}`);
  const x=await r.text();

  for(const em of x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)){
   const e=em[1],dm=e.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/);
   if(!dm)continue;
   const d=dm[1].slice(0,10);
   for(const [m,f] of Object.entries(map)){
    const vm=e.match(new RegExp(`<d:${f}[^>]*>([^<]+)<\\/d:${f}>`));
    if(vm){
     const v=Number(vm[1]);
     if(Number.isFinite(v))out[m].push({date:d,value:v});
    }
   }
  }
 }

 const cut=new Date(Date.now()-days*86400000).toISOString().slice(0,10);
 for(const m in out)out[m]=out[m].filter(x=>x.date>=cut).sort((a,b)=>a.date.localeCompare(b.date));
 if(!out["10Y"].length) throw Error("U.S. Treasury 데이터가 비어 있습니다.");
 return out;
}

async function getPolicyHistory(){
  // 정책금리는 외부 공식 데이터에서 자동 갱신합니다.
  // 한국: ECOS(한국은행 기준금리), 미국: FRED 30년 이력 + 최신 FOMC 성명 즉시 반영.
  const fallback = getPolicyFallback();
  const [krR, usR] = await Promise.allSettled([getKRPolicyHistory(), getUSPolicyHistory()]);
  return {
    kr: krR.status === "fulfilled" && krR.value.length ? krR.value : fallback.kr,
    us: usR.status === "fulfilled" && usR.value.length ? usR.value : fallback.us,
    usLabel:"미국 기준금리(목표범위 상단)"
  };
}

async function getKRPolicyHistory(){
  const key=process.env.ECOS_API_KEY;
  if(!key) throw Error("ECOS_API_KEY가 없습니다.");
  const end=new Date(), start=new Date(); start.setUTCFullYear(end.getUTCFullYear()-31);
  const f=d=>d.toISOString().slice(0,10).replaceAll("-","");
  // ECOS: 한국은행 기준금리 (통계표 722Y001 / 항목 0101000)
  const u=`https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/10000/722Y001/D/${f(start)}/${f(end)}/0101000`;
  const r=await fetch(u,{headers:{"User-Agent":"KR-US-Yield-Web/9.0"}});
  if(!r.ok) throw Error(`ECOS 기준금리 HTTP ${r.status}`);
  const j=await r.json();
  if(j.RESULT) throw Error(`ECOS 기준금리 ${j.RESULT.MESSAGE||j.RESULT.CODE}`);
  const daily=(j.StatisticSearch?.row||[]).map(x=>({
    date:String(x.TIME).replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3"), value:Number(x.DATA_VALUE)
  })).filter(x=>Number.isFinite(x.value)).sort((a,b)=>a.date.localeCompare(b.date));
  return changesOnly(daily);
}

async function getUSPolicyHistory(){
  const start=new Date(); start.setUTCFullYear(start.getUTCFullYear()-31);
  const cosd=start.toISOString().slice(0,10);
  // FRED의 Federal Funds Target Range - Upper Limit(DFEDTARU), API key 불필요 CSV.
  const u=`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU&cosd=${cosd}`;
  const r=await fetch(u,{headers:{"User-Agent":"KR-US-Yield-Web/9.0"}});
  if(!r.ok) throw Error(`FRED 기준금리 HTTP ${r.status}`);
  const csv=await r.text();
  const daily=csv.trim().split(/\r?\n/).slice(1).map(line=>{
    const [date,val]=line.split(','); return {date,value:Number(val)};
  }).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isFinite(x.value));
  let hist=changesOnly(daily);

  // FRED는 새 목표범위의 효력발생일 전에는 이전 값을 보일 수 있어,
  // 최신 FOMC 성명을 공식 Fed 사이트에서 읽어 발표 즉시 상단값을 보완합니다.
  try{
    const latest=await getLatestFOMCTargetUpper();
    if(latest && (!hist.length || latest.date>=hist.at(-1).date)){
      if(!hist.length || hist.at(-1).value!==latest.value) hist.push(latest);
      else if(latest.date>hist.at(-1).date) hist[hist.length-1]=latest;
    }
  }catch(_){ /* FRED 값은 계속 사용 */ }
  return hist;
}

async function getLatestFOMCTargetUpper(){
  const home=await fetch('https://www.federalreserve.gov/monetarypolicy.htm',{headers:{"User-Agent":"KR-US-Yield-Web/9.0"}});
  if(!home.ok) throw Error('Fed monetary policy page failed');
  const html=await home.text();
  const links=[...html.matchAll(/href=["']([^"']*\/newsevents\/pressreleases\/monetary\d{8}a\.htm)["']/gi)]
    .map(m=>m[1]);
  if(!links.length) throw Error('Latest FOMC statement link not found');
  const href=links[0].startsWith('http')?links[0]:`https://www.federalreserve.gov${links[0]}`;
  const rr=await fetch(href,{headers:{"User-Agent":"KR-US-Yield-Web/9.0"}});
  if(!rr.ok) throw Error('Latest FOMC statement failed');
  const text=(await rr.text()).replace(/<[^>]+>/g,' ').replace(/&frasl;|&#8260;/g,'/').replace(/&ndash;|&#8211;/g,'-').replace(/&nbsp;/g,' ');
  const dm=href.match(/monetary(\d{4})(\d{2})(\d{2})a\.htm/i);
  const date=dm?`${dm[1]}-${dm[2]}-${dm[3]}`:new Date().toISOString().slice(0,10);
  const m=text.match(/target range[\s\S]{0,180}?to\s+([0-9]+(?:\s*[- ]\s*[0-9]+\/[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*(?:percent|per cent)/i);
  if(!m) throw Error('FOMC target range parse failed');
  return {date,value:parseRate(m[1])};
}

function parseRate(s){
  s=String(s).trim().replace(/\s+/g,' ');
  const mixed=s.match(/^(\d+)\s*[- ]\s*(\d+)\/(\d+)$/);
  if(mixed) return Number(mixed[1])+Number(mixed[2])/Number(mixed[3]);
  const frac=s.match(/^(\d+)\/(\d+)$/);
  if(frac) return Number(frac[1])/Number(frac[2]);
  return Number(s);
}

function changesOnly(rows){
  const out=[]; let prev;
  for(const x of rows){
    if(!Number.isFinite(x.value)) continue;
    if(prev===undefined || x.value!==prev){ out.push({date:x.date,value:x.value}); prev=x.value; }
  }
  return out;
}

function getPolicyFallback(){
  // 최근 30년 정책금리 추이(1996-08-10 이후).
  // 한국: 콜금리 목표제/기준금리 체계의 대표 정책금리 변경 이력.
  // 미국: Federal Funds Target Range 상단값 기준.
  const kr = [
    ["1996-08-10",12.00],
    ["1997-11-01",12.50],
    ["1997-12-01",18.00],
    ["1998-01-01",22.00],
    ["1998-04-01",18.00],
    ["1998-06-01",15.00],
    ["1998-09-01",12.00],
    ["1998-12-01",8.00],
    ["1999-02-01",5.00],
    ["2000-02-10",5.25],
    ["2000-10-05",5.25],
    ["2001-02-08",5.00],
    ["2001-07-05",4.75],
    ["2001-08-09",4.50],
    ["2001-09-19",4.00],
    ["2002-05-07",4.25],
    ["2003-05-13",4.00],
    ["2003-07-10",3.75],
    ["2004-08-12",3.50],
    ["2004-11-11",3.25],
    ["2005-10-11",3.50],
    ["2005-12-08",3.75],
    ["2006-02-09",4.00],
    ["2006-06-08",4.25],
    ["2006-08-10",4.50],
    ["2007-07-12",4.75],
    ["2007-08-09",5.00],
    ["2008-08-07",5.25],
    ["2008-10-09",5.00],
    ["2008-10-27",4.25],
    ["2008-11-07",4.00],
    ["2008-12-11",3.00],
    ["2009-01-09",2.50],
    ["2009-02-12",2.00],
    ["2010-07-09",2.25],
    ["2010-11-16",2.50],
    ["2011-01-13",2.75],
    ["2011-03-10",3.00],
    ["2011-06-10",3.25],
    ["2012-07-12",3.00],
    ["2012-10-11",2.75],
    ["2013-05-09",2.50],
    ["2014-08-14",2.25],
    ["2014-10-15",2.00],
    ["2015-03-12",1.75],
    ["2015-06-11",1.50],
    ["2016-06-09",1.25],
    ["2017-11-30",1.50],
    ["2018-11-30",1.75],
    ["2019-07-18",1.50],
    ["2019-10-16",1.25],
    ["2020-03-17",0.75],
    ["2020-05-28",0.50],
    ["2021-08-26",0.75],
    ["2021-11-25",1.00],
    ["2022-01-14",1.25],
    ["2022-04-14",1.50],
    ["2022-05-26",1.75],
    ["2022-07-13",2.25],
    ["2022-08-25",2.50],
    ["2022-10-12",3.00],
    ["2022-11-24",3.25],
    ["2023-01-13",3.50],
    ["2024-10-11",3.25],
    ["2024-11-28",3.00],
    ["2025-02-25",2.75],
    ["2025-05-29",2.50],
    ["2026-07-16",2.75],
    ["2026-08-27",3.00]
  ].map(([date,value])=>({date,value}));

  const us = [
    ["1996-08-10",5.25],
    ["1997-03-25",5.50],
    ["1998-09-29",5.25],
    ["1998-10-15",5.00],
    ["1998-11-17",4.75],
    ["1999-06-30",5.00],
    ["1999-08-24",5.25],
    ["1999-11-16",5.50],
    ["2000-02-02",5.75],
    ["2000-03-21",6.00],
    ["2000-05-16",6.50],
    ["2001-01-03",6.00],
    ["2001-01-31",5.50],
    ["2001-03-20",5.00],
    ["2001-04-18",4.50],
    ["2001-05-15",4.00],
    ["2001-06-27",3.75],
    ["2001-08-21",3.50],
    ["2001-09-17",3.00],
    ["2001-10-02",2.50],
    ["2001-11-06",2.00],
    ["2001-12-11",1.75],
    ["2002-11-06",1.25],
    ["2003-06-25",1.00],
    ["2004-06-30",1.25],
    ["2004-08-10",1.50],
    ["2004-09-21",1.75],
    ["2004-11-10",2.00],
    ["2004-12-14",2.25],
    ["2005-02-02",2.50],
    ["2005-03-22",2.75],
    ["2005-05-03",3.00],
    ["2005-06-30",3.25],
    ["2005-08-09",3.50],
    ["2005-09-20",3.75],
    ["2005-11-01",4.00],
    ["2005-12-13",4.25],
    ["2006-01-31",4.50],
    ["2006-03-28",4.75],
    ["2006-05-10",5.00],
    ["2006-06-29",5.25],
    ["2007-09-18",4.75],
    ["2007-10-31",4.50],
    ["2007-12-11",4.25],
    ["2008-01-22",3.50],
    ["2008-01-30",3.00],
    ["2008-03-18",2.25],
    ["2008-04-30",2.00],
    ["2008-10-08",1.50],
    ["2008-10-29",1.00],
    ["2008-12-16",0.25],
    ["2015-12-16",0.50],
    ["2016-12-14",0.75],
    ["2017-03-15",1.00],
    ["2017-06-14",1.25],
    ["2017-12-13",1.50],
    ["2018-03-21",1.75],
    ["2018-06-13",2.00],
    ["2018-09-26",2.25],
    ["2018-12-19",2.50],
    ["2019-07-31",2.25],
    ["2019-09-18",2.00],
    ["2019-10-30",1.75],
    ["2020-03-03",1.25],
    ["2020-03-15",0.25],
    ["2022-03-16",0.50],
    ["2022-05-04",1.00],
    ["2022-06-15",1.75],
    ["2022-07-27",2.50],
    ["2022-09-21",3.25],
    ["2022-11-02",4.00],
    ["2022-12-14",4.50],
    ["2023-02-01",4.75],
    ["2023-03-22",5.00],
    ["2023-05-03",5.25],
    ["2023-07-26",5.50],
    ["2024-09-18",5.00],
    ["2024-11-07",4.75],
    ["2024-12-18",4.50],
    ["2025-09-17",4.25],
    ["2025-10-29",4.00],
    ["2025-12-10",3.75]
  ].map(([date,value])=>({date,value}));

  return {kr,us,usLabel:"미국 기준금리(목표범위 상단)"};
}