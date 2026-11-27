#!/bin/sh
# Run inside a disposable Temurin 21 Alpine container with this module mounted at /platform.
set -eu
apk add --no-cache libsecret gnome-keyring dbus >/dev/null
adduser -D tester
mkdir /tmp/runtime
chown tester /tmp/runtime
chmod 700 /tmp/runtime
cat >/tmp/check.sh <<'SCRIPT'
set -eu
printf disposable-test | gnome-keyring-daemon --unlock --components=secrets
java --source 21 --enable-preview --class-path /platform/target/classes /platform/verification/LinuxKeyringCheck.java "$(command -v secret-tool)"
SCRIPT
su tester -c 'export XDG_RUNTIME_DIR=/tmp/runtime; dbus-run-session -- sh /tmp/check.sh'
