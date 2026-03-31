#!/bin/bash
# =============================================================================
# HeartBeatz — Git + SSH Setup for MeLE N100
# =============================================================================
# Run this ON the MeLE mini PC (ssh heartbeatz@10.0.0.51)
#
# What it does:
#   1. Generates an SSH key pair for GitHub
#   2. Configures git identity
#   3. Prints the public key — you paste this into GitHub
#   4. Tests the connection
#   5. Clones or sets up the HeartBeatz repo with SSH remote
#
# Usage:
#   chmod +x setup-git-mele.sh
#   ./setup-git-mele.sh
# =============================================================================

set -e

REPO_DIR="$HOME/HeartBeatz"
GITHUB_REPO="git@github.com:stevenpeirsman/HeartBeatz.git"

echo "============================================"
echo "  HeartBeatz — Git SSH Setup for MeLE N100"
echo "============================================"
echo ""

# --- Step 1: Generate SSH key if not present ---
SSH_KEY="$HOME/.ssh/id_ed25519"
if [ -f "$SSH_KEY" ]; then
    echo "[OK] SSH key already exists at $SSH_KEY"
else
    echo "[1/5] Generating SSH key..."
    ssh-keygen -t ed25519 -C "heartbeatz@mele-n100" -f "$SSH_KEY" -N ""
    echo "[OK] SSH key generated"
fi

# --- Step 2: Configure git identity ---
echo ""
echo "[2/5] Configuring git..."
git config --global user.name "HeartBeatz MeLE"
git config --global user.email "steven.peirsman@gmail.com"
git config --global init.defaultBranch main
git config --global pull.rebase false
echo "[OK] Git configured"

# --- Step 3: Show public key ---
echo ""
echo "============================================"
echo "  COPY THIS PUBLIC KEY TO GITHUB:"
echo "============================================"
echo ""
cat "${SSH_KEY}.pub"
echo ""
echo "============================================"
echo ""
echo "  Go to: https://github.com/settings/keys"
echo "  Click 'New SSH key'"
echo "  Title: HeartBeatz MeLE N100"
echo "  Paste the key above"
echo "  Click 'Add SSH key'"
echo ""
echo "============================================"
echo ""
read -p "Press ENTER after you've added the key to GitHub... "

# --- Step 4: Add GitHub to known hosts and test ---
echo ""
echo "[4/5] Testing GitHub connection..."
ssh-keyscan github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
ssh -T git@github.com 2>&1 || true
echo ""

# --- Step 5: Set up repo ---
echo "[5/5] Setting up HeartBeatz repository..."
if [ -d "$REPO_DIR/.git" ]; then
    echo "  Repo already exists at $REPO_DIR"
    cd "$REPO_DIR"

    # Check if remote is HTTPS and switch to SSH
    CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "none")
    if echo "$CURRENT_REMOTE" | grep -q "https://"; then
        echo "  Switching remote from HTTPS to SSH..."
        git remote set-url origin "$GITHUB_REPO"
        echo "  [OK] Remote updated to SSH"
    fi

    echo "  Pulling latest..."
    git pull origin main || echo "  (pull failed — may need to resolve conflicts)"
else
    echo "  Cloning fresh from GitHub..."
    git clone "$GITHUB_REPO" "$REPO_DIR"
    echo "  [OK] Cloned to $REPO_DIR"
fi

echo ""
echo "============================================"
echo "  DONE! Git is ready on the MeLE."
echo ""
echo "  Repo: $REPO_DIR"
echo "  Remote: $GITHUB_REPO"
echo ""
echo "  Any developer can now:"
echo "    ssh heartbeatz@10.0.0.51"
echo "    cd ~/HeartBeatz"
echo "    git pull / git push"
echo "============================================"
