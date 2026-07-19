#!/usr/bin/env bash

# agent-dice installer
# Installs the dice trigger system for Claude Code (CLI: agent-dice, with cc-dice alias)

set -e

REPO_URL="https://github.com/pro-vi/agent-dice.git"
CLONE_DIR="${HOME}/.local/share/agent-dice"
DICE_BASE="${HOME}/.claude/dice"
HOOKS_DIR="${HOME}/.claude/hooks"
SETTINGS_FILE="${HOME}/.claude/settings.json"

# Codex host paths. One root, resolved the same way the runtime does
# (codexRoot() in src/adapters/codex/host.ts): CODEX_HOME if set, else ~/.codex.
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
CODEX_DICE_BASE="$CODEX_ROOT/dice"           # data + hook-script symlinks live here
CODEX_HOOKS_JSON="$CODEX_ROOT/hooks.json"    # user-layer hook registration

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}  agent-dice installer${NC}"
    echo -e "${BLUE}================================${NC}"
    echo ""
}

print_success() { echo -e "${GREEN}ok${NC} $1"; }
print_error()   { echo -e "${RED}err${NC} $1"; }
print_warning() { echo -e "${YELLOW}warn${NC} $1"; }
print_info()    { echo -e "${BLUE}info${NC} $1"; }

check_dependencies() {
    print_info "Checking dependencies..."
    local missing=()

    if ! command -v bun &> /dev/null; then
        missing+=("bun (runtime)")
    fi

    if ! command -v git &> /dev/null; then
        missing+=("git (clone source for curl installs)")
    fi

    if ! command -v jq &> /dev/null; then
        missing+=("jq (JSON processing for settings.json)")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        print_error "Missing dependencies:"
        for dep in "${missing[@]}"; do
            echo "  - $dep"
        done
        echo ""
        echo "Install:"
        echo "  git: https://git-scm.com/downloads"
        echo "  bun: curl -fsSL https://bun.sh/install | bash"
        echo "  jq:  brew install jq"
        return 1
    fi

    print_success "All dependencies found"
}

# ---- Hook registration helpers (same pattern as cc-reflection) ----

unregister_hook() {
    local event_name="$1"
    local grep_pattern="$2"

    if [ ! -f "$SETTINGS_FILE" ]; then return 0; fi
    if ! grep -q "$grep_pattern" "$SETTINGS_FILE" 2>/dev/null; then return 0; fi

    cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak"
    local tmp_file=$(mktemp)
    if ! jq --arg event "$event_name" --arg pattern "$grep_pattern" '
        if .hooks[$event] then
            .hooks[$event] |= (
                map(
                    if .hooks then
                        .hooks |= map(select(.command | tostring | contains($pattern) | not))
                    else . end
                ) | map(select(.hooks | length > 0))
            )
        else . end
    ' "$SETTINGS_FILE" > "$tmp_file"; then
        rm -f "$tmp_file"
        print_error "Failed to parse settings.json (restored from backup)"
        cp "$SETTINGS_FILE.bak" "$SETTINGS_FILE"
        return 2
    fi
    if ! jq empty "$tmp_file" 2>/dev/null || [ ! -s "$tmp_file" ]; then
        rm -f "$tmp_file"
        print_error "jq produced invalid JSON (restored from backup)"
        cp "$SETTINGS_FILE.bak" "$SETTINGS_FILE"
        return 2
    fi
    mv "$tmp_file" "$SETTINGS_FILE"
}

