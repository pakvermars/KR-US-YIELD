export default async function handler(req,res){
  const days=Math.min(Math.max(parseInt(req.query.days||"30",10),7),365);
  try{
    const [krR,usR,policyR]=await Promise.allSettled([getKR(days),getUS(days),getPolicyHistory()]);
    const kr=krR.status==="fulfilled"?krR.value:emptyRates();
    const us=usR.status==="fulfilled"?usR.value:emptyRates();
    const policy=policyR.status==="fulfilled"?policyR.value:{kr:[],us:[],usLabel:"미국 기준금리(목표범위 상단)"};
    const errors=[];
    if(krR.status==="rejected")errors.push("한국 국채: "+krR.reason.message);
    if(usR.status==="rejected")errors.push("미국 국채: "+usR.reason.message);
    if(policyR.status==="rejected")errors.push("정책금리: "+policyR.reason.message);
    const mats=["1Y","2Y","3Y","5Y","10Y","20Y","30Y"],latest={kr:{},us:{}};
    for(const m of mats){latest.kr[m]=lt(kr[m]||[]);latest.us[m]=lt(us[m]||[])}
    res.setHeader("Cache-Control","s-maxage=60, stale-while-revalidate=120");
    res.status(200).json({latestDates:{kr:latest.kr["10Y"].date,us:latest.us["10Y"].date},latest,policyHistory:policy,errors});
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
    const r=await fetch(u,{headers:{"User-Agent":"KR-US-Yield-Web/10.0"}});if(!r.ok)throw Error(`${m} ECOS HTTP ${r.status}`);
    const j=await r.json();if(j.RESULT)throw Error(`${m} ECOS ${j.RESULT.MESSAGE||j.RESULT.CODE}`);
    out[m]=(j.StatisticSearch?.row||[]).map(x=>({date:String(x.TIME).replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3"),value:Number(x.DATA_VALUE)})).filter(x=>Number.isFinite(x.value));
  });
  const rr=await Promise.allSettled(jobs);if(rr.every(x=>x.status==="rejected"))throw Error("ECOS 국채금리 조회 실패");return out;
}

async function getUS(days){
  const year=new Date().getUTCFullYear(),years=days>45?[year-1,year]:[year],out=emptyRates();
  const map={"1Y":"BC_1YEAR","2Y":"BC_2YEAR","3Y":"BC_3YEAR","5Y":"BC_5YEAR","10Y":"BC_10YEAR","20Y":"BC_20YEAR","30Y":"BC_30YEAR"};
  for(const yr of years){
    const u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${yr}`;
    const r=await fetch(u,{headers:{"User-Agent":"KR-US-Yield-Web/10.0"}});if(!r.ok)throw Error(`U.S. Treasury HTTP ${r.status}`);const x=await r.text();
    for(const em of x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)){const e=em[1],dm=e.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/);if(!dm)continue;const d=dm[1].slice(0,10);for(const[m,f]of Object.entries(map)){const vm=e.match(new RegExp(`<d:${f}[^>]*>([^<]+)<\\/d:${f}>`));if(vm&&Number.isFinite(Number(vm[1])))out[m].push({date:d,value:Number(vm[1])})}}
  }
  const cut=new Date(Date.now()-days*86400000).toISOString().slice(0,10);for(const m in out)out[m]=out[m].filter(x=>x.date>=cut).sort((a,b)=>a.date.localeCompare(b.date));if(!out["10Y"].length)throw Error("U.S. Treasury 데이터가 비어 있습니다.");return out;
}

async function getPolicyHistory(){
  const [krR,usR]=await Promise.allSettled([getKRPolicyHistory(),getUSPolicyHistory()]);
  if(krR.status==="rejected"&&usR.status==="rejected")throw Error(`한국 ${krR.reason.message}; 미국 ${usR.reason.message}`);
  return{kr:krR.status==="fulfilled"?krR.value:[],us:usR.status==="fulfilled"?usR.value:[],usLabel:"미국 기준금리(목표범위 상단)"};
}

async function getKRPolicyHistory(){
  const key=process.env.ECOS_API_KEY;if(!key)throw Error("ECOS_API_KEY가 없습니다.");const end=new Date(),start=new Date();start.setUTCFullYear(end.getUTCFullYear()-31);
  const u=`https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/10000/722Y001/D/${ymd(start)}/${ymd(end)}/0101000`;
  const r=await fetch(u,{headers:{"User-Agent":"KR-US-Yield-Web/10.0"}});if(!r.ok)throw Error(`ECOS 기준금리 HTTP ${r.status}`);const j=await r.json();if(j.RESULT)throw Error(j.RESULT.MESSAGE||j.RESULT.CODE);
  return changesOnly((j.StatisticSearch?.row||[]).map(x=>({date:String(x.TIME).replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3"),value:Number(x.DATA_VALUE)})).filter(x=>Number.isFinite(x.value)).sort((a,b)=>a.date.localeCompare(b.date)));
}

async function getUSPolicyHistory(){
  const start=new Date();start.setUTCFullYear(start.getUTCFullYear()-31);const cosd=start.toISOString().slice(0,10);
  const r=await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU&cosd=${cosd}`,{headers:{"User-Agent":"KR-US-Yield-Web/10.0"}});if(!r.ok)throw Error(`FRED HTTP ${r.status}`);
  const csv=await r.text();const daily=csv.trim().split(/\r?\n/).slice(1).map(line=>{const p=line.split(',');return{date:p[0],value:p[1]&&p[1]!=='.'?Number(p[1]):NaN}}).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isFinite(x.value));
  let hist=changesOnly(daily);
  try{const latest=await getLatestFOMCTargetUpper();if(latest&&(!hist.length||latest.date>=hist.at(-1).date)){if(!hist.length||hist.at(-1).value!==latest.value)hist.push(latest);else if(latest.date>hist.at(-1).date)hist[hist.length-1]=latest}}catch(e){console.error("Fed latest statement:",e.message)}
  return hist;
}

async function getLatestFOMCTargetUpper(){
  const home=await fetch("https://www.federalreserve.gov/monetarypolicy.htm",{headers:{"User-Agent":"Mozilla/5.0 KR-US-Yield-Web/10.0"},cache:"no-store"});if(!home.ok)throw Error(`Fed page HTTP ${home.status}`);const html=await home.text();
  const ids=[...html.matchAll(/monetary(\d{8})a\.htm/gi)].map(m=>m[1]).sort().reverse();if(!ids.length)throw Error("FOMC statement not found");
  const id=ids[0],href=`https://www.federalreserve.gov/newsevents/pressreleases/monetary${id}a.htm`;
  const rr=await fetch(href,{headers:{"User-Agent":"Mozilla/5.0 KR-US-Yield-Web/10.0"},cache:"no-store"});if(!rr.ok)throw Error(`FOMC statement HTTP ${rr.status}`);
  const text=decodeHtml(await rr.text()).replace(/<[^>]+>/g," ").replace(/\s+/g," ");
  const m=text.match(/target range[\s\S]{0,240}?to\s+((?:\d+\s*[- ]\s*)?\d+\/\d+|\d+(?:\.\d+)?)\s*(?:percent|per cent)/i);if(!m)throw Error("FOMC target range parse failed");
  return{date:`${id.slice(0,4)}-${id.slice(4,6)}-${id.slice(6,8)}`,value:parseRate(m[1])};
}
function decodeHtml(s){return s.replace(/&frasl;|&#8260;/gi,"/").replace(/&ndash;|&#8211;|&minus;/gi,"-").replace(/&nbsp;|&#160;/gi," ").replace(/&frac14;/gi,"1/4").replace(/&frac12;/gi,"1/2").replace(/&frac34;/gi,"3/4")}
function parseRate(s){s=String(s).trim().replace(/\s+/g," ");let m=s.match(/^(\d+)\s*[- ]\s*(\d+)\/(\d+)$/);if(m)return Number(m[1])+Number(m[2])/Number(m[3]);m=s.match(/^(\d+)\/(\d+)$/);if(m)return Number(m[1])/Number(m[2]);return Number(s)}
function changesOnly(rows){const out=[];let prev;for(const x of rows){if(!Number.isFinite(x.value))continue;if(prev===undefined||x.value!==prev){out.push({date:x.date,value:x.value});prev=x.value}}return out}
