#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Whispering — 배포 자동화 설정 스크립트
#  실행: bash setup-deploy.sh
# ─────────────────────────────────────────────────────────────
set -e

BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════╗"
echo "║   Whispering 배포 자동화 설정        ║"
echo "╚══════════════════════════════════════╝${RESET}"
echo ""

# ── 1. Railway CLI 설치 확인 ────────────────────────────────
echo -e "${BOLD}[1/4] Railway CLI 확인 중...${RESET}"
if ! command -v railway &>/dev/null; then
  echo "  Railway CLI를 설치합니다..."
  npm install -g @railway/cli
  echo -e "  ${GREEN}✓ 설치 완료${RESET}"
else
  echo -e "  ${GREEN}✓ 이미 설치되어 있음${RESET}"
fi

# ── 2. Railway 로그인 ────────────────────────────────────────
echo ""
echo -e "${BOLD}[2/4] Railway 로그인${RESET}"
if ! railway whoami &>/dev/null 2>&1; then
  echo "  브라우저가 열립니다. Railway 계정으로 로그인하세요."
  echo -e "  ${YELLOW}(계정 없으면 https://railway.app 에서 무료 가입)${RESET}"
  railway login
else
  USER=$(railway whoami 2>/dev/null || echo "알 수 없음")
  echo -e "  ${GREEN}✓ 이미 로그인됨: $USER${RESET}"
fi

# ── 3. 프로젝트 연결 or 생성 ─────────────────────────────────
echo ""
echo -e "${BOLD}[3/4] Railway 프로젝트 설정${RESET}"

if [ -f ".railway/config.json" ]; then
  echo -e "  ${GREEN}✓ 기존 프로젝트 연결됨${RESET}"
else
  echo "  새 프로젝트를 생성합니다..."
  railway init --name whispering
fi

# 볼륨 마운트 안내 (데이터 영속성)
echo ""
echo -e "  ${YELLOW}📦 DB 영속성을 위해 볼륨을 추가하세요:${RESET}"
echo "     Railway 대시보드 → 서비스 → Add Volume"
echo "     Mount Path: /app/data"
echo ""

# ── 4. 첫 배포 실행 ─────────────────────────────────────────
echo -e "${BOLD}[4/4] 배포 중...${RESET}"
railway up --detach

echo ""
echo -e "${BOLD}${GREEN}✅ 배포 완료!${RESET}"
echo ""

# URL 출력
DOMAIN=$(railway domain 2>/dev/null || echo "")
if [ -n "$DOMAIN" ]; then
  echo -e "  🌐 앱 URL: ${BOLD}https://${DOMAIN}${RESET}"
else
  echo "  🌐 URL 확인: railway domain 또는 Railway 대시보드"
fi

echo ""
echo -e "${CYAN}━━━ GitHub Actions 자동 배포 설정 (선택) ━━━${RESET}"
echo ""
echo "  이후 push할 때마다 자동 배포하려면:"
echo ""
echo -e "  1. 토큰 발급: ${BOLD}railway token${RESET}"
echo "  2. GitHub 저장소 → Settings → Secrets → Actions"
echo "     → New secret: 이름 = RAILWAY_TOKEN, 값 = (발급된 토큰)"
echo ""
echo -e "  설정 후 main 브랜치에 push하면 자동 배포됩니다. 🚀"
echo ""
