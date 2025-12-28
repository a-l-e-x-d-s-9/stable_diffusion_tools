#!/usr/bin/env python3
import argparse
import os
import sys
import json
import urllib.request
import urllib.parse
from pathlib import Path
from typing import List, Optional, Dict, Tuple


def read_text_file(path: str) -> str:
    p = Path(path).expanduser()
    return p.read_text(encoding="utf-8", errors="replace")


def read_token(token_file: str) -> str:
    token = read_text_file(token_file).strip()
    if not token:
        raise RuntimeError(f"Token file is empty: {token_file}")
    return token


def repo_base_url(repo_id: str, repo_type: str) -> str:
    if repo_type == "model":
        return f"https://huggingface.co/{repo_id}"
    if repo_type == "dataset":
        return f"https://huggingface.co/datasets/{repo_id}"
    if repo_type == "space":
        return f"https://huggingface.co/spaces/{repo_id}"
    raise ValueError(f"Unsupported repo_type: {repo_type}")


def try_list_repo_files_huggingface_hub(
    repo_id: str, revision: str, repo_type: str, token: str
) -> Optional[List[str]]:
    try:
        from huggingface_hub import HfApi  # type: ignore
    except Exception:
        return None

    api = HfApi()
    hf_repo_type = None if repo_type == "model" else repo_type
    # Official helper: returns list of paths in repo. :contentReference[oaicite:1]{index=1}
    return api.list_repo_files(repo_id=repo_id, revision=revision, repo_type=hf_repo_type, token=token)


def http_get_json(url: str, token: str, timeout_s: int = 60):
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        data = resp.read()
    return json.loads(data.decode("utf-8", errors="replace"))


def list_repo_files_via_tree_endpoint(
    repo_id: str, revision: str, repo_type: str, token: str
) -> List[str]:
    # This endpoint is used in practice by Hub tooling to list files recursively.
    # Example shape: /api/models/{repo_id}/tree/{revision}?recursive=True&expand=False
    # (Not all docs spell it out, so we keep this as fallback.)
    plural = {"model": "models", "dataset": "datasets", "space": "spaces"}[repo_type]

    safe_repo = urllib.parse.quote(repo_id, safe="/")
    safe_rev = urllib.parse.quote(revision, safe="")
    url = f"https://huggingface.co/api/{plural}/{safe_repo}/tree/{safe_rev}?recursive=True&expand=False"

    data = http_get_json(url, token=token)
    files: List[str] = []

    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "file":
                path = item.get("path") or item.get("rfilename")
                if isinstance(path, str) and path:
                    files.append(path)
    elif isinstance(data, dict):
        # Some variants may wrap entries
        for k in ("files", "siblings", "entries"):
            v = data.get(k)
            if isinstance(v, list):
                for item in v:
                    if isinstance(item, dict):
                        path = item.get("path") or item.get("rfilename")
                        if isinstance(path, str) and path:
                            files.append(path)

    # De-dup while preserving order
    seen = set()
    out = []
    for f in files:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def list_repo_files_best_effort(
    repo_id: str, revision: str, repo_type: str, token: str
) -> List[str]:
    files = try_list_repo_files_huggingface_hub(repo_id, revision, repo_type, token)
    if files is not None:
        return files

    # Fallback: tree endpoint
    return list_repo_files_via_tree_endpoint(repo_id, revision, repo_type, token)


def parent_dir(path_in_repo: str) -> str:
    d = os.path.dirname(path_in_repo)
    return d if d else "."


def bash_escape_double_quotes(s: str) -> str:
    # Safe inside "..."
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("`", "\\`")


def write_bash_script(
    out_path: str,
    repo_id: str,
    revision: str,
    repo_type: str,
    token_file_for_bash: str,
    dest_root: str,
    safetensors_paths: List[str],
) -> None:
    out_p = Path(out_path).expanduser()
    out_p.parent.mkdir(parents=True, exist_ok=True)

    token_file_for_bash_abs = str(Path(token_file_for_bash).expanduser().resolve())
    dest_root_norm = dest_root.strip()
    if not dest_root_norm:
        dest_root_norm = "."

    base = repo_base_url(repo_id, repo_type)

    # Sort by parent folder then filename for stable grouping.
    safetensors_paths_sorted = sorted(safetensors_paths, key=lambda p: (parent_dir(p), p))

    lines: List[str] = []
    lines.append("#!/usr/bin/env bash")
    lines.append("")
    lines.append(f'HF_TOKEN=`cat "{bash_escape_double_quotes(token_file_for_bash_abs)}"`')
    lines.append('HEADER="Authorization: Bearer ${HF_TOKEN}"')
    lines.append("")

    prev_dir = None
    for p in safetensors_paths_sorted:
        d = parent_dir(p)

        if prev_dir is None:
            # First group
            lines.append(f"# Folder: {d}")
        elif d != prev_dir:
            # Double blank line between folders (your request)
            lines.append("")
            lines.append("")
            lines.append(f"# Folder: {d}")

        # Compute local output dir that preserves nested structure.
        # If d == ".", output to dest_root. Otherwise dest_root/d.
        if d == ".":
            out_dir = dest_root_norm
        else:
            out_dir = os.path.join(dest_root_norm, d) if dest_root_norm != "." else d

        # Create directory (harmless even if wget lines are commented out)
        lines.append(f'mkdir -p "{bash_escape_double_quotes(out_dir)}"')

        url = f"{base}/resolve/{revision}/{p}"
        wget_cmd = f'wget --header="$HEADER" -P "{bash_escape_double_quotes(out_dir)}" "{bash_escape_double_quotes(url)}"'
        lines.append(f"#{wget_cmd}")

        prev_dir = d

    lines.append("")
    out_p.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Generate a commented-out wget bash script to download all .safetensors from a Hugging Face repo (preserving nested folders)."
    )
    ap.add_argument("--repo", required=True, help='Repo id like "alexds9/Checkpoints_Boom"')
    ap.add_argument("--token-file", required=True, help="Path to a file containing your HF token (used for listing files)")
    ap.add_argument("--token-file-for-bash", default=None, help="Path embedded into the bash script for cat (defaults to --token-file)")
    ap.add_argument("--repo-type", default="model", choices=["model", "dataset", "space"], help="Repo type")
    ap.add_argument("--revision", default="main", help='Git revision/branch/tag/commit (default: "main")')
    ap.add_argument("--dest-root", default=".", help='Local root folder for downloads (default: ".")')
    ap.add_argument("--out", required=True, help="Output bash script path, e.g. download_safetensors.sh")
    args = ap.parse_args()

    repo_id = args.repo.strip()
    token_file = args.token_file
    token_file_for_bash = args.token_file_for_bash or token_file
    repo_type = args.repo_type
    revision = args.revision.strip()
    dest_root = args.dest_root

    token = read_token(token_file)

    files = list_repo_files_best_effort(repo_id=repo_id, revision=revision, repo_type=repo_type, token=token)
    safetensors = [f for f in files if isinstance(f, str) and f.lower().endswith(".safetensors")]

    if not safetensors:
        print("No .safetensors files found.", file=sys.stderr)
        return 2

    write_bash_script(
        out_path=args.out,
        repo_id=repo_id,
        revision=revision,
        repo_type=repo_type,
        token_file_for_bash=token_file_for_bash,
        dest_root=dest_root,
        safetensors_paths=safetensors,
    )

    print(f"Wrote bash script: {args.out}")
    print(f"Found .safetensors: {len(safetensors)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
