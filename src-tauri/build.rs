fn main() {
    // Do not inject extra /MANIFESTINPUT here: Tauri already embeds a Windows
    // app manifest via resource.lib. A second MANIFEST resource makes link.exe
    // fail with CVT1100 "duplicate resource" (release Windows-x64 on v0.1.9).
    tauri_build::build()
}