register_hook() {
    local event_name="$1"
    local grep_pattern="$2"
    local hook_path="$3"

    if [ -f "$SETTINGS_FILE" ]; then
        # Remove old entry before adding new one
        if grep -q "$grep_pattern" "$SETTINGS_FILE" 2>/dev/null; then
            unregister_hook "$event_name" "$grep_pattern" || true
        fi

        cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak"
        local quoted_path
        quoted_path=$(jq -nr --arg p "$hook_path" '$p | @sh')
        local hook_cmd="bun ${quoted_path}"
        local hook_obj
        hook_obj=$(jq -n --arg cmd "$hook_cmd" '{hooks: [{type: "command", command: $cmd}]}')
        local tmp_file=$(mktemp)
        if ! jq --arg event "$event_name" --argjson hook "$hook_obj" '
            .hooks[$event] = (
                if .hooks[$event] then
                    .hooks[$event] + [$hook]
                else
                    [$hook]
                end
            )
        ' "$SETTINGS_FILE" > "$tmp_file"; then
            rm -f "$tmp_file"
            print_error "Failed to parse settings.json (restored from backup)"
            cp "$SETTINGS_FILE.bak" "$SETTINGS_FILE"
            return 1
        fi
        if ! jq empty "$tmp_file" 2>/dev/null || [ ! -s "$tmp_file" ]; then
            rm -f "$tmp_file"
            print_error "jq produced invalid JSON (restored from backup)"
            cp "$SETTINGS_FILE.bak" "$SETTINGS_FILE"
            return 1
        fi
        mv "$tmp_file" "$SETTINGS_FILE"
        print_success "Registered $event_name hook in settings.json"
    else
        mkdir -p "$(dirname "$SETTINGS_FILE")"
        cat > "$SETTINGS_FILE" <<EOFJSON
{
  "hooks": {
    "${event_name}": [{"hooks": [{"type": "command", "command": "bun '${hook_path}'"}]}]
  }
}
EOFJSON
        print_success "Created settings.json with $event_name hook"
    fi
}

# ---- Source resolution ----

# Set SCRIPT_DIR from the local checkout WITHOUT ever cloning. Used by uninstall,
# which must know this install's exact managed targets (for strict symlink
# ownership) but must never fetch anything. Returns 1 if no local source is found.
resolve_local_source_dir() {
    local d
    if [ -n "${BASH_SOURCE[0]:-}" ]; then
        d="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
        if [ -n "$d" ] && [ -f "$d/src/index.ts" ]; then SCRIPT_DIR="$d"; return 0; fi
    fi
    return 1
}

resolve_source_dir() {
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/src/index.ts" 2>/dev/null ]; then
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    else
        # Running via curl or from a location without source files — clone repo
        if [ -d "$CLONE_DIR/.git" ]; then
            git -C "$CLONE_DIR" pull --quiet 2>/dev/null || true
        else
            print_info "Cloning agent-dice..."
            git clone --quiet --depth 1 "$REPO_URL" "$CLONE_DIR"
        fi
        SCRIPT_DIR="$CLONE_DIR"
    fi
}

# ---- Installation ----

install_dice() {
    print_info "Installing agent-dice..."

    # Create directory structure
    mkdir -p "$DICE_BASE/state"
    mkdir -p "$HOOKS_DIR"
    print_success "Created $DICE_BASE"

    # Symlink the source module so hooks can import it
    ln -sf "$SCRIPT_DIR/src/index.ts" "$DICE_BASE/cc-dice.ts"
    print_success "Symlinked cc-dice module to $DICE_BASE/cc-dice.ts"

    # Symlink hooks
    ln -sf "$SCRIPT_DIR/hooks/stop.ts" "$HOOKS_DIR/dice-stop.ts"
    print_success "Symlinked stop hook to $HOOKS_DIR/dice-stop.ts"

    ln -sf "$SCRIPT_DIR/hooks/session-start.ts" "$HOOKS_DIR/dice-session-start.ts"
    print_success "Symlinked session-start hook to $HOOKS_DIR/dice-session-start.ts"

    # Symlink the SHARED CLI ownership-safely (it is a shared-resource contract with
    # the Codex host): never clobber an unrelated file/symlink. Best-effort — the
    # Claude hooks work without it, so a conflict warns rather than aborts, and the
    # message reflects whether the link actually happened.
    local bin_dir="${HOME}/.local/bin" cli_ok=1
    mkdir -p "$bin_dir"
    safe_link "$SCRIPT_DIR/bin/agent-dice.ts" "$bin_dir/agent-dice" || cli_ok=0
    safe_link "$SCRIPT_DIR/bin/agent-dice.ts" "$bin_dir/cc-dice" || cli_ok=0
    if [ "$cli_ok" -eq 1 ]; then
        print_success "Symlinked CLI to $bin_dir/agent-dice (and cc-dice alias)"
    else
        print_warning "CLI not fully linked — a conflicting file exists at $bin_dir (resolve it, then re-run)"
    fi
}

