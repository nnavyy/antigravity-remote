use std::{
    fs,
    io::{self, Write},
    path::Path,
};

pub fn lock_instance(data_dir: &Path) -> io::Result<fs::File> {
    fs::create_dir_all(data_dir)?;
    let mut options = fs::File::options();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ lets Git inspect the empty lock while refusing a second writer.
        options.share_mode(1);
    }
    let file = options.open(data_dir.join(".bridge.lock"))?;
    #[cfg(not(windows))]
    file.try_lock()?;
    Ok(file)
}

// Keep the previous document intact if serialization or writing fails.
pub fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
