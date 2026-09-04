#!/bin/sh
set -eu

caddyfile=${1:-/etc/caddy/Caddyfile}
snippet=${2:-/opt/shararam/ruffle-static.caddy}
import_line="import $snippet"
caddy_dir=$(dirname "$caddyfile")

test -r "$caddyfile"
test -r "$snippet"

if ! awk -v import_line="$import_line" '
    {
        line = $0
        sub(/^[[:space:]]*/, "", line)
        sub(/[[:space:]]*$/, "", line)
        if (line == import_line) found = 1
    }
    END { exit found ? 0 : 1 }
' "$caddyfile"; then
    candidate=$(mktemp "$caddy_dir/Caddyfile.shararam.XXXXXX")
    backup=$(mktemp "$caddy_dir/Caddyfile.pre-ruffle-static.XXXXXX")
    trap 'rm -f "$candidate"' EXIT HUP INT TERM

    cp -p "$caddyfile" "$backup"
    awk -v import_line="$import_line" '
        BEGIN { matches = 0 }
        /^[[:space:]]*(https?:\/\/)?shararam\.sadfun\.dev([,:[:space:]]|$).*\{[[:space:]]*(#.*)?$/ {
            print
            print "\t" import_line
            matches++
            next
        }
        { print }
        END {
            if (matches != 1) {
                print "expected exactly one shararam.sadfun.dev site block, found " matches > "/dev/stderr"
                exit 42
            }
        }
    ' "$caddyfile" > "$candidate"

    caddy validate --config "$candidate" --adapter caddyfile
    cp "$candidate" "$caddyfile"

    if ! systemctl reload caddy; then
        cp "$backup" "$caddyfile"
        systemctl reload caddy || true
        echo "Caddy reload failed; restored $backup" >&2
        exit 1
    fi

    echo "Installed Ruffle static route; previous Caddyfile is $backup"
else
    caddy validate --config "$caddyfile" --adapter caddyfile
    systemctl reload caddy
fi