register_hooks() {
    echo ""
    print_info "Registering hooks in settings.json..."
    register_hook "Stop" "dice-stop" "$HOOKS_DIR/dice-stop.ts"
    register_hook "SessionStart" "dice-session-start" "$HOOKS_DIR/dice-session-start.ts"
}

show_check() {
    echo ""
    echo "agent-dice Installation Check"
    echo ""

    # Quick check: if base dir doesn't exist, nothing is installed
    if [ ! -d "$DICE_BASE" ] && [ ! -L "${HOME}/.local/bin/agent-dice" ] && [ ! -f "$HOOKS_DIR/dice-stop.ts" ]; then
        echo -e "  ${BLUE}Not installed.${NC} Run ${BLUE}./install.sh${NC} to install."
        echo ""
        return 0
    fi

    local errors=0
    local warnings=0

    # Check base dir
    if [ -d "$DICE_BASE" ]; then
        echo -e "  ${GREEN}ok${NC} Base directory: $DICE_BASE"
    else
        echo -e "  ${RED}err${NC} Base directory missing"
        errors=$((errors + 1))
    fi

    # Check module symlink
    if [ -L "$DICE_BASE/cc-dice.ts" ]; then
        if [ -e "$DICE_BASE/cc-dice.ts" ]; then
            echo -e "  ${GREEN}ok${NC} Module symlink"
        else
            echo -e "  ${RED}err${NC} Module symlink broken (target missing)"
            errors=$((errors + 1))
        fi
    else
        echo -e "  ${YELLOW}warn${NC} Module not symlinked"
        warnings=$((warnings + 1))
    fi

    # Check stop hook
    if [ -L "$HOOKS_DIR/dice-stop.ts" ] && [ ! -e "$HOOKS_DIR/dice-stop.ts" ]; then
        echo -e "  ${RED}err${NC} Stop hook symlink broken (target missing)"
        errors=$((errors + 1))
    elif [ -f "$HOOKS_DIR/dice-stop.ts" ]; then
        echo -e "  ${GREEN}ok${NC} Stop hook file"
        if [ -f "$SETTINGS_FILE" ] && grep -q "dice-stop" "$SETTINGS_FILE" 2>/dev/null; then
            echo -e "  ${GREEN}ok${NC} Stop hook registered"
        else
            echo -e "  ${YELLOW}warn${NC} Stop hook not registered in settings.json"
            warnings=$((warnings + 1))
        fi
    else
        echo -e "  ${YELLOW}warn${NC} Stop hook not installed"
        warnings=$((warnings + 1))
    fi

    # Check session-start hook
    if [ -L "$HOOKS_DIR/dice-session-start.ts" ] && [ ! -e "$HOOKS_DIR/dice-session-start.ts" ]; then
        echo -e "  ${RED}err${NC} SessionStart hook symlink broken (target missing)"
        errors=$((errors + 1))
    elif [ -f "$HOOKS_DIR/dice-session-start.ts" ]; then
        echo -e "  ${GREEN}ok${NC} SessionStart hook file"
        if [ -f "$SETTINGS_FILE" ] && grep -q "dice-session-start" "$SETTINGS_FILE" 2>/dev/null; then
            echo -e "  ${GREEN}ok${NC} SessionStart hook registered"
        else
            echo -e "  ${YELLOW}warn${NC} SessionStart hook not registered"
            warnings=$((warnings + 1))
        fi
    else
        echo -e "  ${BLUE}info${NC} SessionStart hook not installed"
    fi

    # Check CLI
    if [ -L "${HOME}/.local/bin/agent-dice" ]; then
        if [ -e "${HOME}/.local/bin/agent-dice" ]; then
            echo -e "  ${GREEN}ok${NC} CLI symlink"
        else
            echo -e "  ${RED}err${NC} CLI symlink broken (target missing)"
            errors=$((errors + 1))
        fi
    else
        echo -e "  ${YELLOW}warn${NC} CLI not symlinked"
        warnings=$((warnings + 1))
    fi

    # Check slots
    if [ -f "$DICE_BASE/slots.json" ]; then
        local count
        count=$(jq 'length' "$DICE_BASE/slots.json" 2>/dev/null || echo "0")
        echo -e "  ${GREEN}ok${NC} Slots: $count registered"
    else
        echo -e "  ${BLUE}info${NC} No slots registered yet"
    fi

    echo ""
    if [ $errors -eq 0 ] && [ $warnings -eq 0 ]; then
        echo -e "${GREEN}Status: OK${NC}"
    elif [ $errors -eq 0 ]; then
        echo -e "${YELLOW}Status: OK with $warnings warning(s)${NC}"
    else
        echo -e "${RED}Status: $errors error(s), $warnings warning(s)${NC}"
    fi
    echo ""
}

