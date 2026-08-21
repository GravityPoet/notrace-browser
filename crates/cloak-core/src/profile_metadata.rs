use super::{
    account_created_at, current_epoch_secs, gpu_bucket_for_seed, legacy_seed, pinned_seed,
    secure_dir, secure_file, sync_directory, validate_account_name, write_secret_atomic,
    CloakConfig, CloakError, Result,
};
use fs4::FileExt;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::path::Path;

pub(crate) const PROFILE_METADATA_NAME: &str = ".cloak-profile.json";
pub(crate) const PROFILE_METADATA_BACKUP_1: &str = ".cloak-profile.json.bak1";
pub(crate) const PROFILE_METADATA_BACKUP_2: &str = ".cloak-profile.json.bak2";
const PROFILE_METADATA_LOCK: &str = ".cloak-profile-metadata.lock";
const PROFILE_OWNER: &str = "local.cloak.picker";
const PROFILE_SCHEMA_VERSION: u32 = 1;
const IDENTITY_SCHEMA_VERSION: u32 = 1;
const HARDWARE_PROFILE_ID: &str = "mac-apple-silicon-base-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileMetadata {
    pub schema_version: u32,
    pub owner: String,
    pub profile_id: String,
    pub serial: u64,
    pub identity_schema_version: u32,
    pub hardware_profile_id: String,
    pub gpu_bucket: String,
    pub render_identity_version: u32,
}

impl ProfileMetadata {
    fn new(serial: u64, seed: &str) -> Self {
        Self {
            schema_version: PROFILE_SCHEMA_VERSION,
            owner: PROFILE_OWNER.to_string(),
            profile_id: random_profile_id(),
            serial,
            identity_schema_version: IDENTITY_SCHEMA_VERSION,
            hardware_profile_id: HARDWARE_PROFILE_ID.to_string(),
            gpu_bucket: gpu_bucket_for_seed(seed).to_string(),
            render_identity_version: 1,
        }
    }

