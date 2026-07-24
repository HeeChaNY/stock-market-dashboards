# Stock Market Dashboards

- `/dashboard/`: 국내 주식 수급 대시보드
- `/global/`: 미국·일본·홍콩·중국A 신고·신저가 스크리너

## Cloud automation

- 국내 대시보드: 평일 18:30 KST 실행, 미완료 시 19:20 KST 재시도
- 글로벌 스크리너: 화요일~토요일 07:20 KST 실행
- GitHub Actions의 `workflow_dispatch`로 수동 재실행 가능
- 국내 데이터는 최신 거래일만 기존 이력에 병합
- 완료 시 정적 데이터, Sites API, Telegram 요약과 Excel을 함께 갱신
- API 키와 동기화 토큰은 GitHub Actions Secrets에만 저장

## Required GitHub Actions Secrets

- `KIS_APP_KEY`
- `KIS_APP_SECRET`
- `KIS_BASE_URL`
- `KRX_OPEN_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_CHAT_IDS`
- `HOSTED_DASHBOARD_URL`
- `HOSTED_DASHBOARD_SYNC_TOKEN`
- `HOSTED_DASHBOARD_AUTH_TOKEN`
- `HOSTED_GLOBAL_URL`
- `HOSTED_GLOBAL_SYNC_TOKEN`
- `HOSTED_GLOBAL_AUTH_TOKEN`
