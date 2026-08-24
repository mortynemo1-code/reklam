#!/usr/bin/env bash
# Установка сайта рекламаций на чистый VPS с Ubuntu 22.04/24.04 (например, reg.ru).
# Запуск от root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/mortynemo1-code/reklam/claude/complaint-voiceover-site-t21dyp/deploy/install.sh)
# Повторный запуск безопасен: обновит код и перезапустит контейнеры.
set -euo pipefail

REPO="https://github.com/mortynemo1-code/reklam.git"
BRANCH="claude/complaint-voiceover-site-t21dyp"
DIR="/opt/reklam"

if [ "$(id -u)" != 0 ]; then
  echo "Запустите от root: sudo -i, затем повторите команду." >&2
  exit 1
fi

echo "== Базовые пакеты =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates

echo "== Docker =="
if ! command -v docker > /dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker 2> /dev/null \
  || echo "предупреждение: не удалось включить docker через systemd — продолжаю"

# На маленьких VPS сервису озвучки (PyTorch) может не хватить памяти — добавляем swap.
total_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$total_mb" -lt 3000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  echo "== ОЗУ ${total_mb} МБ — добавляю swap 2 ГБ =="
  fallocate -l 2G /swapfile 2> /dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile > /dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Код =="
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout "$BRANCH"
  git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  echo "== Создаю .env со случайным паролем БД =="
  pass=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
  cat > .env << ENV
POSTGRES_PASSWORD=$pass
# Голос озвучки. Движок по умолчанию — нейроголоса Microsoft (edge):
#   dmitry (мужской, по умолчанию), svetlana (женский)
#TTS_VOICE=dmitry
# Платный вариант повышенной надёжности — Яндекс SpeechKit:
# создайте API-ключ в консоли Яндекс Облака и укажите его здесь,
# голоса: alena, filipp, jane, ermil, marina, alexander и др.
#YANDEX_API_KEY=
#TTS_VOICE=alena
# HTTPS на своём домене: направьте A-запись домена на IP этого сервера,
# затем раскомментируйте две строки ниже и выполните: docker compose up -d
#DOMAIN=example.ru
#COMPOSE_PROFILES=https
ENV
fi

echo "== Сборка и запуск (первый раз может занять несколько минут) =="
docker compose up -d --build

ip=$(hostname -I | awk '{print $1}')
echo
echo "================================================================"
echo "Готово. Сайт доступен по адресу: http://$ip:3012"
echo
echo "Чтобы включить HTTPS на своём домене:"
echo "  1. В панели DNS направьте A-запись домена на $ip"
echo "  2. В файле $DIR/.env раскомментируйте DOMAIN и COMPOSE_PROFILES,"
echo "     подставив свой домен"
echo "  3. Выполните: cd $DIR && docker compose up -d"
echo "  Сертификат Let's Encrypt выпустится автоматически."
echo "================================================================"
