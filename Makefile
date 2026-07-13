.PHONY: install enable pack compile-po deploy-schema

compile-po: ## Compile all .po files to .mo binaries in locale/
	@python3 po/generate.py

deploy-schema: ## Symlink the schema XML to the system path and recompile
	@pkexec sh -c "ln -sf $$(pwd)/schemas/org.gnome.shell.extensions.wack-lockscreen-clock.gschema.xml /usr/share/glib-2.0/schemas/ && glib-compile-schemas /usr/share/glib-2.0/schemas/" && \
		printf 'System schema symlinked and compiled.\n' || \
		printf 'WARNING: Could not deploy system schema (pkexec failed). Run manually:\n  sudo ln -sf $$(pwd)/schemas/org.gnome.shell.extensions.wack-lockscreen-clock.gschema.xml /usr/share/glib-2.0/schemas/\n  sudo glib-compile-schemas /usr/share/glib-2.0/schemas/\n'

install: compile-po deploy-schema ## Copy the extension into the correct UUID directory
	@mkdir -p "$(DEST)"
	@rsync -a --delete $(EXCLUDES) ./ "$(DEST)/"
	@sed -i -e "s|font-family: 'SF Pro Display';|/* font-family: 'SF Pro Display'; */|g" -e "s|font-family: '\.SF Soft Numeric';|/* font-family: '.SF Soft Numeric'; */|g" "$(DEST)/stylesheet.css"
	@if [ -d "$(DEST)/schemas" ]; then glib-compile-schemas "$(DEST)/schemas"; fi
	@printf 'Installed to %s\n' "$(DEST)"
	@printf 'Reload GNOME Shell (Alt+F2 → r on Xorg, relogin on Wayland) then run: gnome-extensions enable %s\n' "$(UUID)"

enable: install ## Install then enable the extension
	@gnome-extensions enable "$(UUID)"

pack: compile-po ## Create a ZIP package for Extensions.gnome.org
	@printf 'Packaging extension...\n'
	@rm -f $(UUID).zip
	@glib-compile-schemas schemas
	@cp stylesheet.css stylesheet.css.bak
	@sed -i -e "s|font-family: 'SF Pro Display';|/* font-family: 'SF Pro Display'; */|g" -e "s|font-family: '\.SF Soft Numeric';|/* font-family: '.SF Soft Numeric'; */|g" stylesheet.css
	@zip -qr $(UUID).zip *.js metadata.json stylesheet.css LICENSE schemas locale -x "schemas/gschemas.compiled" -x "po/generate.py"
	@mv stylesheet.css.bak stylesheet.css
	@printf 'Created package: %s\n' "$(UUID).zip"
