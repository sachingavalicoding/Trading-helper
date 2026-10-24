#!/data/data/com.termux/files/usr/bin/bash
# One-time setup of the paper trader on an Android phone (Termux).
set -e
REPO="https://github.com/sachingavalicoding/Trading-helper.git"
DIR="$HOME/Trading-helper"

pkg update -y
pkg install -y nodejs git nano

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull origin master
else
  git clone "$REPO" "$DIR"
fi

cd "$DIR/server"
npm install

if [ ! -f .env ]; then
  cp .env.example .env
  SECRET=$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" .env
  echo "Created server/.env with a fresh JWT_SECRET."
fi

echo
echo "Setup done. Next: nano $DIR/server/.env  (fill MONGO_URI and the UPSTOX_* values),"
echo "then run: bash $DIR/termux/start.sh"
