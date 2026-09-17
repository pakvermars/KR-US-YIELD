// api/yields.js 회귀 테스트.  실행: npm test
//
// 모든 업스트림을 stub 으로 대체하므로 네트워크도 API 키도 필요 없습니다.
//
//  A. 업스트림이 응답하지 않아도 핸들러가 유한 시간에 끝나는가
//  B. 정상 데이터가 올바르게 파싱되는가
//  C. 실시간 데이터가 하드코딩 이력에 올바르게 접합되는가
//  D. 소스 일부가 죽어도 최신 금리가 반영되고 과거 이력이 보존되는가
//
// 과거에 실제로 깨졌던 지점은 [회귀] 로 표시했습니다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.ECOS_API_KEY = "TESTKEY";

// package.json 에 "type":"module" 이 없어 .js 는 CommonJS 로 읽힙니다.
// 프로덕션 설정을 건드리지 않으려고 임시 .mjs 사본을 만들어 불러옵니다.
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "api", "yields.js");
const tmp = path.join(os.tmpdir(), `yields-${process.pid}.mjs`);
fs.writeFileSync(tmp, fs.readFileSync(SRC));
process.on("exit", () => { try { fs.unlinkSync(tmp); } catch {} });
const { default: handler } = await import(pathToFileURL(tmp).href);

const iso = (d) => d.toISOString().slice(0, 10);
const compact = (s) => s.replaceAll("-", "");
const addDays = (s, n) => iso(new Date(new Date(s).getTime() + n * 86400000));
const WINDOW_YEARS = 3;
const ws = (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - WINDOW_YEARS); return iso(d); })();

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}
const has = (rows, date, value) => rows.some((x) => x.date === date && x.value === value);

function mockRes() {
  const r = { headers: {}, code: null, body: null };
  r.finished = new Promise((res) => { r._done = res; });
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; r._done(o); return r; };
  return r;
}

function race(p, ms) {
  let t;
  return Promise.race([p.finally(() => clearTimeout(t)),
    new Promise((r) => { t = setTimeout(() => r("__PENDING__"), ms); })]);
}

async function run(fetchImpl, { days = 30, budgetMs = 30000 } = {}) {
  global.fetch = fetchImpl;
  const res = mockRes();
  const t0 = Date.now();
  const out = await race(
    Promise.resolve(handler({ query: { days: String(days) } }, res)).then(() => res.finished), budgetMs);
  return { out, ms: Date.now() - t0, res };
}

// 응답하지 않는 업스트림. 실제 fetch 처럼 AbortSignal 은 존중합니다.
const hangingFetch = () => (_url, opts = {}) =>
  new Promise((_, rej) => {
    const s = opts.signal;
    if (!s) return;
    if (s.aborted) return rej(s.reason);
    s.addEventListener("abort", () => rej(s.reason), { once: true });
  });

const TREASURY_XML = `<feed>
<entry><content><m:properties>
<d:NEW_DATE>2026-09-15T00:00:00</d:NEW_DATE>
<d:BC_1YEAR>3.60</d:BC_1YEAR><d:BC_2YEAR>3.50</d:BC_2YEAR><d:BC_3YEAR>3.45</d:BC_3YEAR>
<d:BC_5YEAR>3.55</d:BC_5YEAR><d:BC_10YEAR>4.01</d:BC_10YEAR><d:BC_20YEAR>4.50</d:BC_20YEAR>
<d:BC_30YEAR>4.62</d:BC_30YEAR>
</m:properties></content></entry>
<entry><content><m:properties>
<d:NEW_DATE>2026-09-16T00:00:00</d:NEW_DATE>
<d:BC_1YEAR>3.62</d:BC_1YEAR><d:BC_2YEAR>3.52</d:BC_2YEAR><d:BC_3YEAR>3.47</d:BC_3YEAR>
<d:BC_5YEAR>3.57</d:BC_5YEAR><d:BC_10YEAR>4.05</d:BC_10YEAR><d:BC_20YEAR>4.54</d:BC_20YEAR>
<d:BC_30YEAR>4.66</d:BC_30YEAR>
</m:properties></content></entry>
</feed>`;

console.log(`\n(실시간 창 시작 ws=${ws})`);
console.log("\nTest A — 업스트림 무응답 시 핸들러가 끝나는가");

const a = await run(hangingFetch());
check("무응답 업스트림에도 유한 시간에 응답한다 [회귀]", a.out !== "__PENDING__", `${a.ms}ms`);
check("응답 코드가 200이다", a.res.code === 200, `code=${a.res.code}`);
check("정책금리가 fallback 으로 degrade 된다",
  a.res.body?.policySource?.kr === "fallback" && a.res.body?.policySource?.us === "fallback",
  JSON.stringify(a.res.body?.policySource));
