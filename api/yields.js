export default async function handler(req,res){
 const days=Math.min(Math.max(parseInt(req.query.days||"30"),7),365);
 try{
  const [kr,us]=await Promise.all([getKR(days),getUS(days)]),mats=["1Y","2Y","3Y","5Y","10Y","20Y","30Y"],latest={kr:{},us:{}};
  for(const m of mats){latest.kr[m]=lt(kr[m]||[]);latest.us[m]=lt(us[m]||[])}
  const sp=(a,b)=>a?.value!=null&&b?.value!=null?(a.value-b.value)*100:null;
  res.setHeader("Cache-Control","s-maxage=900, stale-while-revalidate=1800");
  res.status(200).json({latestDates:{kr:latest.kr["10Y"].date,us:latest.us["10Y"].date},latest,
   spreads:{kr2s10:sp(latest.kr["10Y"],latest.kr["2Y"]),us2s10:sp(latest.us["10Y"],latest.us["2Y"]),kr3s10:sp(latest.kr["10Y"],latest.kr["3Y"]),us3s10:sp(latest.us["10Y"],latest.us["3Y"])},
   history:{kr:kr["10Y"]||[],us:us["10Y"]||[]}});
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