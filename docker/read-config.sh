#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Deployment configuration written by the setup wizard, read into this
# process's environment.
#
# SOURCED, not executed: it exports variables, which a child process cannot do
# for its parent.
#
# The wizard cannot change a container's environment -- an environment is fixed
# when a process starts -- so it writes a file and the operator restarts. This
# is where that file is read.
#
# ---------------------------------------------------------------------------
# WHY IT IS ITS OWN FILE
# ---------------------------------------------------------------------------
#
# Two containers need it and only one had it. `entrypoint.sh` read the file;
# `backup-loop.sh` is its own entrypoint and never ran `entrypoint.sh`, so the
# backup container could not see anything the wizard wrote. That mattered the
# moment the wizard started generating the backup key itself: the app would
# write a recipient the process doing the encrypting could not read.
#
# Copying the loop would have been quicker and is how three copies of a
# validation predicate ended up with three different refusal sentences
# elsewhere in this repository. One file, sourced twice.
#
# ---------------------------------------------------------------------------
# THE FILE MAY TIGHTEN, NEVER LOOSEN
# ---------------------------------------------------------------------------
#
# AUTH_MODE=local means every visitor is treated as the owner, so a file the
# application can write must never be able to set it: anyone achieving a single
# file write inside the app would otherwise promote themselves from an ordinary
# user to owner by downgrading the mode. Local mode has to come from the
# container environment, where it is the operator's decision and nothing the
# app can reach.
#
# Values already present in the environment win, so a compose file or a
# `docker run -e` remains the authority over a file on a volume.
# ---------------------------------------------------------------------------

read_deploy_config() {
  config_path="${DEPLOY_CONFIG_PATH:-/data/config/auth.env}"

  [ -f "$config_path" ] || return 0
  echo "reading deployment configuration from $config_path"

  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      '' | \#*) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case $key in
      '' | *[!A-Za-z0-9_]*)
        echo "  ignoring a line whose key is not a variable name" >&2
        continue
        ;;
    esac

    # Strip one layer of surrounding quotes, which the writer adds so a secret
    # containing a space or a quote survives the round trip.
    case $value in
      \"*\")
        value=${value#\"}
        value=${value%\"}
        ;;
      \'*\')
        value=${value#\'}
        value=${value%\'}
        ;;
    esac

    if [ "$key" = 'AUTH_MODE' ] && [ "$value" = 'local' ]; then
      echo "  REFUSING AUTH_MODE=local from the config file: it must be set in the" >&2
      echo "  container environment, because local mode treats every visitor as the owner" >&2
      continue
    fi

    # No eval. An earlier version built `export K='v'` as a string and evaluated
    # it, which broke the moment a client secret contained a single quote --
    # "unexpected EOF while looking for matching `'`", and the variable silently
    # ended up empty. A quoted assignment word needs no escaping and cannot be
    # made to run anything.
    #
    # printenv rather than an indirect expansion, for the same reason: the key
    # is data, and the environment already wins over the file, so a compose
    # file or a `docker run -e` stays the authority.
    if [ -z "$(printenv "$key" 2>/dev/null || true)" ]; then
      export "$key=$value"
    fi
  done < "$config_path"
}
