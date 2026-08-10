# 한·미 국채 금리 웹 대시보드

## Vercel 배포
1. 이 폴더를 GitHub 저장소에 업로드
2. Vercel에서 새 프로젝트로 해당 저장소 Import
3. Settings → Environment Variables
4. 이름 `ECOS_API_KEY`, 값은 한국은행 ECOS Open API 키
5. Deploy
6. 발급된 `*.vercel.app` 주소로 PC/아이폰에서 접속

정적 HTML만 여는 방식이 아니라 `/api/yields` 서버리스 함수가 한국은행/미 재무부 API를 대신 호출합니다.
