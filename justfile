export RUST_LOG :="info"
final_bin_name := "cli"

run:
    cargo run
check:
    cargo check
fix:
    cargo fix --allow-dirty --allow-staged
test name="":
    cargo test {{name}} -- --nocapture --test-threads=1
doc:
    cargo doc --open
update:
    cargo update
clean:
    cargo clean
publish:
    cargo publish
tree:
    cargo tree
fmt:
    cargo fmt
clippy:
    cargo clippy
docker:
    docker build -t myapp .
# Tauri development
tb:
    npm run tauri build
tr:    
    npm run tauri dev

# Tauri builds for different macOS architectures
# Apple Silicon (M1/M2/M3)
tb-arm:
    npm run tauri build

# Intel x86_64
tb-x64:
    rustup target add x86_64-apple-darwin
    npm run tauri build -- --target x86_64-apple-darwin

# Universal binary (both architectures)
tb-universal:
    rustup target add x86_64-apple-darwin
    npm run tauri build -- --target universal-apple-darwin

# Build all architectures
tb-all: tb-arm tb-x64
    @echo "All builds completed!"
    @echo "  - Apple Silicon: src-tauri/target/release/bundle/dmg/"
    @echo "  - Intel x86_64:  src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/"

# Windows x86_64 (cross compile from macOS, requires mingw-w64)
# ⚠️ 注意：交叉编译的 Windows 版本需要用户手动安装 WebView2 Runtime
tb-windows:
    @echo "Installing dependencies..."
    @brew install mingw-w64 2>/dev/null || true
    @rustup target add x86_64-pc-windows-gnu 2>/dev/null || true
    @mkdir -p .cargo
    @echo "[target.x86_64-pc-windows-gnu]" > .cargo/config.toml
    @echo 'linker = "x86_64-w64-mingw32-gcc"' >> .cargo/config.toml
    @echo 'rustflags = ["-C", "target-feature=+crt-static", "-C", "link-arg=-static"]' >> .cargo/config.toml
    @echo "" >> .cargo/config.toml
    @echo "[env]" >> .cargo/config.toml
    @echo 'CC_x86_64_pc_windows_gnu = "x86_64-w64-mingw32-gcc"' >> .cargo/config.toml
    @echo 'CXX_x86_64_pc_windows_gnu = "x86_64-w64-mingw32-g++"' >> .cargo/config.toml
    @echo "Building Windows executable..."
    @echo "⚠️  注意：交叉编译需要 Windows 用户安装 WebView2 Runtime"
    @echo "    详见 WINDOWS_INSTALL.md"
    npm run tauri build -- --target x86_64-pc-windows-gnu 2>&1 | tail -20
    @echo ""
    @echo "✅ Windows build complete!"
    @ls -lh src-tauri/target/x86_64-pc-windows-gnu/release/*.exe
    @echo ""
    @echo "📋 分发前请确保："
    @echo "   1. 附带 WINDOWS_INSTALL.md 说明文件"
    @echo "   2. 告知用户需要安装 WebView2 Runtime"
    @echo "   下载地址：https://go.microsoft.com/fwlink/p/?LinkId=2124703"

macos bin_name="" :
    if [ -z "{{bin_name}}" ];then \
        cargo install --path . --root ~/.dev ; \
    else \
        cargo install --path . --root ~/.dev --bin "{{bin_name}}" ; \
    fi 
linux bin_name="" :
    if [ ! -f .cargo/config.toml ];then \
        mkdir -p .cargo && echo '[target.x86_64-unknown-linux-musl]\nlinker = "x86_64-linux-musl-gcc"' > .cargo/config.toml; \
    fi
    if [ -z "{{bin_name}}" ];then \
        cargo build --release --target x86_64-unknown-linux-musl; \
    else \
        cargo build --bin {{bin_name}} --release --target x86_64-unknown-linux-musl; \
    fi 
    rm -rf bin && mkdir -p bin && mv target/x86_64-unknown-linux-musl/release/{{bin_name}} bin/{{bin_name}}  && chmod +x bin/{{bin_name}}
    du -sh bin/{{bin_name}}
    s3cmd put bin/{{bin_name}} s3://work/test/
    @echo "curl -O http://inner-s3-model.hinadt.com/work/test/{{bin_name}} && chmod +x {{bin_name}} "
    @# echo "curl -O https://s3-model.hinadt.com/work/test/{{bin_name}} && chmod +x {{bin_name}} "
    rm -rf bin