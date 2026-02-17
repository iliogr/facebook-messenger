.PHONY: install start dev build build-mac build-win build-all clean \
       release-patch release-minor release-major version-patch version-minor version-major \
       publish push

VERSION = $(shell node -p 'require("./package.json").version')

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
	@echo "Built v$(VERSION)"

release-minor: version-minor build-all
	@echo "Built v$(VERSION)"

release-major: version-major build-all
	@echo "Built v$(VERSION)"

# Push commits + tags to GitHub
push:
	git push origin main --tags

# Create a GitHub release with binaries (run after release-* and push)
publish: push
	gh release create v$(VERSION) \
		"dist/Messenger-$(VERSION)-universal.dmg#Messenger macOS (Universal - Intel + Apple Silicon)" \
		"dist/Messenger Setup $(VERSION).exe#Messenger Windows (x64 Installer)" \
		--title "Messenger Desktop v$(VERSION)" \
		--generate-notes
	@echo "Published https://github.com/iliogr/facebook-messenger/releases/tag/v$(VERSION)"

# Remove build artifacts
clean:
	rm -rf dist/
	rm -rf node_modules/
