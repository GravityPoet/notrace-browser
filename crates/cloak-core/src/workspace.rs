use super::{
    command_line_mentions_user_data_dir, current_epoch_secs, hex_digest, profile_metadata,
    running_process_command_lines, secure_dir, secure_file, user_data_dir_needle,
    validate_account_name, CloakConfig, CloakError, Result,
};
use aes_gcm::aead::{array::Array, Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use rand::RngCore;
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use walkdir::WalkDir;
use zeroize::Zeroizing;

const ARCHIVE_MAGIC: &[u8; 8] = b"NTRACEW1";
const ARCHIVE_VERSION: u16 = 1;
const MANIFEST_VERSION: u32 = 1;
const SCRYPT_LOG_N: u8 = 15;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_PREFIX_LEN: usize = 8;
const FRAME_PLAINTEXT_BYTES: usize = 1024 * 1024;
const GCM_TAG_BYTES: usize = 16;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ACCOUNTS: usize = 2_000;
const MAX_ENTRIES: usize = 500_000;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES: usize = 1024;
const MAX_ARCHIVE_PATH_COMPONENTS: usize = 64;
const PICKER_STATE_VERSION: u32 = 1;
const MAX_PICKER_STATE_ITEMS: usize = 10_000;
const MAX_PICKER_STATE_VALUE_BYTES: usize = 1_024;
const MIN_PASSPHRASE_CHARS: usize = 12;
const MAX_PASSPHRASE_CHARS: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceExportSummary {
    pub path: PathBuf,
    pub account_count: usize,
    pub file_count: usize,
    pub total_bytes: u64,
    pub archive_sha256: String,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceImportAccount {
    pub source_name: String,
    pub suggested_name: String,
    pub name_conflict: bool,
    pub profile_id: String,
    pub profile_id_conflict: bool,
    pub source_serial: u64,
    pub target_serial: u64,
    pub serial_conflict: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceImportPreview {
    pub created_at: u64,
    pub account_count: usize,
    pub file_count: usize,
    pub total_bytes: u64,
    pub manifest_sha256: String,
    pub includes_picker_state: bool,
    pub accounts: Vec<WorkspaceImportAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspacePickerState {
    pub schema_version: u32,
    pub group_order: Vec<String>,
    pub account_order: Vec<String>,
    pub collapsed_groups: Vec<String>,
    pub hidden_groups: Vec<String>,
    pub sidebar_width: u16,
    pub mark_presets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceImportMapping {
    pub source_name: String,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceImportSummary {
    pub imported_accounts: Vec<String>,
    pub total_bytes: u64,
    pub remapped_serials: usize,
    pub picker_state: Option<WorkspacePickerState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceManifest {
    format_version: u32,
    created_at: u64,
    accounts: Vec<ArchiveAccount>,
    entries: Vec<ArchiveEntry>,
    total_file_bytes: u64,
    #[serde(default)]
    picker_state: Option<WorkspacePickerState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArchiveAccount {
    name: String,
    profile_id: String,
    serial: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ArchiveEntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArchiveEntry {
    path: String,
    kind: ArchiveEntryKind,
    size: u64,
    sha256: String,
}

pub fn export_workspace(
    config: &CloakConfig,
    destination: &Path,
    passphrase: &str,
) -> Result<WorkspaceExportSummary> {
    export_workspace_with_picker_state_and_cancellation(config, destination, passphrase, None, None)
}

pub fn export_workspace_with_picker_state(
    config: &CloakConfig,
    destination: &Path,
    passphrase: &str,
    picker_state: Option<WorkspacePickerState>,
) -> Result<WorkspaceExportSummary> {
    export_workspace_with_picker_state_and_cancellation(
        config,
        destination,
        passphrase,
        picker_state,
        None,
    )
}

pub fn export_workspace_with_picker_state_and_cancellation(
    config: &CloakConfig,
    destination: &Path,
    passphrase: &str,
    picker_state: Option<WorkspacePickerState>,
    cancellation: Option<&AtomicBool>,
) -> Result<WorkspaceExportSummary> {
    ensure_not_cancelled(cancellation)?;
    validate_passphrase(passphrase)?;
    reject_archive_inside_workspace(config, destination)?;
    profile_metadata::ensure_workspace_profile_metadata(config)?;
    let manifest = inventory_workspace(config, picker_state, cancellation)?;
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(invalid_archive("manifest exceeds the 64 MiB limit"));
    }
    let manifest_sha256 = hex_digest(&Sha256::digest(&manifest_bytes));

    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    ensure_capacity(parent, manifest.total_file_bytes)?;
    let temporary = temporary_sibling(destination, "export");
    let result = export_to_temporary(
        config,
        &temporary,
        passphrase,
        &manifest,
        &manifest_bytes,
        cancellation,
    );
    if let Err(err) = result {
        let _ = fs::remove_file(&temporary);
        return Err(err);
    }
    let mut cleanup = FileCleanup::new(temporary.clone());
    let archive_sha256 = hash_file_with_cancellation(&temporary, cancellation)?;
    ensure_not_cancelled(cancellation)?;
    fs::rename(&temporary, destination)?;
    cleanup.disarm();
    secure_file(destination)?;

    Ok(WorkspaceExportSummary {
        path: destination.to_path_buf(),
        account_count: manifest.accounts.len(),
        file_count: manifest
            .entries
            .iter()
            .filter(|entry| entry.kind == ArchiveEntryKind::File)
            .count(),
        total_bytes: manifest.total_file_bytes,
        archive_sha256,
        manifest_sha256,
    })
}

pub fn preview_workspace_import(
    config: &CloakConfig,
    archive: &Path,
    passphrase: &str,
) -> Result<WorkspaceImportPreview> {
    preview_workspace_import_with_cancellation(config, archive, passphrase, None)
}

pub fn preview_workspace_import_with_cancellation(
    config: &CloakConfig,
    archive: &Path,
    passphrase: &str,
    cancellation: Option<&AtomicBool>,
) -> Result<WorkspaceImportPreview> {
    ensure_not_cancelled(cancellation)?;
    validate_passphrase(passphrase)?;
    let mut sink = VerifySink;
    let (manifest, manifest_sha256) =
        consume_archive(archive, passphrase, &mut sink, cancellation)?;
    build_import_preview(config, &manifest, manifest_sha256)
}

pub fn import_workspace(
    config: &CloakConfig,
    archive: &Path,
    passphrase: &str,
    mappings: &[WorkspaceImportMapping],
) -> Result<WorkspaceImportSummary> {
    import_workspace_with_cancellation(config, archive, passphrase, mappings, None)
}

pub fn import_workspace_with_cancellation(
    config: &CloakConfig,
    archive: &Path,
    passphrase: &str,
    mappings: &[WorkspaceImportMapping],
    cancellation: Option<&AtomicBool>,
) -> Result<WorkspaceImportSummary> {
    ensure_not_cancelled(cancellation)?;
    validate_passphrase(passphrase)?;
    let preview =
        preview_workspace_import_with_cancellation(config, archive, passphrase, cancellation)?;
    if let Some(account) = preview
        .accounts
        .iter()
        .find(|account| account.profile_id_conflict)
    {
        return Err(CloakError::WorkspaceConflict(format!(
            "profile {} already exists locally",
            account.source_name
        )));
    }

    fs::create_dir_all(&config.account_base)?;
    secure_dir(&config.account_base)?;
    ensure_capacity(&config.account_base, preview.total_bytes)?;
    let parent = config
        .account_base
        .parent()
        .unwrap_or(&config.account_base)
        .to_path_buf();
    let staging = unique_staging_path(&parent);
    fs::create_dir(&staging)?;
    secure_dir(&staging)?;
    let mut cleanup = DirectoryCleanup::new(staging.clone());
    let mut sink = ExtractSink::new(staging.clone());
    let (manifest, _) = consume_archive(archive, passphrase, &mut sink, cancellation)?;
    secure_dir_recursive_cancellable(&staging, cancellation)?;
    ensure_not_cancelled(cancellation)?;

    let mapping_by_source = mappings
        .iter()
        .map(|mapping| (mapping.source_name.as_str(), mapping.target_name.as_str()))
        .collect::<HashMap<_, _>>();
    if mapping_by_source.len() != mappings.len() {
        return Err(CloakError::WorkspaceConflict(
            "duplicate source names in import mapping".to_string(),
        ));
    }
    if mapping_by_source.keys().any(|source| {
        !preview
            .accounts
            .iter()
            .any(|account| account.source_name == **source)
    }) {
        return Err(CloakError::WorkspaceConflict(
            "import mapping contains an unknown source profile".to_string(),
        ));
    }

    let preview_by_source = preview
        .accounts
        .iter()
        .map(|account| (account.source_name.as_str(), account))
        .collect::<HashMap<_, _>>();
    let mut targets = Vec::new();
    let mut target_names = HashSet::new();
    for account in &manifest.accounts {
        let preview_account = preview_by_source
            .get(account.name.as_str())
            .ok_or_else(|| invalid_archive("preview and manifest account sets differ"))?;
        let target_name = mapping_by_source
            .get(account.name.as_str())
            .copied()
            .unwrap_or(preview_account.suggested_name.as_str())
            .trim()
            .to_string();
        validate_account_name(&target_name)?;
        if !target_names.insert(target_name.clone()) {
            return Err(CloakError::WorkspaceConflict(format!(
                "multiple imported profiles target {target_name}"
            )));
        }
        let destination = config.profile_dir(&target_name);
        if destination.exists() {
            return Err(CloakError::WorkspaceConflict(format!(
                "target account already exists: {target_name}"
            )));
        }
        let staged_profile = staging.join(&account.name);
        let mut metadata = profile_metadata::require_profile_owner(&staged_profile)?;
        if metadata.profile_id != account.profile_id || metadata.serial != account.serial {
            return Err(invalid_archive(format!(
                "owner metadata does not match manifest for {}",
                account.name
            )));
        }
        metadata.serial = preview_account.target_serial;
        profile_metadata::replace_profile_metadata_all(&staged_profile, &metadata)?;
        targets.push((
            account.name.clone(),
            target_name,
            staged_profile,
            destination,
            preview_account.serial_conflict,
        ));
    }

    ensure_not_cancelled(cancellation)?;
    let mut moved = Vec::<(PathBuf, PathBuf)>::new();
    for (_, _, staged_profile, destination, _) in &targets {
        if let Err(err) = fs::rename(staged_profile, destination) {
            let mut rollback_error = None;
            for (committed, original) in moved.iter().rev() {
                if let Err(rollback) = fs::rename(committed, original) {
                    rollback_error = Some(rollback);
                }
            }
            if rollback_error.is_some() {
                cleanup.disarm();
            }
            return Err(CloakError::Io(io::Error::other(match rollback_error {
                Some(rollback) => {
                    format!("workspace commit failed: {err}; rollback also failed: {rollback}")
                }
                None => format!("workspace commit failed and was rolled back: {err}"),
            })));
        }
        moved.push((destination.clone(), staged_profile.clone()));
    }
    if fs::remove_dir_all(&staging).is_ok() {
        cleanup.disarm();
    }

    Ok(WorkspaceImportSummary {
        imported_accounts: targets
            .iter()
            .map(|(_, target, _, _, _)| target.clone())
            .collect(),
        total_bytes: manifest.total_file_bytes,
        remapped_serials: targets
            .iter()
            .filter(|(_, _, _, _, remapped)| *remapped)
            .count(),
        picker_state: manifest
            .picker_state
            .as_ref()
            .map(|state| map_picker_state_accounts(state, &targets)),
    })
}

pub(crate) fn validate_workspace_archive_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_ARCHIVE_PATH_BYTES
        || value.contains('\0')
        || value.contains('\\')
        || value.contains("//")
    {
        return Err(invalid_archive(format!("unsafe archive path: {value:?}")));
    }
    let path = Path::new(value);
    let mut components = 0;
    for component in path.components() {
        components += 1;
        match component {
            Component::Normal(value)
                if !value.is_empty()
                    && value.to_string_lossy().len() <= 255
                    && value != "."
                    && value != ".." => {}
            _ => return Err(invalid_archive(format!("unsafe archive path: {value:?}"))),
        }
    }
    if !(2..=MAX_ARCHIVE_PATH_COMPONENTS).contains(&components) {
        return Err(invalid_archive(format!("unsafe archive path: {value:?}")));
    }
    Ok(())
}

fn inventory_workspace(
    config: &CloakConfig,
    picker_state: Option<WorkspacePickerState>,
    cancellation: Option<&AtomicBool>,
) -> Result<WorkspaceManifest> {
    ensure_not_cancelled(cancellation)?;
    let mut accounts = Vec::new();
    let mut entries = Vec::new();
    let mut total_file_bytes = 0u64;
    let mut account_dirs = fs::read_dir(&config.account_base)?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            (name != "main" && !name.starts_with('.') && validate_account_name(&name).is_ok())
                .then_some((name, entry.path()))
        })
        .collect::<Vec<_>>();
    account_dirs.sort_by(|a, b| a.0.cmp(&b.0));
    if account_dirs.len() > MAX_ACCOUNTS {
        return Err(invalid_archive("workspace exceeds the profile-count limit"));
    }
    let running_processes = running_process_command_lines()?;

    for (name, profile_path) in account_dirs {
        ensure_not_cancelled(cancellation)?;
        let running_needle = user_data_dir_needle(&profile_path);
        if running_processes
            .lines()
            .any(|command| command_line_mentions_user_data_dir(command, &running_needle))
        {
            return Err(CloakError::WorkspaceConflict(format!(
                "close the running profile before backup: {name}"
            )));
        }
        let metadata = profile_metadata::require_profile_owner(&profile_path)?;
        accounts.push(ArchiveAccount {
            name: name.clone(),
            profile_id: metadata.profile_id,
            serial: metadata.serial,
        });

        let walker = WalkDir::new(&profile_path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry
                    .path()
                    .strip_prefix(&profile_path)
                    .ok()
                    .map(|relative| !should_skip_archive_path(relative))
                    .unwrap_or(true)
            });
        for entry in walker {
            ensure_not_cancelled(cancellation)?;
            let entry = entry.map_err(io::Error::other)?;
            let relative = entry
                .path()
                .strip_prefix(&profile_path)
                .map_err(io::Error::other)?;
            if relative.as_os_str().is_empty() || should_skip_archive_path(relative) {
                continue;
            }
            if entry.file_type().is_symlink() {
                return Err(invalid_archive(format!(
                    "symbolic links are not portable: {}",
                    entry.path().display()
                )));
            }
            let path = archive_path(&name, relative)?;
            validate_workspace_archive_path(&path)?;
            let (kind, size, sha256) = if entry.file_type().is_dir() {
                (ArchiveEntryKind::Directory, 0, String::new())
            } else if entry.file_type().is_file() {
                let size = entry.metadata().map_err(io::Error::other)?.len();
                if size > MAX_FILE_BYTES {
                    return Err(invalid_archive(format!("file exceeds limit: {path}")));
                }
                total_file_bytes = total_file_bytes
                    .checked_add(size)
                    .ok_or_else(|| invalid_archive("workspace size overflow"))?;
                if total_file_bytes > MAX_TOTAL_BYTES {
                    return Err(invalid_archive("workspace exceeds the 1 TiB limit"));
                }
                (
                    ArchiveEntryKind::File,
                    size,
                    hash_file_with_cancellation(entry.path(), cancellation)?,
                )
            } else {
                return Err(invalid_archive(format!(
                    "unsupported filesystem entry: {}",
                    entry.path().display()
                )));
            };
            entries.push(ArchiveEntry {
                path,
                kind,
                size,
                sha256,
            });
            if entries.len() > MAX_ENTRIES {
                return Err(invalid_archive("workspace exceeds the entry-count limit"));
            }
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    let picker_state = picker_state
        .map(|mut state| {
            validate_picker_state(&state)?;
            let account_names = accounts
                .iter()
                .map(|account| account.name.as_str())
                .collect::<HashSet<_>>();
            state
                .account_order
                .retain(|name| account_names.contains(name.as_str()));
            Ok::<WorkspacePickerState, CloakError>(state)
        })
        .transpose()?;

    Ok(WorkspaceManifest {
        format_version: MANIFEST_VERSION,
        created_at: current_epoch_secs(),
        accounts,
        entries,
        total_file_bytes,
        picker_state,
    })
}

fn export_to_temporary(
    config: &CloakConfig,
    temporary: &Path,
    passphrase: &str,
    manifest: &WorkspaceManifest,
    manifest_bytes: &[u8],
    cancellation: Option<&AtomicBool>,
) -> Result<()> {
    ensure_not_cancelled(cancellation)?;
    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(temporary)?;
    secure_file(temporary)?;
    let mut writer = EncryptedWriter::new(file, passphrase)?;
    writer.write_plain(&(manifest_bytes.len() as u64).to_le_bytes())?;
    writer.write_plain(manifest_bytes)?;
    let mut buffer = vec![0u8; FRAME_PLAINTEXT_BYTES];
    for entry in &manifest.entries {
        ensure_not_cancelled(cancellation)?;
        if entry.kind != ArchiveEntryKind::File {
            continue;
        }
        let source = config.account_base.join(Path::new(&entry.path));
        let metadata = fs::symlink_metadata(&source)?;
        if !metadata.file_type().is_file() || metadata.len() != entry.size {
            return Err(CloakError::WorkspaceConflict(format!(
                "file changed during backup: {}",
                entry.path
            )));
        }
        let mut file = File::open(&source)?;
        let mut remaining = entry.size;
        let mut hasher = Sha256::new();
        while remaining > 0 {
            ensure_not_cancelled(cancellation)?;
            let take = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
            file.read_exact(&mut buffer[..take])?;
            hasher.update(&buffer[..take]);
            writer.write_plain(&buffer[..take])?;
            remaining -= take as u64;
        }
        if hex_digest(&hasher.finalize()) != entry.sha256 {
            return Err(CloakError::WorkspaceConflict(format!(
                "file changed during backup: {}",
                entry.path
            )));
        }
    }
    let file = writer.finish()?;
    file.sync_all()?;
    Ok(())
}

fn build_import_preview(
    config: &CloakConfig,
    manifest: &WorkspaceManifest,
    manifest_sha256: String,
) -> Result<WorkspaceImportPreview> {
    let local = local_profile_index(config)?;
    let mut used_names = local.names.clone();
    let mut used_serials = local.serials.clone();
    let mut next_serial = used_serials
        .iter()
        .copied()
        .max()
        .unwrap_or(0)
        .saturating_add(1);
    let mut accounts = Vec::with_capacity(manifest.accounts.len());
    for account in &manifest.accounts {
        let profile_id_conflict = local.profile_ids.contains(&account.profile_id);
        let name_conflict = used_names.contains(&account.name);
        let suggested_name = if name_conflict {
            unique_import_name(&account.name, &used_names)?
        } else {
            account.name.clone()
        };
        used_names.insert(suggested_name.clone());
        let serial_conflict = used_serials.contains(&account.serial);
        let target_serial = if serial_conflict {
            while used_serials.contains(&next_serial) {
                next_serial = next_serial.saturating_add(1);
            }
            let serial = next_serial;
            next_serial = next_serial.saturating_add(1);
            serial
        } else {
            account.serial
        };
        used_serials.insert(target_serial);
        accounts.push(WorkspaceImportAccount {
            source_name: account.name.clone(),
            suggested_name,
            name_conflict,
            profile_id: account.profile_id.clone(),
            profile_id_conflict,
            source_serial: account.serial,
            target_serial,
            serial_conflict,
        });
    }
    Ok(WorkspaceImportPreview {
        created_at: manifest.created_at,
        account_count: manifest.accounts.len(),
        file_count: manifest
            .entries
            .iter()
            .filter(|entry| entry.kind == ArchiveEntryKind::File)
            .count(),
        total_bytes: manifest.total_file_bytes,
        manifest_sha256,
        includes_picker_state: manifest.picker_state.is_some(),
        accounts,
    })
}

fn map_picker_state_accounts(
    state: &WorkspacePickerState,
    targets: &[(String, String, PathBuf, PathBuf, bool)],
) -> WorkspacePickerState {
    let name_map = targets
        .iter()
        .map(|(source, target, _, _, _)| (source.as_str(), target.as_str()))
        .collect::<HashMap<_, _>>();
    let mut mapped = state.clone();
    let mut seen = HashSet::new();
    mapped.account_order = state
        .account_order
        .iter()
        .filter_map(|name| name_map.get(name.as_str()).copied())
        .filter(|name| seen.insert((*name).to_string()))
        .map(str::to_string)
        .collect();
    mapped
}

#[derive(Default)]
struct LocalProfileIndex {
    names: HashSet<String>,
    profile_ids: HashSet<String>,
    serials: HashSet<u64>,
}

fn local_profile_index(config: &CloakConfig) -> Result<LocalProfileIndex> {
    if !config.account_base.is_dir() {
        return Ok(LocalProfileIndex::default());
    }
    profile_metadata::ensure_workspace_profile_metadata(config)?;
    let mut index = LocalProfileIndex::default();
    for entry in fs::read_dir(&config.account_base)? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if validate_account_name(&name).is_err() {
            continue;
        }
        if let Ok(metadata) = profile_metadata::require_profile_owner(&entry.path()) {
            index.names.insert(name);
            index.profile_ids.insert(metadata.profile_id);
            index.serials.insert(metadata.serial);
        }
    }
    Ok(index)
}

fn unique_import_name(source: &str, used: &HashSet<String>) -> Result<String> {
    for suffix in std::iter::once("-imported".to_string())
        .chain((2u64..10_000).map(|index| format!("-imported-{index}")))
    {
        let candidate = format!("{source}{suffix}");
        if validate_account_name(&candidate).is_ok() && !used.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(CloakError::WorkspaceConflict(format!(
        "unable to allocate an import name for {source}"
    )))
}

trait ArchiveSink {
    fn begin(&mut self, manifest: &WorkspaceManifest) -> Result<()>;
    fn directory(&mut self, entry: &ArchiveEntry) -> Result<()>;
    fn begin_file(&mut self, entry: &ArchiveEntry) -> Result<()>;
    fn file_chunk(&mut self, entry: &ArchiveEntry, chunk: &[u8]) -> Result<()>;
    fn end_file(&mut self, entry: &ArchiveEntry) -> Result<()>;
}

struct VerifySink;

impl ArchiveSink for VerifySink {
    fn begin(&mut self, _: &WorkspaceManifest) -> Result<()> {
        Ok(())
    }
    fn directory(&mut self, _: &ArchiveEntry) -> Result<()> {
        Ok(())
    }
    fn begin_file(&mut self, _: &ArchiveEntry) -> Result<()> {
        Ok(())
    }
    fn file_chunk(&mut self, _: &ArchiveEntry, _: &[u8]) -> Result<()> {
        Ok(())
    }
    fn end_file(&mut self, _: &ArchiveEntry) -> Result<()> {
        Ok(())
    }
}

struct ExtractSink {
    root: PathBuf,
    current_file: Option<File>,
}

impl ExtractSink {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            current_file: None,
        }
    }

    fn target(&self, path: &str) -> Result<PathBuf> {
        validate_workspace_archive_path(path)?;
        Ok(self.root.join(Path::new(path)))
    }
}

impl ArchiveSink for ExtractSink {
    fn begin(&mut self, manifest: &WorkspaceManifest) -> Result<()> {
        for account in &manifest.accounts {
            let path = self.root.join(&account.name);
            fs::create_dir(&path)?;
            secure_dir(&path)?;
        }
        Ok(())
    }

    fn directory(&mut self, entry: &ArchiveEntry) -> Result<()> {
        let target = self.target(&entry.path)?;
        fs::create_dir_all(&target)?;
        secure_dir(&target)
    }

    fn begin_file(&mut self, entry: &ArchiveEntry) -> Result<()> {
        let target = self.target(&entry.path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
            secure_dir(parent)?;
        }
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)?;
        secure_file(&target)?;
        self.current_file = Some(file);
        Ok(())
    }

    fn file_chunk(&mut self, _: &ArchiveEntry, chunk: &[u8]) -> Result<()> {
        self.current_file
            .as_mut()
            .ok_or_else(|| invalid_archive("file payload started without an entry"))?
            .write_all(chunk)?;
        Ok(())
    }

    fn end_file(&mut self, _: &ArchiveEntry) -> Result<()> {
        let file = self
            .current_file
            .take()
            .ok_or_else(|| invalid_archive("file payload ended without an entry"))?;
        file.sync_all()?;
        Ok(())
    }
}

fn consume_archive<S: ArchiveSink>(
    archive: &Path,
    passphrase: &str,
    sink: &mut S,
    cancellation: Option<&AtomicBool>,
) -> Result<(WorkspaceManifest, String)> {
    ensure_not_cancelled(cancellation)?;
    let file = File::open(archive)?;
    let mut reader = EncryptedReader::new(file, passphrase)?;
    let mut manifest_length = [0u8; 8];
    reader.read_plain_exact(&mut manifest_length)?;
    let manifest_length = u64::from_le_bytes(manifest_length);
    if manifest_length == 0 || manifest_length > MAX_MANIFEST_BYTES {
        return Err(invalid_archive(
            "manifest length is outside the allowed range",
        ));
    }
    let mut manifest_bytes = vec![0u8; manifest_length as usize];
    reader.read_plain_exact(&mut manifest_bytes)?;
    ensure_not_cancelled(cancellation)?;
    let manifest = serde_json::from_slice::<WorkspaceManifest>(&manifest_bytes)
        .map_err(|_| invalid_archive("wrong passphrase or damaged manifest"))?;
    validate_manifest(&manifest)?;
    sink.begin(&manifest)?;

    let mut buffer = vec![0u8; FRAME_PLAINTEXT_BYTES];
    for entry in &manifest.entries {
        ensure_not_cancelled(cancellation)?;
        match entry.kind {
            ArchiveEntryKind::Directory => sink.directory(entry)?,
            ArchiveEntryKind::File => {
                sink.begin_file(entry)?;
                let mut remaining = entry.size;
                let mut hasher = Sha256::new();
                while remaining > 0 {
                    ensure_not_cancelled(cancellation)?;
                    let take =
                        usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
                    reader.read_plain_exact(&mut buffer[..take])?;
                    hasher.update(&buffer[..take]);
                    sink.file_chunk(entry, &buffer[..take])?;
                    remaining -= take as u64;
                }
                if hex_digest(&hasher.finalize()) != entry.sha256 {
                    return Err(invalid_archive(format!(
                        "checksum mismatch for {}",
                        entry.path
                    )));
                }
                sink.end_file(entry)?;
            }
        }
    }
    reader.finish()?;
    let manifest_sha256 = hex_digest(&Sha256::digest(&manifest_bytes));
    Ok((manifest, manifest_sha256))
}

fn validate_manifest(manifest: &WorkspaceManifest) -> Result<()> {
    if manifest.format_version != MANIFEST_VERSION {
        return Err(invalid_archive("unsupported manifest version"));
    }
    if manifest.accounts.is_empty() || manifest.accounts.len() > MAX_ACCOUNTS {
        return Err(invalid_archive(
            "profile count is outside the allowed range",
        ));
    }
    if manifest.entries.len() > MAX_ENTRIES || manifest.total_file_bytes > MAX_TOTAL_BYTES {
        return Err(invalid_archive("archive exceeds capacity limits"));
    }
    if let Some(state) = manifest.picker_state.as_ref() {
        validate_picker_state(state)?;
    }
    let mut account_names = HashSet::new();
    let mut profile_ids = HashSet::new();
    let mut serials = HashSet::new();
    for account in &manifest.accounts {
        validate_account_name(&account.name)?;
        if !profile_metadata::valid_profile_id(&account.profile_id)
            || account.serial == 0
            || !account_names.insert(account.name.clone())
            || !profile_ids.insert(account.profile_id.clone())
            || !serials.insert(account.serial)
        {
            return Err(invalid_archive("duplicate or invalid account metadata"));
        }
    }

    let mut seen_paths = HashSet::new();
    let mut total = 0u64;
    let mut owner_files = HashSet::new();
    for entry in &manifest.entries {
        validate_workspace_archive_path(&entry.path)?;
        if !seen_paths.insert(entry.path.clone()) {
            return Err(invalid_archive(format!("duplicate path: {}", entry.path)));
        }
        let first = entry
            .path
            .split('/')
            .next()
            .ok_or_else(|| invalid_archive("entry without an account prefix"))?;
        if !account_names.contains(first) {
            return Err(invalid_archive(format!(
                "entry does not belong to a manifest account: {}",
                entry.path
            )));
        }
        match entry.kind {
            ArchiveEntryKind::Directory => {
                if entry.size != 0 || !entry.sha256.is_empty() {
                    return Err(invalid_archive("directory entry carries file data"));
                }
            }
            ArchiveEntryKind::File => {
                if entry.size > MAX_FILE_BYTES
                    || entry.sha256.len() != 64
                    || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(invalid_archive(format!(
                        "invalid file metadata: {}",
                        entry.path
                    )));
                }
                total = total
                    .checked_add(entry.size)
                    .ok_or_else(|| invalid_archive("archive size overflow"))?;
                for owner_file in [
                    profile_metadata::PROFILE_METADATA_NAME,
                    profile_metadata::PROFILE_METADATA_BACKUP_1,
                    profile_metadata::PROFILE_METADATA_BACKUP_2,
                ] {
                    if entry.path == format!("{first}/{owner_file}") {
                        owner_files.insert((first.to_string(), owner_file));
                    }
                }
            }
        }
    }
    if total != manifest.total_file_bytes
        || owner_files.len() != manifest.accounts.len().saturating_mul(3)
    {
        return Err(invalid_archive(
            "manifest totals or profile owner markers are incomplete",
        ));
    }
    Ok(())
}

fn validate_picker_state(state: &WorkspacePickerState) -> Result<()> {
    if state.schema_version != PICKER_STATE_VERSION || !(200..=2_000).contains(&state.sidebar_width)
    {
        return Err(invalid_archive("Picker workspace state is invalid"));
    }
    for values in [
        &state.group_order,
        &state.account_order,
        &state.collapsed_groups,
        &state.hidden_groups,
        &state.mark_presets,
    ] {
        if values.len() > MAX_PICKER_STATE_ITEMS {
            return Err(invalid_archive(
                "Picker workspace state exceeds its item limit",
            ));
        }
        if values.iter().any(|value| {
            value.is_empty()
                || value.len() > MAX_PICKER_STATE_VALUE_BYTES
                || value.chars().any(|character| character.is_control())
        }) {
            return Err(invalid_archive(
                "Picker workspace state contains an invalid value",
            ));
        }
    }
    if state.mark_presets.len() > 100
        || state
            .mark_presets
            .iter()
            .any(|value| value.chars().count() > 24)
    {
        return Err(invalid_archive("Picker mark presets exceed their limit"));
    }
    Ok(())
}

struct EncryptedWriter {
    file: File,
    cipher: Aes256Gcm,
    header: Vec<u8>,
    nonce_prefix: [u8; NONCE_PREFIX_LEN],
    counter: u32,
    buffer: Vec<u8>,
}

impl EncryptedWriter {
    fn new(mut file: File, passphrase: &str) -> Result<Self> {
        let mut salt = [0u8; SALT_LEN];
        let mut nonce_prefix = [0u8; NONCE_PREFIX_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        rand::rngs::OsRng.fill_bytes(&mut nonce_prefix);
        let header = archive_header(&salt, &nonce_prefix);
        file.write_all(&header)?;
        let key = derive_key(passphrase, &salt)?;
        let cipher = Aes256Gcm::new(&Array(*key));
        Ok(Self {
            file,
            cipher,
            header,
            nonce_prefix,
            counter: 0,
            buffer: Vec::with_capacity(FRAME_PLAINTEXT_BYTES),
        })
    }

    fn write_plain(&mut self, mut value: &[u8]) -> Result<()> {
        while !value.is_empty() {
            let remaining = FRAME_PLAINTEXT_BYTES - self.buffer.len();
            let take = remaining.min(value.len());
            self.buffer.extend_from_slice(&value[..take]);
            value = &value[take..];
            if self.buffer.len() == FRAME_PLAINTEXT_BYTES {
                self.flush_frame(false)?;
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<File> {
        self.flush_frame(true)?;
        self.file.flush()?;
        Ok(self.file)
    }

    fn flush_frame(&mut self, final_frame: bool) -> Result<()> {
        let flag = u8::from(final_frame);
        let nonce = frame_nonce(&self.nonce_prefix, self.counter);
        let aad = frame_aad(&self.header, self.counter, flag);
        let ciphertext = self
            .cipher
            .encrypt(
                &Array(nonce),
                Payload {
                    msg: &self.buffer,
                    aad: &aad,
                },
            )
            .map_err(|_| invalid_archive("unable to encrypt workspace frame"))?;
        let length = u32::try_from(ciphertext.len())
            .map_err(|_| invalid_archive("encrypted frame is too large"))?;
        self.file.write_all(&[flag])?;
        self.file.write_all(&length.to_le_bytes())?;
        self.file.write_all(&ciphertext)?;
        self.buffer.clear();
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| invalid_archive("workspace frame counter exhausted"))?;
        Ok(())
    }
}

struct EncryptedReader {
    file: File,
    cipher: Aes256Gcm,
    header: Vec<u8>,
    nonce_prefix: [u8; NONCE_PREFIX_LEN],
    counter: u32,
    plaintext: Vec<u8>,
    offset: usize,
    final_seen: bool,
}

impl EncryptedReader {
    fn new(mut file: File, passphrase: &str) -> Result<Self> {
        let mut header = vec![0u8; archive_header_length()];
        file.read_exact(&mut header)
            .map_err(|_| invalid_archive("archive header is truncated"))?;
        let (salt, nonce_prefix) = parse_archive_header(&header)?;
        let key = derive_key(passphrase, &salt)?;
        let cipher = Aes256Gcm::new(&Array(*key));
        Ok(Self {
            file,
            cipher,
            header,
            nonce_prefix,
            counter: 0,
            plaintext: Vec::new(),
            offset: 0,
            final_seen: false,
        })
    }

    fn read_plain_exact(&mut self, mut target: &mut [u8]) -> Result<()> {
        while !target.is_empty() {
            if self.offset == self.plaintext.len() {
                self.load_frame()?;
            }
            if self.offset == self.plaintext.len() && self.final_seen {
                return Err(invalid_archive("archive payload is truncated"));
            }
            let available = self.plaintext.len() - self.offset;
            let take = available.min(target.len());
            target[..take].copy_from_slice(&self.plaintext[self.offset..self.offset + take]);
            self.offset += take;
            target = &mut target[take..];
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        if self.offset != self.plaintext.len() {
            return Err(invalid_archive("archive contains undeclared payload bytes"));
        }
        while !self.final_seen {
            self.load_frame()?;
            if self.offset != self.plaintext.len() {
                return Err(invalid_archive("archive contains undeclared payload bytes"));
            }
        }
        Ok(())
    }

    fn load_frame(&mut self) -> Result<()> {
        if self.final_seen {
            return Err(invalid_archive("archive ended before the declared payload"));
        }
        let mut frame_header = [0u8; 5];
        self.file
            .read_exact(&mut frame_header)
            .map_err(|_| invalid_archive("archive is missing its authenticated final frame"))?;
        let flag = frame_header[0];
        if flag > 1 {
            return Err(invalid_archive("archive frame has an invalid flag"));
        }
        let length = u32::from_le_bytes(frame_header[1..5].try_into().unwrap()) as usize;
        if !(GCM_TAG_BYTES..=FRAME_PLAINTEXT_BYTES + GCM_TAG_BYTES).contains(&length) {
            return Err(invalid_archive("archive frame length is invalid"));
        }
        let mut ciphertext = vec![0u8; length];
        self.file
            .read_exact(&mut ciphertext)
            .map_err(|_| invalid_archive("archive frame is truncated"))?;
        let aad = frame_aad(&self.header, self.counter, flag);
        self.plaintext = self
            .cipher
            .decrypt(
                &Array(frame_nonce(&self.nonce_prefix, self.counter)),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| invalid_archive("wrong passphrase or damaged archive"))?;
        self.offset = 0;
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| invalid_archive("workspace frame counter exhausted"))?;
        if flag == 1 {
            self.final_seen = true;
            let mut trailing = [0u8; 1];
            if self.file.read(&mut trailing)? != 0 {
                return Err(invalid_archive(
                    "archive has trailing bytes after its final frame",
                ));
            }
        } else if self.plaintext.is_empty() {
            return Err(invalid_archive("non-final archive frame is empty"));
        }
        Ok(())
    }
}

fn archive_header(salt: &[u8; SALT_LEN], nonce_prefix: &[u8; NONCE_PREFIX_LEN]) -> Vec<u8> {
    let mut header = Vec::with_capacity(archive_header_length());
    header.extend_from_slice(ARCHIVE_MAGIC);
    header.extend_from_slice(&ARCHIVE_VERSION.to_le_bytes());
    header.push(SCRYPT_LOG_N);
    header.extend_from_slice(&SCRYPT_R.to_le_bytes());
    header.extend_from_slice(&SCRYPT_P.to_le_bytes());
    header.extend_from_slice(salt);
    header.extend_from_slice(nonce_prefix);
    header
}

fn archive_header_length() -> usize {
    ARCHIVE_MAGIC.len() + 2 + 1 + 4 + 4 + SALT_LEN + NONCE_PREFIX_LEN
}

fn parse_archive_header(header: &[u8]) -> Result<([u8; SALT_LEN], [u8; NONCE_PREFIX_LEN])> {
    if header.len() != archive_header_length() || &header[..8] != ARCHIVE_MAGIC {
        return Err(invalid_archive("archive magic does not match NoTrace"));
    }
    let version = u16::from_le_bytes(header[8..10].try_into().unwrap());
    let log_n = header[10];
    let r = u32::from_le_bytes(header[11..15].try_into().unwrap());
    let p = u32::from_le_bytes(header[15..19].try_into().unwrap());
    if version != ARCHIVE_VERSION || log_n != SCRYPT_LOG_N || r != SCRYPT_R || p != SCRYPT_P {
        return Err(invalid_archive(
            "archive version or key-derivation parameters are unsupported",
        ));
    }
    let salt = header[19..19 + SALT_LEN].try_into().unwrap();
    let nonce_prefix = header[19 + SALT_LEN..].try_into().unwrap();
    Ok((salt, nonce_prefix))
}

fn derive_key(passphrase: &str, salt: &[u8; SALT_LEN]) -> Result<Zeroizing<[u8; 32]>> {
    let params = ScryptParams::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P)
        .map_err(|_| invalid_archive("invalid scrypt parameters"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    scrypt(passphrase.as_bytes(), salt, &params, key.as_mut())
        .map_err(|_| invalid_archive("unable to derive workspace key"))?;
    Ok(key)
}

fn frame_nonce(prefix: &[u8; NONCE_PREFIX_LEN], counter: u32) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..NONCE_PREFIX_LEN].copy_from_slice(prefix);
    nonce[NONCE_PREFIX_LEN..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

fn frame_aad(header: &[u8], counter: u32, flag: u8) -> Vec<u8> {
    let mut aad = Vec::with_capacity(header.len() + 5);
    aad.extend_from_slice(header);
    aad.extend_from_slice(&counter.to_be_bytes());
    aad.push(flag);
    aad
}

fn validate_passphrase(passphrase: &str) -> Result<()> {
    let count = passphrase.chars().count();
    if !(MIN_PASSPHRASE_CHARS..=MAX_PASSPHRASE_CHARS).contains(&count) {
        return Err(CloakError::InvalidWorkspacePassphrase);
    }
    Ok(())
}

fn hash_file_with_cancellation(path: &Path, cancellation: Option<&AtomicBool>) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; FRAME_PLAINTEXT_BYTES];
    loop {
        ensure_not_cancelled(cancellation)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

fn ensure_not_cancelled(cancellation: Option<&AtomicBool>) -> Result<()> {
    if cancellation
        .map(|flag| flag.load(Ordering::Acquire))
        .unwrap_or(false)
    {
        return Err(CloakError::WorkspaceCancelled);
    }
    Ok(())
}

fn secure_dir_recursive_cancellable(path: &Path, cancellation: Option<&AtomicBool>) -> Result<()> {
    for entry in WalkDir::new(path) {
        ensure_not_cancelled(cancellation)?;
        let entry = entry.map_err(io::Error::other)?;
        if entry.file_type().is_dir() {
            secure_dir(entry.path())?;
        } else if entry.file_type().is_file() {
            secure_file(entry.path())?;
        }
    }
    Ok(())
}

fn archive_path(account: &str, relative: &Path) -> Result<String> {
    let mut parts = vec![account.to_string()];
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(invalid_archive("workspace contains an unsafe path"));
        };
        let value = value
            .to_str()
            .ok_or_else(|| invalid_archive("workspace contains a non-UTF-8 path"))?;
        parts.push(value.to_string());
    }
    Ok(parts.join("/"))
}

pub(crate) fn should_skip_archive_path(relative: &Path) -> bool {
    let components = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    let first = components.first().copied();
    if matches!(
        first,
        Some(
            ".cloak-relay"
                | ".cloak-companion"
                | "BrowserMetrics"
                | "Crashpad"
                | "DawnGraphiteCache"
                | "GraphiteDawnCache"
                | "GrShaderCache"
                | "ShaderCache"
                | "component_crx_cache"
                | "optimization_guide_model_store"
        )
    ) {
        return true;
    }
    if components.len() >= 2
        && matches!(
            components[1],
            "Cache" | "Code Cache" | "DawnCache" | "GPUCache" | "GrShaderCache"
        )
    {
        return true;
    }
    matches!(
        relative.file_name().and_then(|value| value.to_str()),
        Some("SingletonLock" | "SingletonSocket" | "SingletonCookie")
    )
}

fn reject_archive_inside_workspace(config: &CloakConfig, destination: &Path) -> Result<()> {
    let destination_parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let workspace = fs::canonicalize(&config.account_base).ok();
    let destination_parent = fs::canonicalize(destination_parent).ok();
    if destination.starts_with(&config.account_base)
        || workspace
            .zip(destination_parent)
            .is_some_and(|(workspace, destination)| destination.starts_with(workspace))
    {
        return Err(CloakError::WorkspaceConflict(
            "backup destination must be outside the account workspace".to_string(),
        ));
    }
    Ok(())
}

fn ensure_capacity(path: &Path, payload_bytes: u64) -> Result<()> {
    let reserve = (payload_bytes / 20).max(256 * 1024 * 1024);
    let required = payload_bytes
        .checked_add(reserve)
        .ok_or_else(|| invalid_archive("capacity calculation overflow"))?;
    let available = fs4::available_space(path)?;
    if available < required {
        return Err(CloakError::WorkspaceConflict(format!(
            "insufficient free space: need at least {required} bytes, have {available} bytes"
        )));
    }
    Ok(())
}

fn temporary_sibling(destination: &Path, label: &str) -> PathBuf {
    let mut random = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace.ntrace");
    destination.with_file_name(format!(".{name}.{label}.{suffix}.tmp"))
}

fn unique_staging_path(parent: &Path) -> PathBuf {
    temporary_sibling(&parent.join("notrace"), "import").with_file_name(format!(
        ".notrace-import-{}-{}",
        std::process::id(),
        current_epoch_secs()
    ))
}

fn invalid_archive(message: impl Into<String>) -> CloakError {
    CloakError::InvalidWorkspaceArchive(message.into())
}

struct DirectoryCleanup {
    path: PathBuf,
    armed: bool,
}

struct FileCleanup {
    path: PathBuf,
    armed: bool,
}

impl FileCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for FileCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl DirectoryCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DirectoryCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