    pub fn is_owned_by_notrace(&self) -> bool {
        self.owner == PROFILE_OWNER
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(serial: u64, profile_id: &str, gpu_bucket: &str) -> Self {
        Self {
            schema_version: PROFILE_SCHEMA_VERSION,
            owner: PROFILE_OWNER.to_string(),
            profile_id: profile_id.to_string(),
            serial,
            identity_schema_version: IDENTITY_SCHEMA_VERSION,
            hardware_profile_id: HARDWARE_PROFILE_ID.to_string(),
            gpu_bucket: gpu_bucket.to_string(),
            render_identity_version: 1,
        }
    }
}

pub(crate) fn ensure_workspace_profile_metadata(config: &CloakConfig) -> Result<()> {
    fs::create_dir_all(&config.account_base)?;
    secure_dir(&config.account_base)?;
    let _lock = metadata_lock(config)?;

    let mut max_serial = 0;
    let mut profile_ids = HashSet::new();
    let mut serials = HashSet::new();
    let mut legacy_profiles = Vec::new();
    for entry in fs::read_dir(&config.account_base)? {
        let entry = entry?;
        let profile_path = entry.path();
        if !profile_path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "main" || name.starts_with('.') || validate_account_name(&name).is_err() {
            continue;
        }
        match read_or_recover_profile_metadata(&profile_path) {
            Ok(Some(metadata)) => {
                if !profile_ids.insert(metadata.profile_id.clone())
                    || !serials.insert(metadata.serial)
                {
                    return Err(CloakError::InvalidProfileMetadata(format!(
                        "duplicate permanent identity or environment number: {name}"
                    )));
                }
                max_serial = max_serial.max(metadata.serial);
            }
            Ok(None) => {
                let created_at = account_created_at(&profile_path).unwrap_or_default();
                legacy_profiles.push((created_at, name, profile_path));
            }
            Err(err) => {
                eprintln!("profile metadata for {name:?} could not be recovered: {err}");
            }
        }
    }

    legacy_profiles.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for (_, name, profile_path) in legacy_profiles {
        max_serial = max_serial.saturating_add(1);
        let seed = pinned_seed(&profile_path)?.unwrap_or_else(|| legacy_seed(&name));
        write_new_profile_metadata(&profile_path, &ProfileMetadata::new(max_serial, &seed))?;
    }
    Ok(())
}

pub(crate) fn ensure_profile_metadata(
    config: &CloakConfig,
    name: &str,
    profile_path: &Path,
    seed: &str,
) -> Result<ProfileMetadata> {
    let _lock = metadata_lock(config)?;
    if let Some(metadata) = read_or_recover_profile_metadata(profile_path)? {
        return Ok(metadata);
    }
    let serial = next_serial_locked(config)?;
    let metadata = ProfileMetadata::new(serial, seed);
    write_new_profile_metadata(profile_path, &metadata)?;
    if metadata.profile_id.is_empty() {
        return Err(CloakError::InvalidProfileMetadata(format!(
            "{name}: empty profile id"
        )));
    }
    Ok(metadata)
}

pub(crate) fn require_profile_owner(profile_path: &Path) -> Result<ProfileMetadata> {
    let Some(metadata) = read_or_recover_profile_metadata(profile_path)? else {
        return Err(CloakError::ProfileOwnerMismatch(
            profile_path.display().to_string(),
        ));
    };
    if !metadata.is_owned_by_notrace() {
        return Err(CloakError::ProfileOwnerMismatch(
            profile_path.display().to_string(),
        ));
    }
    Ok(metadata)
}

pub(crate) fn read_or_recover_profile_metadata(
    profile_path: &Path,
) -> Result<Option<ProfileMetadata>> {
    let current = profile_path.join(PROFILE_METADATA_NAME);
    let backup_1 = profile_path.join(PROFILE_METADATA_BACKUP_1);
    let backup_2 = profile_path.join(PROFILE_METADATA_BACKUP_2);

    match read_metadata_file(&current) {
        Ok(Some(metadata)) => {
            heal_backup_replicas(&backup_1, &backup_2, &metadata)?;
            return Ok(Some(metadata));
        }
        Ok(None) => {}
        Err(current_error) => {
            for backup in [&backup_1, &backup_2] {
                if let Ok(Some(metadata)) = read_metadata_file(backup) {
                    quarantine_corrupt_metadata(&current)?;
                    write_metadata_file(&current, &metadata)?;
                    heal_backup_replicas(&backup_1, &backup_2, &metadata)?;
                    return Ok(Some(metadata));
                }
            }
            return Err(current_error);
        }
    }

    for backup in [&backup_1, &backup_2] {
        if let Ok(Some(metadata)) = read_metadata_file(backup) {
            write_metadata_file(&current, &metadata)?;
            heal_backup_replicas(&backup_1, &backup_2, &metadata)?;
            return Ok(Some(metadata));
        }
    }
    Ok(None)
}

fn heal_backup_replicas(
    backup_1: &Path,
    backup_2: &Path,
    authoritative: &ProfileMetadata,
) -> Result<()> {
    for backup in [backup_1, backup_2] {
        let healthy = read_metadata_file(backup)
            .map(|metadata| {
                metadata.is_some_and(|metadata| {
                    metadata.profile_id == authoritative.profile_id
                        && metadata.serial == authoritative.serial
                })
            })
            .unwrap_or(false);
        if !healthy {
            write_metadata_file(backup, authoritative)?;
        }
    }
    Ok(())
}

pub(crate) fn replace_profile_metadata_all(
    profile_path: &Path,
    metadata: &ProfileMetadata,
) -> Result<()> {
    validate_metadata(metadata, profile_path)?;
    write_metadata_file(&profile_path.join(PROFILE_METADATA_NAME), metadata)?;
    write_metadata_file(&profile_path.join(PROFILE_METADATA_BACKUP_1), metadata)?;
    write_metadata_file(&profile_path.join(PROFILE_METADATA_BACKUP_2), metadata)
}

fn write_new_profile_metadata(profile_path: &Path, metadata: &ProfileMetadata) -> Result<()> {
    validate_metadata(metadata, profile_path)?;
    write_metadata_file(&profile_path.join(PROFILE_METADATA_NAME), metadata)?;
    write_metadata_file(&profile_path.join(PROFILE_METADATA_BACKUP_1), metadata)?;
    write_metadata_file(&profile_path.join(PROFILE_METADATA_BACKUP_2), metadata)
}

fn read_metadata_file(path: &Path) -> Result<Option<ProfileMetadata>> {
    if !path.exists() {
        return Ok(None);
    }
    let body = fs::read_to_string(path)?;
    let metadata = serde_json::from_str::<ProfileMetadata>(&body)
        .map_err(|err| CloakError::InvalidProfileMetadata(format!("{}: {err}", path.display())))?;
    validate_metadata(&metadata, path)?;
    Ok(Some(metadata))
}

fn validate_metadata(metadata: &ProfileMetadata, path: &Path) -> Result<()> {
    let valid_bucket = super::gpu_renderer_for_bucket(&metadata.gpu_bucket).is_some();
    if metadata.schema_version != PROFILE_SCHEMA_VERSION
        || metadata.owner != PROFILE_OWNER
        || !valid_profile_id(&metadata.profile_id)
        || metadata.serial == 0
        || metadata.identity_schema_version != IDENTITY_SCHEMA_VERSION
        || metadata.hardware_profile_id != HARDWARE_PROFILE_ID
        || !valid_bucket
        || metadata.render_identity_version == 0
    {
        return Err(CloakError::InvalidProfileMetadata(
            path.display().to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn valid_profile_id(value: &str) -> bool {
    value.len() == 36
        && value.starts_with("ntp_")
        && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn write_metadata_file(path: &Path, metadata: &ProfileMetadata) -> Result<()> {
    let encoded = format!("{}\n", serde_json::to_string_pretty(metadata)?);
    write_secret_atomic(path, &encoded)
}

fn quarantine_corrupt_metadata(current: &Path) -> Result<()> {
    if !current.exists() {
        return Ok(());
    }
    let parent = current.parent().unwrap_or_else(|| Path::new("."));
    let mut random = [0u8; 4];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let quarantine = parent.join(format!(
        "{PROFILE_METADATA_NAME}.corrupt.{}.{suffix}",
        current_epoch_secs()
    ));
    fs::rename(current, quarantine)?;
    sync_directory(parent)?;
    Ok(())
}

fn metadata_lock(config: &CloakConfig) -> Result<File> {
    fs::create_dir_all(&config.account_base)?;
    secure_dir(&config.account_base)?;
    let path = config.account_base.join(PROFILE_METADATA_LOCK);
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .truncate(false)
        .write(true)
        .open(&path)?;
    secure_file(&path)?;
    <File as FileExt>::lock(&file)?;
    Ok(file)
}

fn next_serial_locked(config: &CloakConfig) -> Result<u64> {
    let mut max_serial = 0;
    for entry in fs::read_dir(&config.account_base)? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(Some(metadata)) = read_or_recover_profile_metadata(&entry.path()) {
            max_serial = max_serial.max(metadata.serial);
        }
    }
    Ok(max_serial.saturating_add(1))
}

fn random_profile_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut encoded = String::with_capacity(36);
    encoded.push_str("ntp_");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}