check("policyDiag 에 실패 사유가 남는다",
  !!a.res.body?.policyDiag?.kr?.error && !!a.res.body?.policyDiag?.us?.error);

// 전량 fallback 결과를 이후 테스트의 기준선으로 씁니다.
const BASE_KR = a.res.body?.policyHistory?.kr || [];
const BASE_US = a.res.body?.policyHistory?.us || [];
check("fallback 이력이 비어있지 않다", BASE_KR.length > 50 && BASE_US.length > 50,
  `kr=${BASE_KR.length} us=${BASE_US.length}`);

// 하드코딩 이력의 마지막 날짜 이후 성명만 읽히므로, stub 도 거기에 맞춰 만듭니다.
const US_LAST = BASE_US.at(-1).date;
// U+2011(non-breaking hyphen). Fed 성명 일부 회차가 실제로 쓰는 표기입니다.
const STMT_MID = { date: addDays(US_LAST, 60), text: "at 4‑1/4 to 4‑1/2 percent", value: 4.5 };
const STMT_NEW = { date: addDays(US_LAST, 150), text: "to 4-1/2 to 4-3/4 percent", value: 4.75 };
const STMTS = [STMT_MID, STMT_NEW];

const KR_BOUNDARY = 3.5, KR_MID = { date: addDays(ws, 365), value: 3.25 };
const KR_NEW = { date: addDays(ws, 730), value: 3.0 };
const FRED_MID = { date: addDays(ws, 365), value: 5.0 }, FRED_BOUNDARY = 5.5;

function makeFetch(opts = {}) {
  const ok = (body, json) => ({ ok: true, status: 200, text: async () => body, json: async () => json });
  const boom = (m) => { throw Error(m); };
  return async (url) => {
    const u = String(url);
    if (u.includes("817Y002")) {
      return ok(null, { StatisticSearch: { row: [
        { TIME: "20260915", DATA_VALUE: "2.80" },
        { TIME: "20260916", DATA_VALUE: "2.85" },
      ]}});
    }
    if (u.includes("722Y001")) {
      if (opts.ecosPolicyFail) return boom("ECOS down");
      return ok(null, { StatisticSearch: { row: [
        { TIME: compact(ws),           DATA_VALUE: String(KR_BOUNDARY) },
        { TIME: compact(KR_MID.date),  DATA_VALUE: String(KR_MID.value) },
        { TIME: compact(KR_NEW.date),  DATA_VALUE: String(KR_NEW.value) },
      ]}});
    }
    if (u.includes("home.treasury.gov")) return ok(TREASURY_XML);
    if (u.includes("fredgraph.csv")) {
      if (opts.fredFail) return boom("FRED down");
      return ok(["observation_date,DFEDTARU", `${ws},${FRED_BOUNDARY}`,
        `${FRED_MID.date},${FRED_MID.value}`, `${US_LAST},${BASE_US.at(-1).value}`].join("\n"));
    }
    if (u.includes("fomccalendars.htm")) {
      if (opts.fomcFail) return boom("Fed calendar down");
      // 이력 마지막 날짜 이전 성명도 섞어 두어 필터링을 확인합니다.
      const ids = [compact(addDays(US_LAST, -90))]
        .concat(opts.noNewStatements ? [] : STMTS.map((x) => compact(x.date)));
      return ok(ids.map((id) => `<a href="/newsevents/pressreleases/monetary${id}a.htm">S</a>`).join("\n"));
    }
    const sm = u.match(/monetary(\d{8})a\.htm/);
    if (sm) {
      if (opts.fomcFail) return boom("Fed statement down");
      const st = STMTS.find((x) => compact(x.date) === sm[1]);
      if (!st) return boom("unexpected statement " + sm[1]);
      return ok(`<p>The Committee decided to raise the target range for the federal funds rate ${st.text}.</p>`);
    }
    throw Error("unexpected url " + u);
  };
}

console.log("\nTest B — 정상 데이터 파싱");

const b = await run(makeFetch());
check("정상 응답한다", b.out !== "__PENDING__", `${b.ms}ms`);
check("한국 10Y 최신값 = 2.85", b.res.body?.latest?.kr?.["10Y"]?.value === 2.85);
check("미국 10Y 최신값 = 4.05", b.res.body?.latest?.us?.["10Y"]?.value === 4.05);
check("미국 30Y 최신값 = 4.66", b.res.body?.latest?.us?.["30Y"]?.value === 4.66);
check("기준일이 채워진다",
  b.res.body?.latestDates?.kr === "2026-09-16" && b.res.body?.latestDates?.us === "2026-09-16",
  JSON.stringify(b.res.body?.latestDates));