uninstall() {
    print_info "Uninstalling agent-dice..."

    # Unregister hooks
    unregister_hook "Stop" "dice-stop" || true
    unregister_hook "SessionStart" "dice-session-start" || true

    # Remove hook files
    rm -f "$HOOKS_DIR/dice-stop.ts"
    rm -f "$HOOKS_DIR/dice-session-start.ts"
    print_success "Removed hooks"

    # Remove module symlink (Claude's own marker)
    rm -f "$DICE_BASE/cc-dice.ts"

    # Locate this checkout (no clone) for strict CLI ownership.
    resolve_local_source_dir || print_warning "Could not locate the agent-dice source; CLI left in place"

    # Shared CLI: remove only when no other host remains (Codex absent), and only
    # our own symlink (exact target) — never an unrelated file. Symmetric with uninstall_codex.
    if [ -L "$CODEX_DICE_BASE/codex-stop.ts" ] || [ -e "$CODEX_DICE_BASE/codex-stop.ts" ]; then
        print_info "Kept shared CLI (Codex host still installed)"
    else
        safe_unlink "${HOME}/.local/bin/agent-dice" "$SCRIPT_DIR/bin/agent-dice.ts"
        safe_unlink "${HOME}/.local/bin/cc-dice" "$SCRIPT_DIR/bin/agent-dice.ts"
        print_success "Removed CLI symlinks"
    fi

    echo ""
    read -p "Remove dice data ($DICE_BASE)? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$DICE_BASE"
        print_success "Removed dice data"
    else
        print_info "Kept dice data at $DICE_BASE"
    fi

    print_success "Uninstall complete"
}

# ============================================================================
# Codex host: hook registration lives in $CODEX_ROOT/hooks.json (user layer).
# The block shape matches Claude's settings.json hooks block. A single reconciler
# drives hooks.json toward a canonical desired state (one owned entry present, or
# absent), transactionally — so registration is idempotent (byte-for-byte no-op
# when already correct, never churning Codex's index-sensitive hook trust) and
# unrelated entries + their order are always conserved.
# ============================================================================

# Canonical command string for a hook script path: `bun '<path>'`.
codex_hook_cmd() { echo "bun $(jq -nr --arg p "$1" '$p | @sh')"; }

# A symlink is OWNED by this install iff its target is EXACTLY the file we manage
# ($2, the exact absolute target). Same-file (inode) check when both exist, exact
# stored-string when the link dangles. STRICT on purpose: an unrelated
# ".../bin/agent-dice.ts" from another tree is NOT ours (path shape is not
# ownership), and a moved-checkout link is a conflict to resolve manually — never
# a silent clobber. Cross-checkout migration, if ever wanted, gets an explicit
# marker/force flag, not inferred ownership.
link_owned_by() {
    local link="$1" target="$2"
    [ -L "$link" ] || return 1
    if [ -e "$link" ] && [ -e "$target" ]; then
        [ "$link" -ef "$target" ]      # resolves both; true only for the same file
    else
        [ "$(readlink "$link")" = "$target" ]   # dangling link: exact stored target
    fi
}

