export default async function handler(req,res){
 const days=Math.min(Math.max(parseInt(req.query.days||"30"),7),365);
 try{
  const [kr,us,policy]=await Promise.all([getKR(days),getUS(days),getPolicyHistory()]),mats=["1Y","2Y","3Y","5Y","10Y","20Y","30Y"],latest={kr:{},us:{}};
  for(const m of mats){latest.kr[m]=lt(kr[m]||[]);latest.us[m]=lt(us[m]||[])}
  const sp=(a,b)=>a?.value!=null&&b?.value!=null?(a.value-b.value)*100:null;
  res.setHeader("Cache-Control","s-maxage=900, stale-while-revalidate=1800");
  res.status(200).json({latestDates:{kr:latest.kr["10Y"].date,us:latest.us["10Y"].date},latest,
   spreads:{kr2s10:sp(latest.kr["10Y"],latest.kr["2Y"]),us2s10:sp(latest.us["10Y"],latest.us["2Y"]),kr3s10:sp(latest.kr["10Y"],latest.kr["3Y"]),us3s10:sp(latest.us["10Y"],latest.us["3Y"])},
   history:{kr:kr["10Y"]||[],us:us["10Y"]||[]},policyHistory:policy});
 }catch(e){res.status(500).json({error:e.message||"server error"})}
}
function lt(a){if(!a.length)return{date:null,value:null,changeBp:null};a=[...a].sort((x,y)=>x.date.localeCompare(y.date));let c=a.at(-1),p=a.at(-2);return{date:c.date,value:c.value,changeBp:p?(c.value-p.value)*100:null}}
async function getKR(days){
 const key=process.env.ECOS_API_KEY;if(!key)throw Error("ECOS_API_KEY가 서버에 설정되지 않았습니다.");
 const codes={"1Y":"010190000","2Y":"010195000","3Y":"010200000","5Y":"010200001","10Y":"010210000","20Y":"010220000","30Y":"010230000"},out={};
 const e=new Date(),s=new Date(Date.now()-(days+20)*86400000),f=d=>d.toISOString().slice(0,10).replaceAll("-","");
 await Promise.all(Object.entries(codes).map(async([m,c])=>{let u=`https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/1000/817Y002/D/${f(s)}/${f(e)}/${c}`,r=await fetch(u);
  if(!r.ok)throw Error("ECOS HTTP "+r.status);let j=await r.json();if(j.RESULT)throw Error("ECOS: "+(j.RESULT.MESSAGE||j.RESULT.CODE));
  out[m]=(j.StatisticSearch?.row||[]).map(x=>({date:String(x.TIME).replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3"),value:Number(x.DATA_VALUE)})).filter(x=>Number.isFinite(x.value));}));
 return out;
}
async function getUS(days){
 const y=new Date().getUTCFullYear(),years=days>45?[y-1,y]:[y],out={"1Y":[],"2Y":[],"3Y":[],"5Y":[],"10Y":[],"20Y":[],"30Y":[]};
 const map={"1Y":"BC_1YEAR","2Y":"BC_2YEAR","3Y":"BC_3YEAR","5Y":"BC_5YEAR","10Y":"BC_10YEAR","20Y":"BC_20YEAR","30Y":"BC_30YEAR"};
 for(const yr of years){let u=`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${yr}`,r=await fetch(u);if(!r.ok)throw Error("U.S. Treasury HTTP "+r.status);let x=await r.text();
  for(const em of x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)){let e=em[1],dm=e.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/);if(!dm)continue;let d=dm[1].slice(0,10);
   for(const [m,f] of Object.entries(map)){let vm=e.match(new RegExp(`<d:${f}[^>]*>([^<]+)<\\/d:${f}>`));if(vm){let v=Number(vm[1]);if(Number.isFinite(v))out[m].push({date:d,value:v})}}}}
 const cut=new Date(Date.now()-days*86400000).toISOString().slice(0,10);for(const m in out)out[m]=out[m].filter(x=>x.date>=cut).sort((a,b)=>a.date.localeCompare(b.date));return out;
}

async function getPolicyHistory(){
  const startDate = new Date();
  startDate.setUTCFullYear(startDate.getUTCFullYear()-10);
  const start = startDate.toISOString().slice(0,10);

  // Bank of Korea: official base-rate change history.
  // Include a baseline point at the 10-year window start, then actual change dates.
  const krChanges = [
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
    ["2026-07-16",2.75]
  ];

  let base = krChanges[0][1];
  for(const [d,v] of krChanges){ if(d<=start) base=v; }
  const kr = [{date:start,value:base}];
  for(const [d,v] of krChanges){ if(d>start) kr.push({date:d,value:v}); }

  // U.S.: midpoint of FOMC federal funds target range.
  const ids = ["DFEDTARL","DFEDTARU"];
  const series = {};
  for(const id of ids){
    const url=`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`;
    const r=await fetch(url,{headers:{"User-Agent":"KR-US-Yield-Web/4.0"}});
    if(!r.ok) throw Error(`FRED policy-rate HTTP ${r.status}`);
    const text=await r.text();
    const lines=text.trim().split(/\r?\n/);
    const arr=[];
    for(let i=1;i<lines.length;i++){
      const p=lines[i].split(",");
      if(p.length<2 || p[1]==="." || p[1]==="") continue;
      const v=Number(p[1]);
      if(Number.isFinite(v)) arr.push({date:p[0],value:v});
    }
    series[id]=arr;
  }

  const low=Object.fromEntries(series.DFEDTARL.map(x=>[x.date,x.value]));
  const high=Object.fromEntries(series.DFEDTARU.map(x=>[x.date,x.value]));
  const dates=[...new Set([...Object.keys(low),...Object.keys(high)])].sort();

  const us=[];
  let lastLow=null,lastHigh=null,lastMid=null;
  for(const d of dates){
    if(low[d]!=null) lastLow=low[d];
    if(high[d]!=null) lastHigh=high[d];
    if(lastLow==null || lastHigh==null) continue;
    const mid=(lastLow+lastHigh)/2;
    if(lastMid===null || Math.abs(mid-lastMid)>1e-9){
      us.push({date:d,value:mid,low:lastLow,high:lastHigh});
      lastMid=mid;
    }
  }

  return {kr,us,usLabel:"미국 기준금리(목표범위 중간값)"};
}
