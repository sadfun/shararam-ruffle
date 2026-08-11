fn main() {
    println!("cargo:rerun-if-changed=../web");
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build();
    }
}
