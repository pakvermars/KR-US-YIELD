// 타임아웃 예산(ms). 모든 외부 호출은 반드시 이 안에서 끝나거나 중단됩니다.
const T={ecosYield:8000,treasury:8000,ecosPolicy:9000,fred:9000,fedPage:6000,fedEnrich:13000,policyAll:20000};

// 응답하지 않고 매달리는 업스트림을 확실히 끊습니다.
// AbortSignal.timeout 이 없으면 try/catch 가 영원히 발동하지 않습니다.
async function fetchT(url,opts={},ms=8000,label="요청"){
  try{
    return await fetch(url,{...opts,signal:AbortSignal.timeout(ms)});
  }catch(e){
    if(e?.name==="TimeoutError"||e?.name==="AbortError")throw Error(`${label} 시간 초과(${ms}ms)`);
    throw Error(`${label} 실패: ${e?.message||e}`);
  }
}

// 본문 수신(r.json()/r.text())도 시그널에 의해 중단될 수 있습니다.
// fetchT 는 헤더까지만 보호하므로 본문은 따로 감싸 사유를 남깁니다.
async function bodyT(p,label){
  try{return await p}catch(e){
    if(e?.name==="TimeoutError"||e?.name==="AbortError")throw Error(`${label} 본문 수신 시간 초과`);
    throw Error(`${label} 본문 오류: ${e?.message||e}`);
  }
}

// 중첩 호출까지 포함해 프로미스 자체에 상한을 두는 2차 방어선.
function withTimeout(promise,ms,label){
  let t;
  return Promise.race([
    promise.finally(()=>clearTimeout(t)),
    new Promise((_,rej)=>{t=setTimeout(()=>rej(Error(`${label} 시간 초과(${ms}ms)`)),ms)})
  ]);
}

export default async function handler(req,res){
  const days=Math.min(Math.max(parseInt(req.query.days||"30",10),7),365);
  try{
    const [krR,usR,policyR]=await Promise.allSettled([getKR(days),getUS(days),getPolicyHistory()]);
    const kr=krR.status==="fulfilled"?krR.value:emptyRates();
    const us=usR.status==="fulfilled"?usR.value:emptyRates();
    const policy=policyR.status==="fulfilled"?policyR.value:{...getPolicyFallback(),krSource:"fallback",usSource:"fallback"};
    const errors=[];
    if(krR.status==="rejected")errors.push("한국 국채: "+krR.reason.message);
    if(usR.status==="rejected")errors.push("미국 국채: "+usR.reason.message);
    if(policyR.status==="rejected")errors.push("정책금리: "+policyR.reason.message);
    const mats=["1Y","2Y","3Y","5Y","10Y","20Y","30Y"],latest={kr:{},us:{}};
    for(const m of mats){latest.kr[m]=lt(kr[m]||[]);latest.us[m]=lt(us[m]||[])}
    res.setHeader("Cache-Control","s-maxage=60, stale-while-revalidate=120");
    res.status(200).json({latestDates:{kr:latest.kr["10Y"].date,us:latest.us["10Y"].date},latest,policyHistory:policy,policySource:{kr:policy.krSource||"live",us:policy.usSource||"live"},policyDiag:policy.diag||null,errors});
  }catch(e){res.status(500).json({error:e.message||"server error"})}
}

function emptyRates(){return {"1Y":[],"2Y":[],"3Y":[],"5Y":[],"10Y":[],"20Y":[],"30Y":[]}}
function lt(a){if(!a.length)return{date:null,value:null,changeBp:null};a=[...a].sort((x,y)=>x.date.localeCompare(y.date));const c=a.at(-1),p=a.at(-2);return{date:c.date,value:c.value,changeBp:p?(c.value-p.value)*100:null}}
function ymd(d){return d.toISOString().slice(0,10).replaceAll("-","")}