check("errors 가 비어있다", (b.res.body?.errors || []).length === 0, JSON.stringify(b.res.body?.errors));

console.log("\nTest C — 실시간 데이터의 이력 접합");

const kr = b.res.body?.policyHistory?.kr || [];
const us = b.res.body?.policyHistory?.us || [];
check("정책금리 출처가 live 다",
  b.res.body?.policySource?.kr === "live" && b.res.body?.policySource?.us === "live",
  JSON.stringify(b.res.body?.policySource));
check("한국 최신값이 실시간 값으로 갱신된다", has([kr.at(-1)], KR_NEW.date, KR_NEW.value),
  JSON.stringify(kr.at(-1)));
check("경계 중복이 제거된다 (창 시작일 항목이 생기지 않음) [회귀]", !kr.some((x) => x.date === ws));
check("창 이전 이력이 보존된다 (1996 시작점 유지)",
  kr[0]?.date === "1996-08-10" && us[0]?.date === "1996-08-10",
  `kr[0]=${kr[0]?.date} us[0]=${us[0]?.date}`);
check("이력이 날짜 오름차순이고 값이 연속 중복되지 않는다",
  kr.every((x, i) => !i || (x.date > kr[i - 1].date && x.value !== kr[i - 1].value)) &&
  us.every((x, i) => !i || (x.date > us[i - 1].date && x.value !== us[i - 1].value)));
check("미국 최신값이 최신 성명값이다", has([us.at(-1)], STMT_NEW.date, STMT_NEW.value),
  JSON.stringify(us.at(-1)));
check("U+2011 을 쓴 성명도 파싱되어 이력에 남는다 [회귀]", has(us, STMT_MID.date, STMT_MID.value),
  `${STMT_MID.date} ${STMT_MID.value}`);
check("이력 마지막 날짜 이전 성명은 읽지 않는다",
  (b.res.body?.policyDiag?.us?.fomc || "").startsWith("2건"), b.res.body?.policyDiag?.us?.fomc);

console.log("\nTest D — 부분 장애에서의 동작");

const d1 = await run(makeFetch({ fredFail: true }));
const dUs = d1.res.body?.policyHistory?.us || [];
check("FRED 실패해도 미국은 live 를 유지한다", d1.res.body?.policySource?.us === "live",
  JSON.stringify(d1.res.body?.policyDiag?.us));
check("FRED 실패해도 최신값이 최신 성명값이다", has([dUs.at(-1)], STMT_NEW.date, STMT_NEW.value),
  JSON.stringify(dUs.at(-1)));
check("FRED 실패해도 중간 성명 변경점이 남는다 [회귀]", has(dUs, STMT_MID.date, STMT_MID.value));
check("FRED 실패 시 과거 이력이 줄지 않는다 [회귀]", dUs.length >= BASE_US.length,
  `${BASE_US.length} -> ${dUs.length}`);
check("FRED 실패 시 fallback 의 모든 변경점이 보존된다 [회귀]",
  BASE_US.every((x) => has(dUs, x.date, x.value)));

const d2 = await run(makeFetch({ fomcFail: true }));
check("FOMC 실패해도 미국은 live 를 유지한다(FRED 사용)",
  d2.res.body?.policySource?.us === "live", JSON.stringify(d2.res.body?.policyDiag?.us));

const d3 = await run(makeFetch({ fredFail: true, fomcFail: true }));
check("두 소스 모두 실패하면 fallback 으로 degrade 된다",
  d3.res.body?.policySource?.us === "fallback", JSON.stringify(d3.res.body?.policyDiag?.us));
check("두 소스 실패 시 이력은 fallback 그대로다",
  JSON.stringify(d3.res.body?.policyHistory?.us) === JSON.stringify(BASE_US));

// FRED 가 살아있으면 창 구간이 대체되므로, "새 성명 0건"만 격리하려면 함께 막습니다.
const d4 = await run(makeFetch({ noNewStatements: true, fredFail: true }));
check("새 성명이 없어도 미국은 live 다 (최신 상태 확인됨) [회귀]",
  d4.res.body?.policySource?.us === "live", JSON.stringify(d4.res.body?.policyDiag?.us));
check("새 성명이 없으면 이력이 바뀌지 않는다",
  JSON.stringify(d4.res.body?.policyHistory?.us) === JSON.stringify(BASE_US));

const d5 = await run(makeFetch({ ecosPolicyFail: true }));
check("ECOS 정책금리 실패 시 한국만 fallback, 미국은 live",
  d5.res.body?.policySource?.kr === "fallback" && d5.res.body?.policySource?.us === "live",
  JSON.stringify(d5.res.body?.policySource));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}\n`);
process.exit(failures === 0 ? 0 : 1);
