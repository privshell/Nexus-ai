#!/system/bin/sh
# NEXUS // AI - key vault and curl proxy
# Usage: nexus.sh <command> [args]

if [ -z "$NEXUS_SH" ]; then
  for b in /data/adb/ksu/bin/busybox /data/adb/ap/bin/busybox /data/adb/magisk/busybox; do
    [ -x "$b" ] && NEXUS_SH=1 ASH_STANDALONE=1 exec "$b" sh "$0" "$@"
  done
fi
export PATH="/system/bin:/system/xbin:/vendor/bin:/data/adb/ksu/bin:$PATH"

DATA="${NEXUS_DATA:-/data/adb/nexus}"
KEYS="$DATA/keys.conf"
HIST="$DATA/history"
mkdir -p "$DATA" "$HIST" 2>/dev/null
touch "$KEYS" 2>/dev/null
chmod 600 "$KEYS" 2>/dev/null

jstr() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r'; }
valid_id() { echo "$1" | grep -Eq '^[a-zA-Z0-9_-]{1,32}$'; }

# ---------- key vault ----------
# Format: id|name|base_url|api_key|type
# type: openai, anthropic, gemini, custom

keys_json() {
  printf '['
  s=""
  while IFS='|' read -r id name base key type rest; do
    [ -z "$id" ] && continue
    printf '%s{"id":"%s","name":"%s","base":"%s","type":"%s","hasKey":%s}' \
      "$s" "$(jstr "$id")" "$(jstr "$name")" "$(jstr "$base")" "$(jstr "$type")" \
      "$([ -n "$key" ] && echo true || echo false)"
    s=","
  done < "$KEYS"
  printf ']\n'
}

set_key() {
  id=$1; name=$2; base=$3; key=$4; type=$5
  valid_id "$id" || { echo '{"ok":false,"error":"bad id"}'; return 1; }
  # Remove old entry if exists
  grep -v "^$id|" "$KEYS" > "$KEYS.t" 2>/dev/null
  echo "$id|$name|$base|$key|$type" >> "$KEYS.t"
  mv "$KEYS.t" "$KEYS"
  chmod 600 "$KEYS"
  echo '{"ok":true}'
}

del_key() {
  id=$1; valid_id "$id" || { echo '{"ok":false}'; return 1; }
  grep -v "^$id|" "$KEYS" > "$KEYS.t" 2>/dev/null
  mv "$KEYS.t" "$KEYS"
  chmod 600 "$KEYS"
  echo '{"ok":true}'
}

get_key_field() {
  id=$1; field=$2
  line=$(grep "^$id|" "$KEYS" | head -n1)
  [ -z "$line" ] && return 1
  case "$field" in
    base) echo "$line" | cut -d'|' -f3 ;;
    key) echo "$line" | cut -d'|' -f4 ;;
    type) echo "$line" | cut -d'|' -f5 ;;
    name) echo "$line" | cut -d'|' -f2 ;;
  esac
}

# ---------- proxy ----------
# The WebUI calls this to avoid CORS issues.
# nexus.sh proxy <provider_id> <method> <path> [body]
proxy() {
  pid=$1; method=$2; path=$3; body=$4
  valid_id "$pid" || { echo '{"error":"bad provider id"}'; return 1; }
  base=$(get_key_field "$pid" base)
  key=$(get_key_field "$pid" key)
  type=$(get_key_field "$pid" type)
  [ -z "$base" ] && { echo '{"error":"provider not found"}'; return 1; }

  url="${base%/}/$path"

  # Build auth header based on type
  case "$type" in
    anthropic) auth_header="x-api-key: $key" ; extra_header="anthropic-version: 2023-06-01" ;;
    gemini) url="${url}${url#*\?}" ; url="${base%/}/$path?key=$key" ; auth_header="" ; extra_header="" ;;
    *) auth_header="Authorization: Bearer $key" ; extra_header="" ;;
  esac

  if command -v curl >/dev/null 2>&1; then
    if [ "$method" = "GET" ]; then
      curl -sS --max-time 120 -H "Content-Type: application/json" \
        ${auth_header:+-H "$auth_header"} ${extra_header:+-H "$extra_header"} \
        "$url" 2>/dev/null
    else
      printf '%s' "$body" | curl -sS --max-time 120 -X POST \
        -H "Content-Type: application/json" \
        ${auth_header:+-H "$auth_header"} ${extra_header:+-H "$extra_header"} \
        -d @- "$url" 2>/dev/null
    fi
  elif busybox wget --help 2>&1 | grep -q 'post-data'; then
    if [ "$method" = "GET" ]; then
      busybox wget -qO- --header="Content-Type: application/json" \
        ${auth_header:+--header="$auth_header"} ${extra_header:+--header="$extra_header"} \
        "$url" 2>/dev/null
    else
      printf '%s' "$body" | busybox wget -qO- --header="Content-Type: application/json" \
        ${auth_header:+--header="$auth_header"} ${extra_header:+--header="$extra_header"} \
        --post-data="$(cat)" "$url" 2>/dev/null
    fi
  else
    echo '{"error":"no curl or busybox wget"}'
    return 1
  fi
}

