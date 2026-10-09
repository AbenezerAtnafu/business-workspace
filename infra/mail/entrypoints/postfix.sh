#!/usr/bin/env bash
# Render config from the environment, then run Postfix in the foreground.
set -euo pipefail
/opt/mail/render.sh postfix /
postfix check
exec postfix start-fg