# Create $2 -> $1 only if safe to OWN: absent, or an existing symlink that already
# points exactly at $1. Refuse to clobber a regular file or any other symlink —
# never destroy something we didn't create. Returns 1 on conflict.
safe_link() {
    local target="$1" link="$2"
    if [ -L "$link" ]; then
        if ! link_owned_by "$link" "$target"; then
            print_error "Refusing to overwrite symlink not managed by this install: $link -> $(readlink "$link")"; return 1
        fi
    elif [ -e "$link" ]; then
        print_error "Refusing to overwrite existing non-symlink file: $link"; return 1
    fi
    ln -sf "$target" "$link"
}

# Remove $1 only if it is a symlink pointing exactly at the managed target $2.
# Leave anything else in place. Always returns 0.
safe_unlink() {
    local link="$1" target="$2"
    if [ -L "$link" ]; then
        if link_owned_by "$link" "$target"; then rm -f "$link"; return 0; fi
        print_warning "Left symlink not managed by this install: $link -> $(readlink "$link")"
    elif [ -e "$link" ]; then
        print_warning "Left non-symlink file in place: $link"
    fi
    return 0
}

# reconcile_codex_hook <event> <hook_path> <present|absent>
#
# Drive hooks.json to the desired state for ONE owned hook ENTRY. Ownership is
# EXACT — a hook object whose command equals our canonical command (never a
# basename substring). Reconciliation is per-hook-object, NOT per-group: an owned
# entry is repaired/removed in place while UNRELATED SIBLINGS in the same hooks[]
# and the group's own metadata (matcher, …) are conserved; a group is dropped only
# when it becomes empty. present → exactly one canonical {type,command,timeout}
# owned entry at the first owned position (or appended), duplicates collapsed;
# absent → all owned entries removed. Order is conserved. A correct file is left
# byte-for-byte unchanged (idempotent, no trust churn). On unreadable/uncreatable/
# unwritable JSON, hooks.json is left untouched and it returns 1.
reconcile_codex_hook() {
    local event="$1" hook_path="$2" state="$3"

    # Nothing to remove from a file that doesn't exist.
    if [ "$state" = "absent" ] && [ ! -f "$CODEX_HOOKS_JSON" ]; then return 0; fi

    mkdir -p "$CODEX_ROOT" 2>/dev/null || { print_error "Cannot create $CODEX_ROOT (read-only?)"; return 1; }
    if [ ! -f "$CODEX_HOOKS_JSON" ]; then
        echo '{"hooks":{}}' > "$CODEX_HOOKS_JSON" 2>/dev/null || { print_error "Cannot create $CODEX_HOOKS_JSON (read-only?)"; return 1; }
    fi
    if ! jq empty "$CODEX_HOOKS_JSON" 2>/dev/null; then
        print_error "hooks.json is not valid JSON — leaving it untouched"; return 1
    fi

    local cmd tmp
    cmd="$(codex_hook_cmd "$hook_path")"
    tmp=$(mktemp)
    if ! jq --arg e "$event" --arg cmd "$cmd" --arg state "$state" --argjson to 10 '
        def canon: {type: "command", command: $cmd, timeout: $to};
        .hooks[$e] = (
            (.hooks[$e] // []) as $groups
            # Walk groups; within each, reconcile individual hook objects. The
            # first owned object across the whole event becomes canonical in place;
            # later owned objects are dropped; unrelated siblings are preserved.
            | (reduce range(0; ($groups | length)) as $gi ({emitted: false, out: []};
                ($groups[$gi]) as $g
                | (reduce (($g.hooks // [])[]) as $h ({emitted: .emitted, hooks: []};
                    if ($h.command == $cmd)
                    then (if ($state == "present" and (.emitted | not))
                          then {emitted: true, hooks: (.hooks + [canon])}
                          else {emitted: true, hooks: .hooks} end)
                    else {emitted: .emitted, hooks: (.hooks + [$h])} end)) as $gr
                | { emitted: $gr.emitted,
                    out: (.out + (if (($gr.hooks | length) > 0)
                                  then [ ($g | .hooks = $gr.hooks) ]   # preserve group metadata + siblings
                                  else [] end)) })                     # drop emptied group
              ) as $r
            | if ($state == "present" and ($r.emitted | not))
              then ($r.out + [ {hooks: [canon]} ]) else $r.out end     # append when none owned
        )
        | if ((.hooks[$e] // [] | length) == 0) then del(.hooks[$e]) else . end
    ' "$CODEX_HOOKS_JSON" > "$tmp"; then
        rm -f "$tmp"; print_error "Failed to reconcile hooks.json (left untouched)"; return 1
    fi
    if ! jq empty "$tmp" 2>/dev/null || [ ! -s "$tmp" ]; then
        rm -f "$tmp"; print_error "reconcile produced invalid JSON (left untouched)"; return 1
    fi
    if cmp -s "$tmp" "$CODEX_HOOKS_JSON"; then
        rm -f "$tmp"; return 0                                          # already canonical — no write, no trust churn
    fi
    if ! mv "$tmp" "$CODEX_HOOKS_JSON" 2>/dev/null; then
        rm -f "$tmp"; print_error "Cannot write $CODEX_HOOKS_JSON (read-only?)"; return 1
    fi
    return 0
}

# Structural registration check: EXACTLY ONE owned hook object exists for $1 and
# it equals the full canonical {type, command, timeout} — noncanonical metadata
# (e.g. a drifted timeout) or duplicate cardinality fails the check.
codex_hook_registered() {
    local event="$1" hook_path="$2" cmd
    [ -f "$CODEX_HOOKS_JSON" ] || return 1
    cmd="$(codex_hook_cmd "$hook_path")"
    jq -e --arg e "$event" --arg cmd "$cmd" --argjson to 10 '
        ([.hooks[$e][]?.hooks[]? | select(.command == $cmd)]) as $owned
        | ($owned | length) == 1
          and ($owned[0] == {type: "command", command: $cmd, timeout: $to})
    ' "$CODEX_HOOKS_JSON" >/dev/null 2>&1
}

# Install hook + CLI symlinks, ownership-safe. Returns 1 on a conflicting path so
# the caller aborts BEFORE touching hooks.json.
install_codex() {
    print_info "Installing agent-dice for Codex..."

    mkdir -p "$CODEX_DICE_BASE/state"
    print_success "Created $CODEX_DICE_BASE"

    # Symlink hook scripts under the dice base (NOT $CODEX_ROOT/hooks, which may be
    # a user-owned dir). ESM resolves the scripts' `../src/**` imports against the
    # real repo path, so no module symlink is needed.
    safe_link "$SCRIPT_DIR/hooks/codex-stop.ts" "$CODEX_DICE_BASE/codex-stop.ts" || return 1
    safe_link "$SCRIPT_DIR/hooks/codex-session-start.ts" "$CODEX_DICE_BASE/codex-session-start.ts" || return 1
    print_success "Symlinked Codex hooks to $CODEX_DICE_BASE"

    local bin_dir="${HOME}/.local/bin"
    mkdir -p "$bin_dir"
    safe_link "$SCRIPT_DIR/bin/agent-dice.ts" "$bin_dir/agent-dice" || return 1
    safe_link "$SCRIPT_DIR/bin/agent-dice.ts" "$bin_dir/cc-dice" || return 1
    print_success "Symlinked CLI to $bin_dir/agent-dice (and cc-dice alias)"
}

register_codex_hooks() {
    echo ""
    print_info "Reconciling Codex hooks in $CODEX_HOOKS_JSON..."
    reconcile_codex_hook "Stop" "$CODEX_DICE_BASE/codex-stop.ts" present || return 1
    reconcile_codex_hook "SessionStart" "$CODEX_DICE_BASE/codex-session-start.ts" present || return 1
    print_success "Registered Stop + SessionStart hooks (canonical, idempotent)"
}

uninstall_codex() {
    local purge="${1:-}"
    print_info "Uninstalling agent-dice for Codex..."

    # Locate this checkout (no clone) so ownership is judged against exact managed
    # targets. If it can't be found, symlink removal is skipped (safe): the
    # strict check leaves anything it can't positively confirm as ours.
    if ! resolve_local_source_dir; then
        print_warning "Could not locate the agent-dice source; symlinks left in place (run uninstall from the checkout)"
    fi

    # Reconcile hooks.json to owned-absent FIRST. If EITHER reconcile fails, ABORT
    # the whole uninstall before touching any symlink or data — a failed reconcile
    # must not fall through to symlink/CLI removal or --purge-data (which would
    # orphan a live registration and delete the scripts it still points to).
    if ! reconcile_codex_hook "Stop" "$CODEX_DICE_BASE/codex-stop.ts" absent \
        || ! reconcile_codex_hook "SessionStart" "$CODEX_DICE_BASE/codex-session-start.ts" absent; then
        print_error "hooks.json reconcile failed — aborting uninstall (nothing removed or purged)"
        return 1
    fi
    print_success "Unregistered Codex hooks"
    safe_unlink "$CODEX_DICE_BASE/codex-stop.ts" "$SCRIPT_DIR/hooks/codex-stop.ts"
    safe_unlink "$CODEX_DICE_BASE/codex-session-start.ts" "$SCRIPT_DIR/hooks/codex-session-start.ts"
    print_success "Removed Codex hook symlinks"

    # Remove the SHARED CLI only when no other host remains (Claude module symlink
    # absent), and only OUR symlink — never an unrelated file.
    if [ -L "$DICE_BASE/cc-dice.ts" ] || [ -e "$DICE_BASE/cc-dice.ts" ]; then
        print_info "Kept shared CLI (Claude host still installed)"
    else
        safe_unlink "${HOME}/.local/bin/agent-dice" "$SCRIPT_DIR/bin/agent-dice.ts"
        safe_unlink "${HOME}/.local/bin/cc-dice" "$SCRIPT_DIR/bin/agent-dice.ts"
        print_success "Removed shared CLI symlinks (no host remains)"
    fi

    if [ "$purge" = "--purge-data" ]; then
        rm -rf "$CODEX_DICE_BASE"
        print_success "Purged Codex dice data ($CODEX_DICE_BASE)"
    else
        print_info "Kept Codex dice data at $CODEX_DICE_BASE (use 'uninstall codex --purge-data' to remove)"
    fi

    print_success "Codex uninstall complete"
}

# Verify the Codex install. Missing scripts/registration/CLI are ERRORS (a
# nonfunctional install must not report OK); exits nonzero when any error is found.
show_check_codex() {
    echo ""
    echo "agent-dice (Codex) Installation Check"
    echo ""

    if [ ! -d "$CODEX_DICE_BASE" ] && [ ! -f "$CODEX_HOOKS_JSON" ]; then
        echo -e "  ${BLUE}Not installed.${NC} Run ${BLUE}./install.sh codex${NC} to install."
        echo ""
        exit 0
    fi

    local errors=0

    if [ -d "$CODEX_DICE_BASE" ]; then
        echo -e "  ${GREEN}ok${NC} Dice base: $CODEX_DICE_BASE"
    else
        echo -e "  ${RED}err${NC} Dice base missing"; errors=$((errors + 1))
    fi

    # Hook scripts must resolve to live targets.
    for hook in codex-stop codex-session-start; do
        if [ -e "$CODEX_DICE_BASE/$hook.ts" ]; then
            echo -e "  ${GREEN}ok${NC} $hook hook file"
        else
            echo -e "  ${RED}err${NC} $hook hook missing or broken"; errors=$((errors + 1))
        fi
    done

    # Structural registration (canonical command object), not a substring grep.
    if codex_hook_registered "Stop" "$CODEX_DICE_BASE/codex-stop.ts"; then
        echo -e "  ${GREEN}ok${NC} Stop hook registered in hooks.json"
    else
        echo -e "  ${RED}err${NC} Stop hook not registered (canonical object)"; errors=$((errors + 1))
    fi
    if codex_hook_registered "SessionStart" "$CODEX_DICE_BASE/codex-session-start.ts"; then
        echo -e "  ${GREEN}ok${NC} SessionStart hook registered in hooks.json"
    else
        echo -e "  ${RED}err${NC} SessionStart hook not registered (canonical object)"; errors=$((errors + 1))
    fi

    if [ -L "${HOME}/.local/bin/agent-dice" ] && [ -e "${HOME}/.local/bin/agent-dice" ]; then
        echo -e "  ${GREEN}ok${NC} CLI symlink"
    else
        echo -e "  ${RED}err${NC} CLI missing or broken"; errors=$((errors + 1))
    fi

    echo ""
    echo -e "  ${BLUE}note${NC} Codex requires trusting untrusted command hooks. On first run,"
    echo -e "       approve the hook when prompted (a persisted approval), or pass"
    echo -e "       ${BLUE}--dangerously-bypass-hook-trust${NC} for a single non-interactive invocation."
    echo ""

    if [ $errors -eq 0 ]; then
        echo -e "${GREEN}Status: OK${NC}"; echo ""; exit 0
    else
        echo -e "${RED}Status: $errors error(s)${NC}"; echo ""; exit 1
    fi
}

show_usage() {
    echo "Usage: ./install.sh [command]"
    echo ""
    echo "Commands:"
    echo "  (default)              Install agent-dice for Claude Code"
    echo "  codex                  Install agent-dice for Codex (~/.codex)"
    echo "  uninstall              Remove the Claude Code installation"
    echo "  uninstall codex        Remove the Codex installation (keeps data)"
    echo "  uninstall codex --purge-data   Remove the Codex installation AND its data"
    echo "  check                  Verify the Claude Code installation"
    echo "  check codex            Verify the Codex installation"
    echo "  help                   Show this help"
}

# ---- Main ----

print_header

case "${1:-}" in
    ""|install)
        if ! check_dependencies; then
            exit 1
        fi
        resolve_source_dir
        install_dice
        register_hooks
        echo ""
        print_success "Installation complete!"
        echo ""
        if [ "$SCRIPT_DIR" = "$CLONE_DIR" ]; then
            print_warning "Symlinks point to $CLONE_DIR — do not delete it."
            print_info "Next steps:"
            echo "  1. Register a slot:  agent-dice register my-slot --message 'Triggered!'"
            echo "  2. Verify:           $CLONE_DIR/install.sh check"
        else
            print_info "Next steps:"
            echo "  1. Register a slot:  agent-dice register my-slot --message 'Triggered!'"
            echo "  2. Verify:           ./install.sh check"
        fi
        echo ""
        ;;
    codex)
        if ! check_dependencies; then
            exit 1
        fi
        resolve_source_dir
        if ! install_codex; then
            print_error "Codex install aborted (conflicting path) — nothing registered."
            exit 1
        fi
        if ! register_codex_hooks; then
            print_error "Hook registration failed — hooks.json left untouched."
            exit 1
        fi
        echo ""
        print_success "Codex installation complete!"
        echo ""
        print_info "Next steps:"
        echo "  1. Register a slot:  AGENT_DICE_BASE=\"\${CODEX_HOME:-\$HOME/.codex}/dice\" agent-dice register my-slot --message 'Triggered!'"
        echo "  2. Verify:           ./install.sh check codex"
        echo "  3. Codex will ask to trust the hook on first run — approve it (or pass"
        echo "     --dangerously-bypass-hook-trust once for non-interactive use)."
        echo ""
        ;;
    uninstall|-u)
        if [ "${2:-}" = "codex" ]; then
            uninstall_codex "${3:-}"
        else
            uninstall
        fi
        ;;
    check|-c)
        if [ "${2:-}" = "codex" ]; then
            show_check_codex
        else
            show_check
        fi
        ;;
    help|--help|-h)
        show_usage
        ;;
    *)
        print_error "Unknown command: $1"
        show_usage
        exit 1
        ;;
esac