async function getKR(days){
  const key=process.env.ECOS_API_KEY;if(!key)throw Error("ECOS_API_KEY가 없습니다.");
  const codes={"1Y":"010190000","2Y":"010195000","3Y":"010200000","5Y":"010200001","10Y":"010210000","20Y":"010220000","30Y":"010230000"};
  const out=emptyRates(),end=new Date(),start=new Date(Date.now()-(days+20)*86400000);
  const jobs=Object.entries(codes).map(async([m,c])=>{
    const u=`https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/1000/817Y002/D/${ymd(start)}/${ymd(end)}/${c}`;
    const r=await fetchT(u,{headers:{"User-Agent":"KR-US-Yield-Web/10.0"}},T.ecosYield,`${m} ECOS`);if(!r.ok)throw Error(`${m} ECOS HTTP ${r.status}`);
    const j=await bodyT(r.json(),`${m} ECOS`);if(j.RESULT)throw Error(`${m} ECOS ${j.RESULT.MESSAGE||j.RESULT.CODE}`);
    out[m]=(j.StatisticSearch?.row||[]).map(x=>({date:String(x.TIME).replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3"),value:Number(x.DATA_VALUE)})).filter(x=>Number.isFinite(x.value));
  });
  const rr=await Promise.allSettled(jobs);if(rr.every(x=>x.status==="rejected"))throw Error("ECOS 국채금리 조회 실패");return out;
}

async function getUS(days){
  const year=new Date().getUTCFullYear(),years=days>45?[year-1,year]:[year],out=emptyRates();
  const map={"1Y":"BC_1YEAR","2Y":"BC_2YEAR","3Y":"BC_3YEAR","5Y":"BC_5YEAR","10Y":"BC_10YEAR","20Y":"BC_20YEAR","30Y":"BC_30YEAR"};
  for(const yr of years){
    const u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${yr}`;
    const r=await fetchT(u,{headers:{"User-Agent":"KR-US-Yield-Web/10.0"}},T.treasury,`U.S. Treasury ${yr}`);if(!r.ok)throw Error(`U.S. Treasury HTTP ${r.status}`);const x=await bodyT(r.text(),`U.S. Treasury ${yr}`);
    for(const em of x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)){const e=em[1],dm=e.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/);if(!dm)continue;const d=dm[1].slice(0,10);for(const[m,f]of Object.entries(map)){const vm=e.match(new RegExp(`<d:${f}[^>]*>([^<]+)<\\/d:${f}>`));if(vm&&Number.isFinite(Number(vm[1])))out[m].push({date:d,value:Number(vm[1])})}}
  }
  const cut=new Date(Date.now()-days*86400000).toISOString().slice(0,10);for(const m in out)out[m]=out[m].filter(x=>x.date>=cut).sort((a,b)=>a.date.localeCompare(b.date));if(!out["10Y"].length)throw Error("U.S. Treasury 데이터가 비어 있습니다.");return out;
}

// 정책금리는 최근 N년 구간만 실시간으로 받아 하드코딩 이력 위에 접합합니다.
// 31년치를 한 번에 받으면 응답 본문이 커서 함수 예산 안에 들어오지 못합니다.
const POLICY_WINDOW_YEARS=3;

function policyWindowStart(){
  const d=new Date();d.setUTCFullYear(d.getUTCFullYear()-POLICY_WINDOW_YEARS);
  return d;
}

// 실시간 구간을 fallback 이력에 접합합니다.
// changesOnly 가 경계에서 값이 같은 항목을 걸러내므로 변경일이 중복되지 않습니다.
function mergePolicy(fallbackRows,liveRows,windowStart){
  return changesOnly(fallbackRows.filter(x=>x.date<windowStart).concat(liveRows));
}

async function getPolicyHistory(){
  const fb=getPolicyFallback();
  const ws=policyWindowStart().toISOString().slice(0,10);
  const timed=async fn=>{const t0=Date.now();try{return{ok:true,ms:Date.now()-t0,value:await fn(ws)}}catch(e){return{ok:false,ms:Date.now()-t0,error:e.message}}};
  let kr,us;
  try{
    [kr,us]=await withTimeout(Promise.all([timed(getKRPolicyHistory),timed(getUSPolicyHistory)]),T.policyAll,"정책금리 조회");
  }catch(e){
    return{...fb,krSource:"fallback",usSource:"fallback",diag:{window:ws,kr:{ok:false,error:e.message},us:{ok:false,error:e.message}}};
  }
  const krOk=!!(kr.ok&&kr.value.length),usOk=!!(us.ok&&us.value.rows.length);
  return{
    kr:krOk?mergePolicy(fb.kr,kr.value,ws):fb.kr,
    us:usOk?mergePolicy(fb.us,us.value.rows,ws):fb.us,
    krSource:krOk?"live":"fallback",
    usSource:usOk?"live":"fallback",
    diag:{window:ws,
      kr:{ok:krOk,ms:kr.ms,error:kr.error||null,n:kr.ok?kr.value.length:0},
      us:{ok:usOk,ms:us.ms,error:us.error||null,n:us.ok?us.value.rows.length:0,
          fred:us.ok?us.value.fred:null,fomc:us.ok?us.value.fomc:null}},
    usLabel:"미국 기준금리(목표범위 상단)"
  };
}

async function getKRPolicyHistory(ws){
  const key=process.env.ECOS_API_KEY;if(!key)throw Error("ECOS_API_KEY가 없습니다.");
  const u=`https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/5000/722Y001/D/${ymd(new Date(ws))}/${ymd(new Date())}/0101000`;
  const r=await fetchT(u,{headers:{"User-Agent":"KR-US-Yield-Web/10.0"}},T.ecosPolicy,"ECOS 기준금리");if(!r.ok)throw Error(`ECOS 기준금리 HTTP ${r.status}`);
  const j=await bodyT(r.json(),"ECOS 기준금리");if(j.RESULT)throw Error(j.RESULT.MESSAGE||j.RESULT.CODE);
  return changesOnly((j.StatisticSearch?.row||[]).map(x=>({date:String(x.TIME).replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3"),value:Number(x.DATA_VALUE)})).filter(x=>Number.isFinite(x.value)).sort((a,b)=>a.date.localeCompare(b.date)));
}

async function getFredUpper(ws){
  const r=await fetchT(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU&cosd=${ws}`,{headers:{"User-Agent":"KR-US-Yield-Web/10.0"}},T.fred,"FRED 기준금리");if(!r.ok)throw Error(`FRED HTTP ${r.status}`);
  const csv=await bodyT(r.text(),"FRED 기준금리");
  return changesOnly(csv.trim().split(/\r?\n/).slice(1).map(line=>{const p=line.split(',');return{date:p[0],value:p[1]&&p[1]!=='.'?Number(p[1]):NaN}}).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isFinite(x.value)));
}

// FRED 는 새 목표범위의 효력발생일 전까지 이전 값을 보입니다.
// 두 소스를 병렬로 받아 하나만 살아도 최신 금리가 반영되게 합니다.
async function getUSPolicyHistory(ws){
  const [fredR,fomcR]=await Promise.allSettled([getFredUpper(ws),withTimeout(getLatestFOMCTargetUpper(),T.fedEnrich,"FOMC 성명")]);
  const rows=fredR.status==="fulfilled"?[...fredR.value]:[];
  const fomc=fomcR.status==="fulfilled"?fomcR.value:null;
  if(fomc)rows.push(fomc);
  if(!rows.length)throw Error(`FRED: ${fredR.reason?.message}; FOMC: ${fomcR.reason?.message}`);
  rows.sort((a,b)=>a.date.localeCompare(b.date));
  return{rows,
    fred:fredR.status==="fulfilled"?`${fredR.value.length}건`:`실패: ${fredR.reason?.message}`,
    fomc:fomc?`${fomc.date} ${fomc.value}`:`실패: ${fomcR.reason?.message}`};
}

async function getLatestFOMCTargetUpper(){
  const home=await fetchT("https://www.federalreserve.gov/monetarypolicy.htm",{headers:{"User-Agent":"Mozilla/5.0 KR-US-Yield-Web/10.0"},cache:"no-store"},T.fedPage,"Fed 통화정책 페이지");if(!home.ok)throw Error(`Fed page HTTP ${home.status}`);
  const html=await bodyT(home.text(),"Fed 통화정책 페이지");
  const ids=[...html.matchAll(/monetary(\d{8})a\.htm/gi)].map(m=>m[1]).sort().reverse();if(!ids.length)throw Error("FOMC statement not found");
  const id=ids[0],href=`https://www.federalreserve.gov/newsevents/pressreleases/monetary${id}a.htm`;
  const rr=await fetchT(href,{headers:{"User-Agent":"Mozilla/5.0 KR-US-Yield-Web/10.0"},cache:"no-store"},T.fedPage,"FOMC 성명");if(!rr.ok)throw Error(`FOMC statement HTTP ${rr.status}`);
  const text=decodeHtml(await bodyT(rr.text(),"FOMC 성명")).replace(/<[^>]+>/g," ").replace(/\s+/g," ");
  const m=text.match(/target range[\s\S]{0,240}?to\s+((?:\d+\s*[- ]\s*)?\d+\/\d+|\d+(?:\.\d+)?)\s*(?:percent|per cent)/i);if(!m)throw Error("FOMC target range parse failed");
  return{date:`${id.slice(0,4)}-${id.slice(4,6)}-${id.slice(6,8)}`,value:parseRate(m[1])};
}
function decodeHtml(s){return s.replace(/&frasl;|&#8260;/gi,"/").replace(/&ndash;|&#8211;|&minus;/gi,"-").replace(/&nbsp;|&#160;/gi," ").replace(/&frac14;/gi,"1/4").replace(/&frac12;/gi,"1/2").replace(/&frac34;/gi,"3/4")}
function parseRate(s){s=String(s).trim().replace(/\s+/g," ");let m=s.match(/^(\d+)\s*[- ]\s*(\d+)\/(\d+)$/);if(m)return Number(m[1])+Number(m[2])/Number(m[3]);m=s.match(/^(\d+)\/(\d+)$/);if(m)return Number(m[1])/Number(m[2]);return Number(s)}
function changesOnly(rows){const out=[];let prev;for(const x of rows){if(!Number.isFinite(x.value))continue;if(prev===undefined||x.value!==prev){out.push({date:x.date,value:x.value});prev=x.value}}return out}

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
