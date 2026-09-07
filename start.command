#!/bin/bash
# Double-click this file to run threads-bot-filter. No terminal knowledge
# needed — it checks for Node.js, installs dependencies on first run, starts
# the local tool, and opens it in your browser automatically.
cd "$(dirname "$0")"

echo "threads-bot-filter"
echo "==================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed yet — this tool needs it to run."
  echo "Opening the Node.js download page for you..."
  echo "After installing it, come back and double-click this file again."
  open "https://nodejs.org/" 2>/dev/null
  echo ""
  read -p "Press Enter to close this window..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing what this tool needs (this can take a minute)..."
  npm install
  if [ $? -ne 0 ]; then
    echo ""
    echo "Something went wrong installing dependencies — see the error above."
    read -p "Press Enter to close this window..."
    exit 1
  fi
  echo ""
fi

echo "Starting threads-bot-filter..."
node bin/cli.js &
SERVER_PID=$!

sleep 2
open "http://127.0.0.1:4173" 2>/dev/null

echo ""
echo "It's running! Your browser should have opened to it automatically —"
echo "if not, go to: http://127.0.0.1:4173"
echo ""
echo "Leave THIS window open while you use the tool (you can minimize it)."
echo "Close this window, or press Ctrl+C, when you're done."
echo ""

wait $SERVER_PID
