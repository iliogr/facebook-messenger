.PHONY: install start dev build build-mac build-win build-all clean \
       release-patch release-minor release-major version-patch version-minor version-major

# Install dependencies
install:
	npm install

# Run in development mode
start:
	npm start

dev: start

# Build for macOS (universal: Intel + Apple Silicon)
build-mac:
	npm run build

# Build for Windows (x64 NSIS installer)
build-win:
	npm run build:win

# Build for all platforms
build-all:
	npm run build:all

build: build-all

# Bump version only (creates git commit + tag)
version-patch:
	npm version patch

version-minor:
	npm version minor

version-major:
	npm version major

# Bump version + build all platforms
release-patch: version-patch build-all
	@echo "Released $$(node -p 'require("./package.json").version')"

release-minor: version-minor build-all
	@echo "Released $$(node -p 'require("./package.json").version')"

release-major: version-major build-all
	@echo "Released $$(node -p 'require("./package.json").version')"

# Remove build artifacts
clean:
	rm -rf dist/
	rm -rf node_modules/
