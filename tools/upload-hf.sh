#!/usr/bin/env bash
# Upload a big PLY to a public Hugging Face dataset and print the viewer link.
# usage: tools/upload-hf.sh model.ply HF_USER [GITHUB_USER] [dataset-name=plys]
set -euo pipefail
file=${1:?model.ply}; hf_user=${2:?Hugging Face username}; gh_user=${3:-YOUR_GITHUB_USER}; repo=${4:-plys}
pip install -q -U huggingface_hub
huggingface-cli whoami >/dev/null 2>&1 || huggingface-cli login
huggingface-cli repo create "$repo" --type dataset -y >/dev/null 2>&1 || true   # public by default
name=$(basename "$file")
huggingface-cli upload "$hf_user/$repo" "$file" "$name" --repo-type dataset
echo
echo "Viewer link:"
echo "https://$gh_user.github.io/Modelview/?url=https://huggingface.co/datasets/$hf_user/$repo/resolve/main/$name"
