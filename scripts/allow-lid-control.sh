#!/bin/bash
#
# Lets this app keep the Mac awake with the lid closed, without asking for a
# password every time.
#
# `caffeinate` cannot do that: closing the lid is a separate event from idling,
# and only `pmset -c disablesleep` suppresses it. That needs root — which is why
# apps like Power Protect for Amphetamine install a privileged helper.
#
# Rather than a helper daemon, this installs one sudoers rule that grants
# exactly two commands and nothing else:
#
#     pmset -c disablesleep 1     turn closed-lid mode on
#     pmset -c disablesleep 0     turn it off
#
# The arguments are fixed, so the rule cannot be used to run pmset with any
# other setting, let alone another program. The worst it can do is stop your Mac
# sleeping while on mains power — which is the point.
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

RULE="${USER_NAME} ALL=(root) NOPASSWD: ${PMSET} -c disablesleep 1, ${PMSET} -c disablesleep 0"

echo "This grants ${USER_NAME} permission to run exactly these, without a password:"
echo
echo "    ${PMSET} -c disablesleep 1"
echo "    ${PMSET} -c disablesleep 0"
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

if sudo -n "$PMSET" -c disablesleep 0 2>/dev/null; then
  echo "Done. Closed-lid mode can now be toggled from the app."
else
  echo "Installed, but the permission did not take effect. Check $RULE_FILE." >&2
  exit 1
fi
