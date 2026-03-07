# Whispering

강단의 발표자에게 조용히 메시지를 전달하는 실시간 웹 앱.

## 기능

- **방(Room)** 기반 세션 — 같은 방 코드를 가진 사람들끼리만 통신
- **분과(Section)** — 방 안에서 그룹별 메시지 라우팅 (전체 또는 특정 분과)
- **실시간 메시지** — 긴급도(일반/주의/긴급) 선택, 즉시 전송
- **타이머** — 카운트다운 타이머 (전체 공유)
- **현재 시각** — 발표자 화면에 시계 표시
- **전체화면 모드** — 발표자 화면 전체화면 지원
- **메시지 영속성** — SQLite DB로 서버 재시작 후에도 메시지 히스토리 유지

## 로컬 실행

```bash
npm install
npm start
# → http://localhost:3000
```

## 배포

### Railway (권장)

1. [railway.app](https://railway.app) 로그인
2. **New Project → Deploy from GitHub repo** 선택
3. `tiontack/Whispering` 저장소 연결
4. 자동 배포 완료 — 도메인이 발급됩니다

> Railway는 Dockerfile을 자동으로 감지합니다. DB 파일은 볼륨에 영구 저장됩니다.

### Render

1. [render.com](https://render.com) 로그인
2. **New → Web Service → Connect a repository** 선택
3. `tiontack/Whispering` 연결, `render.yaml` 자동 감지
4. 배포 완료

### Docker 직접 실행

```bash
docker build -t whispering .
docker run -p 3000:3000 -v whispering-data:/app/data whispering
```

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 서버 포트 |
| `DB_PATH` | `./data/whispering.db` | SQLite DB 경로 |
| `NODE_ENV` | `development` | 환경 |

## 구조

```
/
├── server.js        # Express + WebSocket 서버
├── database.js      # SQLite DB 모듈
├── public/
│   ├── index.html   # 로비 (방 목록)
│   ├── coordinator.html  # 교육 담당자 화면
│   └── presenter.html    # 발표자 화면
├── Dockerfile
├── railway.json
└── render.yaml
```
