UUID = wack-lockscreen-clock@rinzler69-wastaken.github.com
DEST = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
EXCLUDES = --exclude=".git*" --exclude="*.zip" --exclude="*.bak" --exclude="checkthisthingblyat" --exclude="scripts" --exclude="crossSessionManager.js" --exclude="pro.js" --exclude="src/pro*"

.PHONY: install enable pack poke compile-po deploy-schema install-gdm uninstall-gdm

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
	@python3 -c "import re; c=open('stylesheet.css').read(); c=re.sub(r'/\*\s*<GDM_EXCLUDE>\s*\*/.*?/\*\s*</GDM_EXCLUDE>\s*\*/', '', c, flags=re.DOTALL); open('stylesheet.css','w').write(c)"
	@sed -i -e "s|font-family: 'SF Pro Display';|/* font-family: 'SF Pro Display'; */|g" -e "s|font-family: '\.SF Soft Numeric';|/* font-family: '.SF Soft Numeric'; */|g" stylesheet.css
	@cp metadata.json metadata.json.bak
	@python3 -c "import json; d=json.load(open('metadata.json')); d['session-modes'] = [m for m in d.get('session-modes', []) if m != 'gdm']; d['version-name'] = str(d.get('version-name', '')).replace(' PRO', '').replace('PRO', '').strip(); json.dump(d, open('metadata.json','w'), indent=2)"
	@python3 -c "import glob, re; [open(f + '.bak', 'w').write(c) and None or open(f, 'w').write(re.sub(r'//\s*<GDM_EXCLUDE>.*?//\s*</GDM_EXCLUDE>', '', c, flags=re.DOTALL)) for f in glob.glob('**/*.js', recursive=True) if not f.endswith('.bak') for c in [open(f).read()] if '<GDM_EXCLUDE>' in c]"
	@zip -qr $(UUID).zip *.js src/main src/prefs metadata.json stylesheet.css LICENSE schemas locale -x "schemas/gschemas.compiled" -x "po/generate.py" -x "scripts/*" -x "crossSessionManager.js" -x "pro.js" -x "src/pro/*" -x "*.bak"
	@python3 -c "import glob, os; [os.replace(f, f[:-4]) for f in glob.glob('**/*.js.bak', recursive=True)]"
	@mv stylesheet.css.bak stylesheet.css
	@mv metadata.json.bak metadata.json
	@printf 'Created package: %s\n' "$(UUID).zip"

poke: pack ## Verify that the packaged EGO ZIP contains zero GDM-only code or markers and passes shexli
	@python3 scripts/poke-ego-artifact.py $(UUID).zip
	@if command -v shexli >/dev/null 2>&1; then shexli $(UUID).zip; fi

install-gdm: ## Install GDM expansion DLC system-wide
	@bash scripts/install-gdm-dlc.sh

uninstall-gdm: ## Uninstall GDM expansion DLC
	@bash scripts/uninstall-gdm-dlc.sh