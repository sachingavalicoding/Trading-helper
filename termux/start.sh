#!/data/data/com.termux/files/usr/bin/bash
# Start the server. Run this each morning; it also pulls the latest code.
DIR="$HOME/Trading-helper"
termux-wake-lock 2>/dev/null
git -C "$DIR" pull --ff-only origin master || echo "(skipped update)"
cd "$DIR/server" && npm install --silent
echo "Open http://localhost:5000 in your phone browser."
echo "Upstox token: open http://localhost:5000/upstox/login"
exec npm run dev
