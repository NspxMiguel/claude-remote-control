#!/bin/bash
#
# Lets this app keep the Mac awake with the lid closed, without asking for a
# password every time.
#
# `caffeinate` cannot do that: closing the lid is a separate event from idling,
# and only `pmset disablesleep` suppresses it. That needs root — which is why
# apps like Power Protect for Amphetamine install a privileged helper. Power
# Protect ships this exact pair (a sudoers rule plus a script that shells out to
# pmset); this is the same idea with a narrower grant.
#
# `-a` rather than `-c`: SleepDisabled is a single global flag — it never
# appears under "AC Power" or "Battery Power" in `pmset -g custom` — so asking
# for it per power source would only look like a promise the setting cannot
# keep. The daemon does the AC-only part itself, clearing the flag whenever the
# Mac is running on battery.
#
# The rule grants exactly two commands and nothing else:
#
#     pmset -a disablesleep 1     turn closed-lid mode on
#     pmset -a disablesleep 0     turn it off
#
# The arguments are fixed, so it cannot be used to run pmset with any other
# setting, let alone another program. The worst it can do is stop your Mac
# sleeping — which is the point.
#
# Run once:   ./scripts/allow-lid-control.sh
# Undo with:  sudo rm /etc/sudoers.d/claude-remote-control
#
set -euo pipefail

RULE_FILE=/etc/sudoers.d/claude-remote-control
PMSET=/usr/bin/pmset
USER_NAME="$(id -un)"

if [ ! -x "$PMSET" ]; then
  echo "pmset not found at $PMSET — is this macOS?" >&2
  exit 1
fi

RULE="${USER_NAME} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1, ${PMSET} -a disablesleep 0"

echo "This grants ${USER_NAME} permission to run exactly these, without a password:"
echo
echo "    ${PMSET} -a disablesleep 1"
echo "    ${PMSET} -a disablesleep 0"
echo
echo "Nothing else. You will be asked for your password once, now."
echo

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
printf '%s\n' "$RULE" > "$TMP"

# Never install a sudoers file without checking it: a malformed one can lock you
# out of sudo entirely.
if ! visudo -cf "$TMP" >/dev/null; then
  echo "The generated rule failed validation — nothing was installed." >&2
  exit 1
fi

sudo install -m 0440 -o root -g wheel "$TMP" "$RULE_FILE"

if sudo -n "$PMSET" -a disablesleep 0 2>/dev/null; then
  echo "Done. Closed-lid mode can now be toggled from the app."
else
  echo "Installed, but the permission did not take effect. Check $RULE_FILE." >&2
  exit 1
fi
