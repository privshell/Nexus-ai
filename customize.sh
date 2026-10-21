#!/system/bin/sh
SKIPUNZIP=0
ui_print " "
ui_print "  NEXUS // AI"
ui_print "  Multi-provider AI chat"
ui_print " "
set_perm_recursive "$MODPATH" 0 0 0755 0644
set_perm "$MODPATH/nexus.sh" 0 0 0755
DATA=/data/adb/nexus
mkdir -p "$DATA"
[ -f "$DATA/keys.conf" ] || touch "$DATA/keys.conf"
chmod 600 "$DATA/keys.conf"
ui_print "- API keys are stored in /data/adb/nexus/keys.conf"
ui_print "- Only root can read that file"
ui_print " "
