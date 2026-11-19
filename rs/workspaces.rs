use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "node_modules",
    ".next",
    ".idea",
    ".vscode",
    "dist",
    "build",
    "target",
    ".cache",
];

fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name.to_lowercase().as_str())
}

pub fn strip_windows_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", stripped))
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

pub fn safe_git_path(path: &str) -> bool {
    !path.trim().is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        && !path.contains(':')
        && !path.contains('\0')
        && !path.starts_with('-')
}

struct GitChange<'a> {
    xy: &'a str,
    code: &'a str,
    path: &'a str,
    original_path: Option<&'a str>,
}

impl<'a> GitChange<'a> {
    fn rename_source(&self) -> Option<&'a str> {
        self.original_path.filter(|_| self.code.contains('R'))
    }
}

fn parse_git_status(status: &[u8]) -> impl Iterator<Item = GitChange<'_>> {
    let mut entries = status.split(|&byte| byte == 0);
    std::iter::from_fn(move || {
        while let Some(entry) = entries.next() {
            let Some(code) = entry
                .get(..2)
                .and_then(|code| std::str::from_utf8(code).ok())
            else {
                continue;
            };
            // Porcelain v1 -z lists the destination first, followed by the source.
            let original_path = if code.contains(['R', 'C']) {
                let Some(source) = entries
                    .next()
                    .and_then(|path| std::str::from_utf8(path).ok())
                else {
                    continue;
                };
                Some(source)
            } else {
                None
            };
            if let Some(path) = entry
                .get(3..)
                .filter(|p| !p.is_empty())
                .and_then(|path| std::str::from_utf8(path).ok())
            {
                return Some(GitChange {
                    xy: code,
                    code: code.trim(),
                    path,
                    original_path,
                });
            }
        }
        None
    })
}

