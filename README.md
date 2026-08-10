# 한·미 국채 금리 웹 대시보드 v5

핵심 수정
- v4에서 FRED 정책금리 이력 조회 실패가 /api/yields 전체를 실패시키던 문제 제거
- 최근 10년 정책금리 이력은 앱 내부 이력으로 분리해 국채 API와 독립
- 한국 ECOS / 미국 Treasury를 Promise.allSettled로 각각 독립 조회
- 한쪽 데이터가 실패해도 다른 쪽은 정상 표시
- ECOS 일부 만기 실패 시에도 성공한 만기는 표시
- 화면 하단에 API 오류 원인을 표시

배포
기존 GitHub 저장소 파일을 이 v5 파일로 교체하고 Commit하십시오.
Vercel은 자동 재배포됩니다.

중요
Vercel > Project > Settings > Environment Variables에
ECOS_API_KEY가 Production 환경에 등록되어 있어야 합니다.