# ---------- stream proxy ----------
# Writes SSE chunks to a temp file the WebUI can poll
stream() {
  pid=$1; path=$2; body=$3; sid=$4
  valid_id "$pid" || return 1
  base=$(get_key_field "$pid" base)
  key=$(get_key_field "$pid" key)
  type=$(get_key_field "$pid" type)
  [ -z "$base" ] && return 1

  url="${base%/}/$path"
  outf="$DATA/.stream_$sid"
  donef="$DATA/.stream_${sid}_done"
  rm -f "$outf" "$donef"
  touch "$outf"

  case "$type" in
    anthropic) auth_header="x-api-key: $key" ; extra_header="anthropic-version: 2023-06-01" ;;
    gemini) url="${url}?key=$key&alt=sse" ; auth_header="" ; extra_header="" ;;
    *) auth_header="Authorization: Bearer $key" ; extra_header="" ;;
  esac

  (
    printf '%s' "$body" | curl -sS --max-time 300 -N -X POST \
      -H "Content-Type: application/json" \
      ${auth_header:+-H "$auth_header"} ${extra_header:+-H "$extra_header"} \
      -d @- "$url" >> "$outf" 2>/dev/null
    echo "NEXUS_DONE" >> "$outf"
    touch "$donef"
  ) &
  echo '{"ok":true,"sid":"'"$sid"'"}'
}

poll_stream() {
  sid=$1; offset=$2
  outf="$DATA/.stream_$sid"
  donef="$DATA/.stream_${sid}_done"
  [ -f "$outf" ] || { echo '{"data":"","done":true}'; return; }
  data=$(tail -c "+$((offset+1))" "$outf" 2>/dev/null)
  done=false
  [ -f "$donef" ] && done=true
  newoff=$(wc -c < "$outf" | tr -d ' ')
  printf '{"data":"%s","offset":%s,"done":%s}\n' "$(jstr "$data")" "$newoff" "$done"
}

clean_stream() {
  sid=$1
  rm -f "$DATA/.stream_$sid" "$DATA/.stream_${sid}_done" 2>/dev/null
  echo '{"ok":true}'
}

# ---------- history ----------
save_chat() {
  id=$1; data=$2
  valid_id "$id" || { echo '{"ok":false}'; return 1; }
  printf '%s' "$data" > "$HIST/$id.json"
  echo '{"ok":true}'
}

load_chat() {
  id=$1; valid_id "$id" || { echo '[]'; return 1; }
  [ -f "$HIST/$id.json" ] && cat "$HIST/$id.json" || echo '[]'
}

list_chats() {
  printf '['
  s=""
  for f in "$HIST"/*.json; do
    [ -f "$f" ] || continue
    n=$(basename "$f" .json)
    sz=$(wc -c < "$f" | tr -d ' ')
    printf '%s{"id":"%s","size":%s}' "$s" "$(jstr "$n")" "$sz"
    s=","
  done
  printf ']\n'
}

del_chat() {
  id=$1; valid_id "$id" || { echo '{"ok":false}'; return 1; }
  rm -f "$HIST/$id.json" 2>/dev/null
  echo '{"ok":true}'
}

# ---------- tools ----------
tools_json() {
  c=0; command -v curl >/dev/null 2>&1 && c=1
  w=0; busybox wget --help 2>&1 | grep -q 'post-data' 2>/dev/null && w=1
  printf '{"curl":%s,"wget":%s,"sdk":"%s","device":"%s"}\n' \
    "$c" "$w" "$(getprop ro.build.version.sdk)" "$(getprop ro.product.device)"
}

# ---------- github ----------
gh_proxy() {
  token=$1; method=$2; path=$3
  [ -z "$token" ] && { echo '{"error":"no token"}'; return 1; }
  url="https://api.github.com/$path"
  if [ "$method" = "GET" ]; then
    curl -sS --max-time 30 -H "Authorization: token $token" -H "Accept: application/vnd.github.v3+json" "$url" 2>/dev/null
  fi
}

# ---------- entry ----------
cmd_=$1; [ $# -gt 0 ] && shift
case "$cmd_" in
  keys) keys_json ;;
  setkey) set_key "$1" "$2" "$3" "$4" "$5" ;;
  delkey) del_key "$1" ;;
  proxy) proxy "$1" "$2" "$3" "$4" ;;
  stream) stream "$1" "$2" "$3" "$4" ;;
  poll) poll_stream "$1" "$2" ;;
  clean) clean_stream "$1" ;;
  save) save_chat "$1" "$2" ;;
  load) load_chat "$1" ;;
  chats) list_chats ;;
  delchat) del_chat "$1" ;;
  tools) tools_json ;;
  ghproxy) gh_proxy "$1" "$2" "$3" ;;
  *) echo "NEXUS // AI"
     echo "commands: keys setkey delkey proxy stream poll clean"
     echo "          save load chats delchat tools ghproxy" ;;
esac