// Hash the complete file while bounding the phone preview, including files with very long lines.
fn untracked_preview(
    mut input: impl std::io::Read,
) -> std::io::Result<([u8; 32], String, usize, bool)> {
    let mut hash = Sha256::new();
    let mut preview = Vec::new();
    let mut lines = 0;
    let mut bytes_read = 0_usize;
    let mut last_byte = None;
    let mut binary = false;
    let mut buffer = [0; 32 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let chunk = &buffer[..count];
        hash.update(chunk);
        let sample = count.min(8000_usize.saturating_sub(bytes_read));
        binary |= chunk[..sample].contains(&0);
        if !binary {
            for &byte in chunk {
                if lines < 80 && preview.len() < 64 * 1024 {
                    preview.push(byte);
                }
                lines += usize::from(byte == b'\n');
            }
        }
        bytes_read += count;
        last_byte = chunk.last().copied();
    }
    let digest = hash.finalize().into();
    if binary {
        return Ok((digest, String::new(), 0, false));
    }
    lines += usize::from(last_byte.is_some_and(|b| b != b'\n'));
    let mut diff = String::new();
    for line in String::from_utf8_lossy(&preview).lines() {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    Ok((digest, diff, lines, bytes_read > preview.len()))
}

fn resolve_desktop_dir(home: &Path, onedrive: Option<&Path>) -> PathBuf {
    let primary = home.join("Desktop");
    if primary.is_dir() {
        return primary;
    }
    if let Some(od) = onedrive {
        let fallback = od.join("Desktop");
        if fallback.is_dir() {
            return fallback;
        }
    }
    primary
}

pub struct WorkspaceState {
    pub active_path: Mutex<PathBuf>,
    allowed_roots: Vec<PathBuf>,
    home_dir: PathBuf,
    desktop_dir: PathBuf,
}

impl WorkspaceState {
    pub fn new(root: PathBuf) -> Self {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| root.clone());
        let onedrive = std::env::var_os("OneDrive")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty());
        Self::new_with_paths(root, home, onedrive)
    }

    #[cfg(test)]
    fn new_with_home(root: PathBuf, home: PathBuf) -> Self {
        Self::new_with_paths(root, home, None)
    }

    fn new_with_paths(root: PathBuf, home: PathBuf, onedrive: Option<PathBuf>) -> Self {
        let desktop_dir = resolve_desktop_dir(&home, onedrive.as_deref());
        let mut allowed_roots = vec![
            root.clone(),
            home.join("Projects"),
            home.join("Desktop"),
            desktop_dir.clone(),
            home.join("Documents"),
        ];
        if let Some(parent) = root.parent().filter(|p| p.parent().is_some()) {
            allowed_roots.push(parent.to_path_buf());
        }
        let allowed_roots = allowed_roots
            .into_iter()
            .filter_map(|p| p.canonicalize().ok())
            .collect();
        Self {
            active_path: Mutex::new(root),
            allowed_roots,
            home_dir: home,
            desktop_dir,
        }
    }

    pub fn permits(&self, path: &Path) -> bool {
        path.canonicalize()
            .is_ok_and(|p| self.allowed_roots.iter().any(|root| p.starts_with(root)))
    }

    pub fn get_active_path(&self) -> PathBuf {
        self.active_path
            .lock()
            .map(|p| p.clone())
            .unwrap_or_else(|_| PathBuf::from("."))
    }

    pub fn set_active_workspace(&self, target: &str) -> Value {
        let p = PathBuf::from(target);
        if !self.permits(&p) {
            return json!({"status":"error", "message":"Folder is outside the allowed project directories."});
        }
        if !p.exists() || !p.is_dir() {
            return json!({
                "status": "error",
                "message": format!("Folder not found: {}", target),
            });
        }
        let clean_path = strip_windows_prefix(p.canonicalize().unwrap_or(p));
        if let Ok(mut act) = self.active_path.lock() {
            *act = clean_path.clone();
        }
        let info = Self::workspace_info(&clean_path);
        json!({
            "status": "ok",
            "message": format!("Active project changed to {}", info["name"].as_str().unwrap_or("")),
            "workspace": info,
        })
    }

    pub fn workspace_info(path: &Path) -> Value {
        let is_git = path.join(".git").exists();
        let mut branch = "not a git repo".to_string();
        if is_git {
            let mut cmd = Command::new("git");
            cmd.args(["branch", "--show-current"]).current_dir(path);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Ok(out) = cmd.output() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                branch = if s.is_empty() {
                    "HEAD detached".to_string()
                } else {
                    s
                };
            }
        }
        let mut file_count = 0usize;
        if let Ok(entries) = fs::read_dir(path) {
            for e in entries.map_while(Result::ok) {
                if e.path().is_file() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !name.starts_with('.') {
                        file_count += 1;
                    }
                }
            }
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Workspace")
            .to_string();
        json!({
            "name": name,
            "path": path.to_string_lossy(),
            "is_git": is_git,
            "branch": branch,
            "root_file_count": file_count,
        })
    }

    pub fn list_accessible_folders(&self) -> Vec<Value> {
        let active = self.get_active_path();
        let mut folders = Vec::new();
        let mut seen = HashSet::new();

        let active_str = active.to_string_lossy().to_string();
        let active_name = active
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Workspace")
            .to_string();

        folders.push(json!({
            "name": active_name,
            "display_name": format!("[ACTIVE] {}", active_name),
            "path": active_str,
            "is_active": true,
            "is_git": active.join(".git").exists(),
            "depth": 0,
            "root_group": active_name,
        }));
        seen.insert(active_str.to_lowercase());

        let mut roots = Vec::new();
        if let Some(p) = active.parent() {
            roots.push(p.to_path_buf());
        }
        roots.push(self.home_dir.join("Projects"));
        roots.push(self.desktop_dir.clone());

        for root in roots {
            let Ok(entries) = fs::read_dir(&root) else {
                continue;
            };
            let mut dir_paths: Vec<PathBuf> = entries
                .map_while(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dir_paths.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));

            for item in dir_paths {
                let Some(name) = item
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
                else {
                    continue;
                };
                if is_ignored_dir(&name) {
                    continue;
                }
                let p_str = item.to_string_lossy().to_string();
                if seen.insert(p_str.to_lowercase()) {
                    folders.push(json!({
                        "name": name,
                        "display_name": format!("[PROJECT] {}", name),
                        "path": p_str,
                        "is_active": false,
                        "is_git": item.join(".git").exists(),
                        "depth": 0,
                        "root_group": name,
                    }));
                }
            }
        }
        folders
    }

    fn count_subfolders(&self, dir: &Path) -> usize {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        entries
            .map_while(Result::ok)
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if is_ignored_dir(&name) {
                    return false;
                }
                let child = e.path();
                child.is_dir() && self.permits(&child)
            })
            .count()
    }

    fn build_browse_shortcuts(&self) -> Vec<Value> {
        let mut shortcuts = Vec::new();
        let mut seen = HashSet::new();
        let active = self.get_active_path();
        let mut candidates: Vec<(&str, PathBuf)> = Vec::new();
        if let Some(parent) = active.parent() {
            candidates.push(("Parent", parent.to_path_buf()));
        }
        candidates.push(("Projects", self.home_dir.join("Projects")));
        candidates.push(("Desktop", self.desktop_dir.clone()));
        candidates.push(("Documents", self.home_dir.join("Documents")));

        for (fallback_name, cand) in candidates {
            if !cand.is_dir() || !self.permits(&cand) {
                continue;
            }
            let clean = strip_windows_prefix(cand.canonicalize().unwrap_or(cand));
            let clean_str = clean.to_string_lossy().to_string();
            if seen.insert(clean_str.to_lowercase()) {
                let name = clean
                    .file_name()
                    .and_then(|n| n.to_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(fallback_name);
                shortcuts.push(json!({
                    "name": name,
                    "path": clean_str,
                }));
            }
        }
        shortcuts
    }

    pub fn browse_directory(&self, target: Option<&str>) -> Value {
        let dir = match target.map(str::trim).filter(|s| !s.is_empty()) {
            Some(t) if t.eq_ignore_ascii_case("desktop") => self.desktop_dir.clone(),
            Some(t) => PathBuf::from(t),
            None => self.get_active_path(),
        };
        if !self.permits(&dir) {
            return json!({
                "status": "error",
                "message": "Folder is outside the allowed project directories.",
                "entries": [],
                "subfolders": [],
                "breadcrumbs": [],
                "shortcuts": [],
            });
        }

        if !dir.exists() || !dir.is_dir() {
            return json!({
                "status": "error",
                "message": "Directory not found",
                "current_path": dir.to_string_lossy(),
                "entries": [],
                "subfolders": [],
                "breadcrumbs": [],
                "shortcuts": [],
            });
        }

        let dir = strip_windows_prefix(dir.canonicalize().unwrap_or(dir));
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        let mut subfolders = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.map_while(Result::ok) {
                let p = e.path();
                if !self.permits(&p) {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let p_str = p.to_string_lossy().to_string();
                if p.is_dir() {
                    let is_git = p.join(".git").exists();
                    dirs.push(json!({
                        "name": name,
                        "path": p_str,
                        "type": "dir",
                        "is_git": is_git,
                    }));
                    if !is_ignored_dir(&name) {
                        let subfolder_count = self.count_subfolders(&p);
                        subfolders.push(json!({
                            "name": name,
                            "path": p_str,
                            "is_git": is_git,
                            "subfolder_count": subfolder_count,
                            "has_children": subfolder_count > 0,
                        }));
                    }
                } else {
                    let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
                    files.push(json!({
                        "name": name,
                        "path": p_str,
                        "type": "file",
                        "size": sz,
                    }));
                }
            }
        }
        subfolders.sort_by(|a, b| {
            let na = a["name"].as_str().unwrap_or("").to_lowercase();
            let nb = b["name"].as_str().unwrap_or("").to_lowercase();
            na.cmp(&nb)
        });
        dirs.extend(files);
        let parent = dir
            .parent()
            .filter(|p| self.permits(p))
            .map(|p| p.to_string_lossy().to_string());
        let mut breadcrumbs: Vec<Value> = dir
            .ancestors()
            .filter(|ancestor| self.permits(ancestor))
            .map(|ancestor| {
                let name = ancestor
                    .file_name()
                    .and_then(|n| n.to_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| ancestor.to_string_lossy().to_string());
                json!({
                    "name": name,
                    "path": ancestor.to_string_lossy(),
                })
            })
            .collect();
        breadcrumbs.reverse();

        json!({
            "status": "ok",
            "current_path": dir.to_string_lossy(),
            "parent_path": parent,
            "entries": dirs,
            "subfolders": subfolders,
            "breadcrumbs": breadcrumbs,
            "shortcuts": self.build_browse_shortcuts(),
        })
    }

    pub fn get_git_changes(repo_path: &Path) -> Value {
        let ws_name = repo_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Workspace")
            .to_string();
        if matches!(repo_path.join(".git").try_exists(), Ok(false)) {
            return json!({
                "is_git": false,
                "workspace": repo_path.to_string_lossy(),
                "workspace_name": ws_name,
                "total_changes": 0,
                "total_additions": 0,
                "total_deletions": 0,
                "files": [],
            });
        }

        Self::read_git_changes(repo_path, &ws_name).unwrap_or_else(|message| {
            json!({
                "availability": "unavailable", "message": message, "workspace_name": ws_name,
                "workspace": repo_path, "is_git": true,
            })
        })
    }

    fn git_bytes(command: &mut Command) -> Result<Vec<u8>, String> {
        let out = command.output().map_err(|err| err.to_string())?;
        if out.status.success() {
            Ok(out.stdout)
        } else {
            Err(Self::git_error_message(&out))
        }
    }

    fn read_git_changes(repo_path: &Path, ws_name: &str) -> Result<Value, String> {
        let status = Self::git_status(repo_path)?;
        // Reject unsupported filenames instead of issuing a revision for a partial listing.
        std::str::from_utf8(&status)
            .map_err(|_| "Git returned a filename this bridge cannot display.")?;
        let head = Self::make_git(repo_path)
            .args(["rev-parse", "--verify", "--quiet", "HEAD"])
            .output()
            .map_err(|err| err.to_string())?;
        let base = match head.status.code() {
            Some(0) => head.stdout,
            Some(1) => Self::git_bytes(Self::make_git(repo_path).args([
                "hash-object",
                "-t",
                "tree",
                "--stdin",
            ]))?,
            _ => return Err(Self::git_error_message(&head)),
        };
        let base = std::str::from_utf8(&base)
            .map_err(|err| err.to_string())?
            .trim();
        let mut revision = Sha256::new();
        let mut include = |bytes: &[u8]| {
            revision.update((bytes.len() as u64).to_be_bytes());
            revision.update(bytes);
        };
        include(
            strip_windows_prefix(repo_path.canonicalize().map_err(|e| e.to_string())?)
                .as_os_str()
                .as_encoded_bytes(),
        );
        include(base.as_bytes());
        include(&status);
        include(&Self::git_bytes(
            Self::make_git(repo_path).args(["ls-files", "--stage", "-z"]),
        )?);
        let mut files = Vec::new();
        let mut total_add = 0usize;
        let mut total_del = 0usize;

        for change in parse_git_status(&status) {
            let code = change.code;
            let raw_file = change.path;
            let status_label = if code.contains('?') {
                "untracked"
            } else if code.contains('R') {
                "renamed"
            } else if code.contains('C') {
                "copied"
            } else if code.contains('A') {
                "added"
            } else if code.contains('D') {
                "deleted"
            } else {
                "modified"
            };

            let mut diff_text = String::new();
            let mut additions = 0usize;
            let mut deletions = 0usize;

            let mut truncated = false;
            if status_label == "untracked" {
                let fp = repo_path.join(raw_file);
                let kind = fs::symlink_metadata(&fp)
                    .map_err(|err| err.to_string())?
                    .file_type();
                if kind.is_dir() && fp.join(".git").exists() {
                    include(b"embedded git repository");
                    let head = Self::make_git(&fp)
                        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
                        .output()
                        .map_err(|e| e.to_string())?;
                    match head.status.code() {
                        Some(0) => include(&head.stdout),
                        Some(1) => include(b"unborn HEAD"),
                        _ => return Err(Self::git_error_message(&head)),
                    }
                } else {
                    let result = if kind.is_symlink() {
                        include(b"symlink");
                        let target = fs::read_link(&fp).map_err(|err| err.to_string())?;
                        untracked_preview(target.as_os_str().as_encoded_bytes())
                    } else if kind.is_file() {
                        include(b"file");
                        untracked_preview(fs::File::open(&fp).map_err(|err| err.to_string())?)
                    } else {
                        return Err(format!("Unsupported file type at '{}'.", raw_file));
                    }
                    .map_err(|err| err.to_string())?;
                    let (digest, preview, count, clipped) = result;
                    include(&digest);
                    diff_text = preview;
                    additions = count;
                    truncated = clipped;
                }
            } else {
                let mut cmd = Self::make_git(repo_path);
                cmd.args([
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--full-index",
                    "--submodule=short",
                    "--find-renames",
                    base,
                    "--",
                    raw_file,
                ]);
                if let Some(source) = change.rename_source() {
                    cmd.arg(source);
                }
                let bytes = Self::git_bytes(&mut cmd)?;
                include(&bytes);
                let mut in_hunk = false;
                for (idx, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
                    if line.starts_with("diff --git ") {
                        in_hunk = false;
                    }
                    if line.starts_with("@@ ") {
                        in_hunk = true;
                    }
                    if in_hunk {
                        additions += usize::from(line.starts_with('+'));
                        deletions += usize::from(line.starts_with('-'));
                    }
                    if idx < 160 {
                        diff_text.push_str(line);
                        diff_text.push('\n');
                    } else {
                        truncated = true;
                    }
                }
            }

            total_add += additions;
            total_del += deletions;
            files.push(json!({
                "file": raw_file,
                "path": raw_file,
                "original_path": change.original_path,
                "status": status_label,
                "code": code,
                "additions": additions,
                "insertions": additions,
                "deletions": deletions,
                "diff": diff_text,
                "diff_truncated": truncated,
            }));
        }

        Ok(json!({
            "availability": "ready",
            "revision": format!("{:x}", revision.finalize()),
            "is_git": true,
            "workspace": repo_path.to_string_lossy(),
            "workspace_name": ws_name,
            "total_changes": files.len(),
            "total_changed": files.len(),
            "total_additions": total_add,
            "total_insertions": total_add,
            "total_deletions": total_del,
            "files": files,
        }))
    }

    fn make_git(repo_path: &Path) -> Command {
        let mut c = Command::new("git");
        c.current_dir(repo_path)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_LITERAL_PATHSPECS", "1");
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }

    fn require_git_root(repo_path: &Path) -> Result<(), Value> {
        // Git discovers parent repositories from subfolders. Actions use the same
        // root-relative paths as the Changes listing, including bulk actions.
        if repo_path.join(".git").exists()
            && Self::make_git(repo_path)
                .args(["rev-parse", "--show-prefix"])
                .output()
                .is_ok_and(|out| {
                    out.status.success() && (out.stdout == b"\n" || out.stdout == b"\r\n")
                })
        {
            return Ok(());
        }
        Err(
            json!({"status":"error", "code":"invalid_git_workspace", "message":"Select a Git repository root to review its changes."}),
        )
    }

    fn git_status(repo_path: &Path) -> Result<Vec<u8>, String> {
        let output = Self::make_git(repo_path)
            .args([
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--find-renames",
            ])
            .output()
            .map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(output.stdout)
    }

    fn file_action_paths(repo_path: &Path, file_path: &str) -> Result<(Vec<String>, bool), Value> {
        let invalid =
            |message| json!({"status":"error", "code":"invalid_file_change", "message":message});
        if !safe_git_path(file_path) {
            return Err(invalid("Invalid file path."));
        }
        Self::require_git_root(repo_path)?;
        #[cfg(windows)]
        let file_path = &file_path.replace('\\', "/");
        let status = Self::git_status(repo_path)
            .map_err(|message| json!({"status":"error", "message":message}))?;
        let changes: Vec<_> = parse_git_status(&status).collect();
        let Some(change) = changes.iter().find(|change| change.path == file_path) else {
            return Err(invalid("Select one exact file from the current changes."));
        };
        let mut paths = vec![change.path];
        if let Some(source) = change.rename_source() {
            // A separate file may have been created at the old name since the move.
            // Case-only renames can still resolve to the destination on Windows.
            let case_only = cfg!(windows) && source.eq_ignore_ascii_case(change.path);
            if !case_only && fs::symlink_metadata(repo_path.join(source)).is_ok() {
                return Err(invalid("The original rename path is occupied. Check the files on the laptop before proceeding."));
            }
            paths.push(source);
        }

        let overlaps = |a: &str, b: &str| {
            a == b
                || a.strip_prefix(b).is_some_and(|rest| rest.starts_with('/'))
                || b.strip_prefix(a).is_some_and(|rest| rest.starts_with('/'))
        };
        for path in &paths {
            if !safe_git_path(path)
                || fs::symlink_metadata(repo_path.join(path)).is_ok_and(|entry| entry.is_dir())
                || changes
                    .iter()
                    .filter(|other| !std::ptr::eq(*other, change))
                    .any(|other| {
                        overlaps(path, other.path)
                            || other
                                .rename_source()
                                .is_some_and(|source| overlaps(path, source))
                    })
            {
                return Err(invalid(
                    "This change overlaps another file or directory. Review it on the laptop.",
                ));
            }
        }
        Ok((
            paths.into_iter().map(str::to_owned).collect(),
            change.code == "??",
        ))
    }

    pub fn reject_git_change(repo_path: &Path, file_path: &str, reviewed_untracked: bool) -> Value {
        let (paths, is_untracked) = match Self::file_action_paths(repo_path, file_path) {
            Ok(change) => change,
            Err(error) => return error,
        };
        if is_untracked != reviewed_untracked {
            return json!({"status":"error","code":"stale_review","message":"The file changed. Review it again before reverting."});
        }
        if is_untracked {
            let mut clean_cmd = Self::make_git(repo_path);
            clean_cmd.args(["clean", "-f", "--"]).args(&paths);
            return match clean_cmd.output() {
                Ok(out) if out.status.success() => json!({
                    "status": "ok",
                    "message": format!("Changes to {} were reverted.", file_path),
                }),
                Ok(out) => {
                    json!({"status":"error", "message":String::from_utf8_lossy(&out.stderr).trim()})
                }
                Err(e) => json!({"status":"error", "message":e.to_string()}),
            };
        }

        Self::restore_git_paths(
            repo_path,
            paths.iter().map(String::as_str),
            format!("Changes to {} were reverted.", file_path),
        )
    }

    pub fn reject_all_git_changes(repo_path: &Path) -> Value {
        if let Err(err) = Self::require_git_root(repo_path) {
            return err;
        }
        Self::restore_git_paths(
            repo_path,
            ["."],
            "Tracked changes were reverted; untracked files were preserved.".to_string(),
        )
    }

    // git restore can overwrite untracked files while materializing missing HEAD paths.
    // Check those paths and their ancestors before applying any part of the restore.
    fn check_restore_obstructions(repo_path: &Path, paths: &[&str]) -> Result<(), Value> {
        let error = |message: String| json!({"status":"error", "message":message});
        let deleted = Self::make_git(repo_path)
            .args([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--diff-filter=D",
                "--name-only",
                "-z",
                "HEAD",
                "--",
            ])
            .args(paths)
            .output()
            .map_err(|err| error(err.to_string()))?;
        if !deleted.status.success() {
            if Self::make_git(repo_path)
                .args(["rev-parse", "--verify", "--quiet", "HEAD"])
                .output()
                .is_ok_and(|out| out.status.code() == Some(1))
            {
                return Err(
                    json!({"status":"error", "code":"missing_head", "message":"This repository needs a first commit before tracked files can be restored to HEAD."}),
                );
            }
            return Err(error(Self::git_error_message(&deleted)));
        }
        let names = std::str::from_utf8(&deleted.stdout)
            .map_err(|_| error("Git returned a filename the bridge cannot verify.".into()))?;
        let mut checked = HashSet::new();
        for name in names.split('\0').filter(|name| !name.is_empty()) {
            let mut candidate = PathBuf::new();
            for part in Path::new(name).components() {
                candidate.push(part);
                match fs::symlink_metadata(repo_path.join(&candidate)) {
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
                    Err(err) => return Err(error(err.to_string())),
                    Ok(meta)
                        if meta.is_dir()
                            && !meta.file_type().is_symlink()
                            && candidate != Path::new(name) =>
                    {
                        continue
                    }
                    Ok(_) => {}
                }
                if checked.insert(candidate.clone()) {
                    // Without exclude rules Git includes ignored files here too.
                    let others = Self::make_git(repo_path)
                        .args(["ls-files", "--others", "-z", "--"])
                        .arg(&candidate)
                        .output()
                        .map_err(|err| error(err.to_string()))?;
                    if !others.status.success() {
                        return Err(error(Self::git_error_message(&others)));
                    }
                    if !others.stdout.is_empty() {
                        return Err(json!({"status":"error", "code":"restore_would_overwrite",
                            "message":format!("Revert would overwrite untracked content at '{}'. Move it on the laptop, then retry.", candidate.display())}));
                    }
                }
                break;
            }
        }
        Ok(())
    }

    fn restore_git_paths<'a>(
        repo_path: &Path,
        paths: impl IntoIterator<Item = &'a str>,
        success_message: String,
    ) -> Value {
        let paths = paths.into_iter().collect::<Vec<_>>();
        if let Err(err) = Self::check_restore_obstructions(repo_path, &paths) {
            return err;
        }
        let mut cmd = Self::make_git(repo_path);
        cmd.args(["restore", "--source=HEAD", "--staged", "--worktree", "--"])
            .args(paths);
        match cmd.output() {
            Ok(out) if out.status.success() => json!({
                "status": "ok",
                "message": success_message,
            }),
            Ok(out) => {
                json!({"status":"error", "message":String::from_utf8_lossy(&out.stderr).trim()})
            }
            Err(e) => json!({"status":"error", "message":e.to_string()}),
        }
    }

    pub fn accept_git_change(repo_path: &Path, file_path: &str, commit_msg: Option<&str>) -> Value {
        let (paths, is_untracked) = match Self::file_action_paths(repo_path, file_path) {
            Ok(change) => change,
            Err(error) => return error,
        };
        if let [destination, source] = paths.as_slice() {
            if cfg!(windows)
                && source.eq_ignore_ascii_case(destination)
                && repo_path.join(source).exists()
            {
                return json!({
                    "status": "error",
                    "code": "invalid_file_change",
                    "message": "Open the project on the laptop to commit this case-only rename.",
                });
            }
        }
        Self::accept_file_paths(repo_path, &paths, is_untracked, commit_msg)
    }

    pub fn accept_all_git_changes(repo_path: &Path, commit_msg: Option<&str>) -> Value {
        if let Err(err) = Self::require_git_root(repo_path) {
            return err;
        }
        match Self::commit_all(repo_path, Self::commit_message(commit_msg)) {
            Ok(()) => json!({"status":"ok","message":"Changes accepted and committed."}),
            Err(error) => error,
        }
    }

    fn git_error_message(output: &std::process::Output) -> String {
        for stream in [&output.stderr, &output.stdout] {
            let message = String::from_utf8_lossy(stream).trim().to_string();
            if !message.is_empty() {
                return message;
            }
        }
        format!(
            "Git failed with {}. Review the repository on the laptop.",
            output.status
        )
    }

    fn commit_message(msg: Option<&str>) -> &str {
        msg.filter(|s| !s.trim().is_empty())
            .unwrap_or("chore: accept changes via Antigravity Mobile Bridge")
    }

    fn commit_all(repo: &Path, message: &str) -> Result<(), Value> {
        let error = |message: String| json!({"status":"error","message":message});
        let index = Self::git_bytes(Self::make_git(repo).args([
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "index",
        ]))
        .map_err(error)?;
        let index = PathBuf::from(
            std::str::from_utf8(&index)
                .map_err(|e| error(e.to_string()))?
                .trim_end_matches(['\r', '\n']),
        );
        let mut lock_name = index.as_os_str().to_os_string();
        lock_name.push(".lock");
        let lock = PathBuf::from(lock_name);
        let temporary = index.with_file_name(format!("bridge-index-{}", uuid::Uuid::new_v4()));
        // Reserve Git's ordinary index lock while hooks and staging operate on a private copy.
        drop(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock)
                .map_err(|e| error(format!("Cannot lock the Git index: {e}")))?,
        );
        let mut keep_copy = false;
        let result = (|| {
            match fs::copy(&index, &temporary) {
                Ok(_) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(error(e.to_string())),
            }
            let status = Self::git_status(repo).map_err(error)?;
            let mut staged = HashSet::new();
            let mut working = HashSet::new();
            for change in parse_git_status(&status) {
                let xy = change.xy.as_bytes();
                if matches!(change.xy, "AA" | "DD") || xy.contains(&b'U') {
                    return Err(
                        json!({"status":"error","code":"divergent_index","message":"Resolve the Git merge conflicts on the laptop before accepting all."}),
                    );
                }
                if xy[0] != b' ' && xy[0] != b'?' {
                    staged.insert(change.path);
                    staged.extend(change.rename_source());
                }
                if xy[1] != b' ' {
                    working.insert(change.path);
                }
            }
            if let Some(path) = staged.intersection(&working).next() {
                return Err(
                    json!({"status":"error","code":"divergent_index","message":format!("'{}' has different staged and working versions. Review it on the laptop before accepting all.",path)}),
                );
            }
            for args in [&["add", "-A"][..], &["commit", "-m", message]] {
                Self::git_bytes(
                    Self::make_git(repo)
                        .env("GIT_INDEX_FILE", &temporary)
                        .args(args),
                )
                .map_err(|message| json!({"status":"error","code":"git_commit_failed","message":message}))?;
            }
            if let Err(e) = fs::rename(&temporary, &index) {
                keep_copy = true;
                return Err(error(format!("Git created the commit, but could not install its index: {e}. The prepared index is at {}.", temporary.display())));
            }
            Ok(())
        })();
        if !keep_copy {
            let _ = fs::remove_file(temporary);
        }
        let _ = fs::remove_file(lock);
        result
    }

    fn accept_file_paths(
        repo_path: &Path,
        paths: &[String],
        needs_add: bool,
        commit_msg: Option<&str>,
    ) -> Value {
        // Accept commits the working copy. An index-only edit can otherwise
        // appear in status but produce an empty `commit --only` diagnostic.
        // Untracked files need staging first, and an unborn HEAD is handled by
        // the normal initial-commit path below.
        if !needs_add {
            let unchanged = Self::make_git(repo_path)
                .args([
                    "diff",
                    "--quiet",
                    "--no-ext-diff",
                    "--no-textconv",
                    "HEAD",
                    "--",
                ])
                .args(paths)
                .output()
                .is_ok_and(|out| out.status.success());
            if unchanged {
                return json!({
                    "status":"error",
                    "code":"no_worktree_changes",
                    "message":"The working copy matches HEAD, so there is nothing to commit for this file. Staged changes were left untouched. Review them in Git on the laptop before accepting."
                });
            }
        }
        // --only reads tracked paths directly, including the staged deletion side of a rename.
        if needs_add {
            let mut add_cmd = Self::make_git(repo_path);
            add_cmd.args(["add", "--"]).args(paths);
            match add_cmd.output() {
                Ok(out) if out.status.success() => {}
                Ok(out) => {
                    return json!({"status":"error", "message":Self::git_error_message(&out)})
                }
                Err(e) => return json!({"status":"error", "message":e.to_string()}),
            }
        }

        let mut commit_cmd = Self::make_git(repo_path);
        commit_cmd
            .args([
                "commit",
                "-m",
                Self::commit_message(commit_msg),
                "--only",
                "--",
            ])
            .args(paths);
        match commit_cmd.output() {
            Ok(out) if out.status.success() => json!({
                "status": "ok",
                "message": "Changes accepted and committed.",
            }),
            Ok(out) => {
                json!({"status":"error", "message":Self::git_error_message(&out)})
            }
            Err(e) => json!({"status":"error", "message":e.to_string()}),
        }
    }

    pub fn discover_skills() -> Vec<Value> {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));

        let roots = [
            home.join(".gemini").join("config").join("skills"),
            home.join(".gemini")
                .join("antigravity")
                .join("builtin")
                .join("skills"),
        ];

        let mut skills = Vec::new();
        let mut seen = HashSet::new();

        for r in roots {
            let Ok(entries) = fs::read_dir(&r) else {
                continue;
            };
            for e in entries.map_while(Result::ok) {
                let p = e.path();
                if !p.is_dir() {
                    continue;
                }
                let skill_md = p.join("SKILL.md");
                if !skill_md.exists() {
                    continue;
                }
                let id = e.file_name().to_string_lossy().to_string();
                if !seen.insert(id.clone()) {
                    continue;
                }
                let raw = fs::read_to_string(&skill_md).unwrap_or_default();
                let mut desc = "Antigravity Specialized Skill".to_string();
                for line in raw.lines().take(20) {
                    if let Some(d) = line.strip_prefix("description:") {
                        desc = d.trim().trim_matches('"').trim_matches('\'').to_string();
                        break;
                    }
                }
                skills.push(json!({
                    "id": id,
                    "name": id.replace('-', " "),
                    "description": desc,
                    "path": skill_md.to_string_lossy(),
                }));
            }
        }
        skills.sort_by(|a, b| {
            let na = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let nb = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
            na.cmp(nb)
        });
        skills
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_git_operations_are_errors() {
        let root = std::env::temp_dir().join(format!("ag-git-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(
            WorkspaceState::accept_git_change(&root, "missing.rs", None)["status"],
            "error"
        );
        assert_eq!(
            WorkspaceState::reject_git_change(&root, "missing.rs", false)["status"],
            "error"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepting_one_file_preserves_unrelated_staged_changes() {
        let root = std::env::temp_dir().join(format!("ag-git-scope-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init"]);
        git(&["config", "user.name", "Audit"]);
        git(&["config", "user.email", "audit@example.invalid"]);
        fs::write(root.join("one.txt"), "original\n").unwrap();
        fs::write(root.join("two.txt"), "original\n").unwrap();
        git(&["add", "--", "."]);
        git(&["commit", "-m", "Initial"]);
        fs::write(root.join("one.txt"), "updated\n").unwrap();
        fs::write(root.join("two.txt"), "unrelated staged edit\n").unwrap();
        git(&["add", "--", "two.txt"]);
        assert_eq!(
            WorkspaceState::accept_git_change(&root, "one.txt", Some("Accept one"))["status"],
            "ok"
        );
        assert_eq!(git(&["show", "HEAD:two.txt"]), "original");
        assert_eq!(git(&["diff", "--cached", "--name-only"]), "two.txt");
        fs::write(root.join("日本語 file.txt"), "new file\n").unwrap();
        let changes = WorkspaceState::get_git_changes(&root);
        assert!(changes["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == "日本語 file.txt"));
        assert_eq!(changes["total_insertions"], 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn browse_directory_returns_subfolders_breadcrumbs_shortcuts_and_desktop() {
        let base = std::env::temp_dir().join(format!("ag-browse-{}", uuid::Uuid::new_v4()));
        let home = base.join("home");
        let projects = home.join("Projects");
        let desktop = home.join("Desktop");
        let documents = home.join("Documents");
        let workspace = projects.join("active-app");
        let nested_git = workspace.join("module-a");
        let nested_leaf = nested_git.join("src");
        let empty_dir = workspace.join("empty-dir");

        fs::create_dir_all(&nested_leaf).unwrap();
        fs::create_dir_all(nested_git.join(".git")).unwrap();
        fs::create_dir_all(nested_git.join("node_modules")).unwrap();
        fs::create_dir_all(&empty_dir).unwrap();
        fs::create_dir_all(workspace.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(workspace.join("target/debug")).unwrap();
        fs::create_dir_all(workspace.join(".hidden")).unwrap();
        fs::create_dir_all(&desktop).unwrap();
        fs::create_dir_all(&documents).unwrap();
        fs::write(workspace.join("README.md"), "hi\n").unwrap();

        let ws = WorkspaceState::new_with_home(workspace.clone(), home.clone());
        let res = ws.browse_directory(None);
        assert_eq!(res["status"], "ok");

        // Backwards compatibility: entries still present
        assert!(res["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "README.md" && e["type"] == "file"));

        // Subfolders exclude dot-prefixed and ignored dirs, include metadata
        let subfolders = res["subfolders"].as_array().unwrap();
        let names: Vec<&str> = subfolders
            .iter()
            .filter_map(|s| s["name"].as_str())
            .collect();
        assert_eq!(names, vec!["empty-dir", "module-a"]);
        assert_eq!(subfolders[0]["has_children"], false);
        assert_eq!(subfolders[0]["subfolder_count"], 0);
        assert_eq!(subfolders[1]["is_git"], true);
        assert_eq!(subfolders[1]["subfolder_count"], 1);
        assert_eq!(subfolders[1]["has_children"], true);

        // Breadcrumbs only include permitted ancestors from highest permitted down to current
        let crumbs = res["breadcrumbs"].as_array().unwrap();
        let crumb_names: Vec<&str> = crumbs.iter().filter_map(|c| c["name"].as_str()).collect();
        assert_eq!(crumb_names, vec!["Projects", "active-app"]);

        // Shortcuts include deduplicated permitted directories among parent, Projects, Desktop, Documents
        let shortcuts = res["shortcuts"].as_array().unwrap();
        let shortcut_names: Vec<&str> = shortcuts
            .iter()
            .filter_map(|s| s["name"].as_str())
            .collect();
        assert_eq!(shortcut_names, vec!["Projects", "Desktop", "Documents"]);

        // Case-insensitive "desktop" target resolves to home/Desktop when permitted
        let desktop_res = ws.browse_directory(Some("DeSkToP"));
        assert_eq!(desktop_res["status"], "ok");
        assert_eq!(
            PathBuf::from(desktop_res["current_path"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            desktop.canonicalize().unwrap()
        );

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejecting_untracked_file_removes_it_while_preserving_other_files() {
        let root = std::env::temp_dir().join(format!("ag-reject-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("sub")).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "Audit"]);
        git(&["config", "user.email", "audit@example.invalid"]);
        fs::write(root.join("tracked.txt"), "v1\n").unwrap();
        fs::write(root.join("single_tracked.txt"), "s1\n").unwrap();
        git(&["add", "--", "."]);
        git(&["commit", "-m", "Initial"]);

        fs::write(root.join("tracked.txt"), "v2\n").unwrap();
        fs::write(root.join("single_tracked.txt"), "s2\n").unwrap();
        fs::write(root.join("sub/untracked.txt"), "temp\n").unwrap();
        fs::write(root.join("keep_untracked.txt"), "user notes\n").unwrap();

        let res = WorkspaceState::reject_git_change(&root, "sub/untracked.txt", true);
        assert_eq!(res["status"], "ok");
        assert_eq!(
            res["message"],
            "Changes to sub/untracked.txt were reverted."
        );
        assert!(!root.join("sub/untracked.txt").exists());
        assert!(root.join("keep_untracked.txt").exists());

        let single_res = WorkspaceState::reject_git_change(&root, "single_tracked.txt", false);
        assert_eq!(single_res["status"], "ok");
        assert_eq!(
            fs::read_to_string(root.join("single_tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "s1\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "v2\n"
        );

        // "all" bulk helper restores tracked files without wiping unrelated untracked files
        let all_res = WorkspaceState::reject_all_git_changes(&root);
        assert_eq!(all_res["status"], "ok");
        assert_eq!(
            all_res["message"],
            "Tracked changes were reverted; untracked files were preserved."
        );
        assert_eq!(
            fs::read_to_string(root.join("tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "v1\n"
        );
        assert!(root.join("keep_untracked.txt").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn literal_file_named_all_is_accepted_and_rejected_individually() {
        let root = std::env::temp_dir().join(format!("ag-lit-all-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "user.name", "Audit"]);
        git(&["config", "user.email", "audit@example.invalid"]);
        fs::write(root.join("existing.txt"), "original\n").unwrap();
        git(&["add", "--", "existing.txt"]);
        git(&["commit", "-m", "Initial"]);

        // Untracked literal file named "all" alongside modified + staged unrelated files
        fs::write(root.join("existing.txt"), "unrelated user edit\n").unwrap();
        fs::write(root.join("staged.txt"), "staged\n").unwrap();
        git(&["add", "--", "staged.txt"]);
        fs::write(root.join("all"), "new literal file\n").unwrap();

        let rej_untracked = WorkspaceState::reject_git_change(&root, "all", true);
        assert_eq!(rej_untracked["status"], "ok");
        assert!(!root.join("all").exists());
        assert_eq!(
            fs::read_to_string(root.join("existing.txt")).unwrap(),
            "unrelated user edit\n"
        );
        assert_eq!(git(&["diff", "--cached", "--name-only"]), "staged.txt");

        // Re-create untracked "all", accept only "all"
        fs::write(root.join("all"), "v1 all\n").unwrap();
        let acc_untracked =
            WorkspaceState::accept_git_change(&root, "all", Some("Add literal all"));
        assert_eq!(acc_untracked["status"], "ok");
        assert_eq!(
            git(&["show", "--pretty=format:", "--name-only", "HEAD"]),
            "all"
        );
        assert_eq!(
            fs::read_to_string(root.join("existing.txt")).unwrap(),
            "unrelated user edit\n"
        );
        assert_eq!(git(&["diff", "--cached", "--name-only"]), "staged.txt");

        // Modify tracked "all", reject only "all" -> restores "all" while keeping unrelated edits
        fs::write(root.join("all"), "v2 all\n").unwrap();
        let rej_tracked = WorkspaceState::reject_git_change(&root, "all", false);
        assert_eq!(rej_tracked["status"], "ok");
        assert_eq!(fs::read_to_string(root.join("all")).unwrap(), "v1 all\n");
        assert_eq!(
            fs::read_to_string(root.join("existing.txt")).unwrap(),
            "unrelated user edit\n"
        );
        assert_eq!(git(&["diff", "--cached", "--name-only"]), "staged.txt");

        // Modify tracked "all" again, accept only "all" -> commits only "all"
        fs::write(root.join("all"), "v3 all\n").unwrap();
        let acc_tracked =
            WorkspaceState::accept_git_change(&root, "all", Some("Update literal all"));
        assert_eq!(acc_tracked["status"], "ok");
        assert_eq!(
            git(&["show", "--pretty=format:", "--name-only", "HEAD"]),
            "all"
        );
        assert_eq!(
            fs::read_to_string(root.join("existing.txt")).unwrap(),
            "unrelated user edit\n"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_alias_prefers_home_desktop_and_falls_back_to_onedrive() {
        let base = std::env::temp_dir().join(format!("ag-od-desktop-{}", uuid::Uuid::new_v4()));
        let home = base.join("home");
        let onedrive = base.join("OneDrive");
        let od_desktop = onedrive.join("Desktop");
        let workspace = home.join("Projects").join("app");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&od_desktop).unwrap();

        // When home/Desktop does not exist, falls back to OneDrive/Desktop
        let ws_fallback =
            WorkspaceState::new_with_paths(workspace.clone(), home.clone(), Some(onedrive.clone()));
        let res_fallback = ws_fallback.browse_directory(Some("desktop"));
        assert_eq!(res_fallback["status"], "ok");
        assert_eq!(
            PathBuf::from(res_fallback["current_path"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            od_desktop.canonicalize().unwrap()
        );

        // When home/Desktop exists, home/Desktop stays primary
        let home_desktop = home.join("Desktop");
        fs::create_dir_all(&home_desktop).unwrap();
        let ws_primary = WorkspaceState::new_with_paths(workspace, home, Some(onedrive));
        let res_primary = ws_primary.browse_directory(Some("desktop"));
        assert_eq!(res_primary["status"], "ok");
        assert_eq!(
            PathBuf::from(res_primary["current_path"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            home_desktop.canonicalize().unwrap()
        );

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn index_only_accept_explains_no_worktree_change_and_preserves_staged_data() {
        let root = std::env::temp_dir().join(format!("ag-index-only-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init"]);
        git(&["config", "user.name", "Review"]);
        git(&["config", "user.email", "review@example.invalid"]);
        git(&["config", "core.autocrlf", "false"]);
        fs::write(root.join("selected.txt"), "original\n").unwrap();
        fs::write(root.join("other.txt"), "original\n").unwrap();
        git(&["add", "--", "."]);
        git(&["commit", "-m", "Baseline"]);
        let head = git(&["rev-parse", "HEAD"]);
        fs::write(root.join("selected.txt"), "staged selection\n").unwrap();
        fs::write(root.join("other.txt"), "unrelated staged edit\n").unwrap();
        git(&["add", "--", "."]);
        fs::write(root.join("selected.txt"), "original\n").unwrap();
        let index = git(&["write-tree"]);

        let result = WorkspaceState::accept_git_change(&root, "selected.txt", None);
        let head_after = git(&["rev-parse", "HEAD"]);
        let index_after = git(&["write-tree"]);
        let staged_after = git(&["show", ":selected.txt"]);
        let working_after = fs::read_to_string(root.join("selected.txt")).unwrap();
        assert!(root
            .canonicalize()
            .unwrap()
            .starts_with(std::env::temp_dir().canonicalize().unwrap()));
        fs::remove_dir_all(root).unwrap();

        assert_eq!(result["status"], "error");
        assert_eq!(result["code"], "no_worktree_changes");
        assert!(result["message"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("staged"));
        assert_eq!(head, head_after);
        assert_eq!(index, index_after);
        assert_eq!(staged_after, "staged selection");
        assert_eq!(working_after, "original\n");
    }

    #[test]
    fn accepting_first_staged_file_preserves_other_staged_files() {
        let root = std::env::temp_dir().join(format!("ag-first-commit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init"]);
        git(&["config", "user.name", "Review"]);
        git(&["config", "user.email", "review@example.invalid"]);
        fs::write(root.join("selected.txt"), "first commit\n").unwrap();
        fs::write(root.join("other.txt"), "keep staged\n").unwrap();
        git(&["add", "--", "."]);
        let result = WorkspaceState::accept_git_change(&root, "selected.txt", None);
        let committed = git(&["ls-tree", "-r", "--name-only", "HEAD"]);
        let staged = git(&["diff", "--cached", "--name-only"]);
        assert!(root
            .canonicalize()
            .unwrap()
            .starts_with(std::env::temp_dir().canonicalize().unwrap()));
        fs::remove_dir_all(root).unwrap();
        assert_eq!(result["status"], "ok");
        assert_eq!(committed, "selected.txt");
        assert_eq!(staged, "other.txt");
    }
}
