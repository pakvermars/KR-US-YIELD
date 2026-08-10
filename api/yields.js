export default async function handler(req,res){
 const days=Math.min(Math.max(parseInt(req.query.days||"30"),7),365);
 try{
  const [krResult,usResult] = await Promise.allSettled([getKR(days),getUS(days)]);
  const kr = krResult.status==="fulfilled" ? krResult.value : emptyRates();
  const us = usResult.status==="fulfilled" ? usResult.value : emptyRates();
  const errors = [];
  if(krResult.status==="rejected") errors.push("한국: "+krResult.reason.message);
  if(usResult.status==="rejected") errors.push("미국: "+usResult.reason.message);

  const policy = getPolicyHistory();
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

function getPolicyHistory(){
 // 외부 추가 호출 없이 정책금리 변경 이력을 앱에 포함해,
 // FRED 장애가 국채 API 전체를 멈추지 않도록 설계.
 const kr=[
  ["2016-08-10",1.25],["2017-11-30",1.50],["2018-11-30",1.75],
  ["2019-07-18",1.50],["2019-10-16",1.25],["2020-03-17",0.75],
  ["2020-05-28",0.50],["2021-08-26",0.75],["2021-11-25",1.00],
  ["2022-01-14",1.25],["2022-04-14",1.50],["2022-05-26",1.75],
  ["2022-07-13",2.25],["2022-08-25",2.50],["2022-10-12",3.00],
  ["2022-11-24",3.25],["2023-01-13",3.50],["2024-10-11",3.25],
  ["2024-11-28",3.00],["2025-02-25",2.75],["2025-05-29",2.50],
  ["2026-07-16",2.75]
 ].map(([date,value])=>({date,value}));

 // 미국: Federal Funds Target Range 중간값.
 const us=[
  ["2016-08-10",0.50],["2016-12-14",0.75],["2017-03-15",1.00],
  ["2017-06-14",1.25],["2017-12-13",1.50],["2018-03-21",1.75],
  ["2018-06-13",2.00],["2018-09-26",2.25],["2018-12-19",2.50],
  ["2019-07-31",2.25],["2019-09-18",2.00],["2019-10-30",1.75],
  ["2020-03-03",1.25],["2020-03-15",0.25],["2022-03-16",0.50],
  ["2022-05-04",1.00],["2022-06-15",1.75],["2022-07-27",2.50],
  ["2022-09-21",3.25],["2022-11-02",4.00],["2022-12-14",4.50],
  ["2023-02-01",4.75],["2023-03-22",5.00],["2023-05-03",5.25],
  ["2023-07-26",5.50],["2024-09-18",5.00],["2024-11-07",4.75],
  ["2024-12-18",4.50],["2025-09-17",4.25],["2025-10-29",4.00],
  ["2025-12-10",3.75]
 ].map(([date,value])=>({date,value}));

 return {kr,us,usLabel:"미국 기준금리(목표범위 상단)"};
}
