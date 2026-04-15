# GNOME Shell extension quick installer

SHELL := /bin/sh
UUID := wack-lockscreen-clock@rinzler69-wastaken.github.com
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
EXCLUDES := --exclude '.git' --exclude '.gitignore' --exclude '.codex' --exclude '.sixth' --exclude 'Makefile'

.PHONY: install enable pack

install: ## Copy the extension into the correct UUID directory
	@mkdir -p "$(DEST)"
	@rsync -a --delete $(EXCLUDES) ./ "$(DEST)/"
	@printf 'Installed to %s\n' "$(DEST)"
	@printf 'Reload GNOME Shell (Alt+F2 → r on Xorg, relogin on Wayland) then run: gnome-extensions enable %s\n' "$(UUID)"

enable: install ## Install then enable the extension
	@gnome-extensions enable "$(UUID)"

pack: ## Create a ZIP package for Extensions.gnome.org
	@printf 'Packaging extension...\n'
	@rm -f $(UUID).zip
	@zip -q $(UUID).zip extension.js metadata.json stylesheet.css LICENSE
	@printf 'Created package: %s\n' "$(UUID).zip"
