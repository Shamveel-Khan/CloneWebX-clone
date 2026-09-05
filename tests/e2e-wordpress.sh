#!/usr/bin/env bash
# End-to-end test: import the fixture package into a fresh WordPress +
# Elementor stack (Docker) and verify pages, templates, media, menu and
# frontend rendering.
#
# Usage: tests/e2e-wordpress.sh [path-to-package.zip]
set -uxo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${1:-/tmp/sr-test-package.zip}"
ELEMENTOR_ZIP="${ELEMENTOR_ZIP:-/tmp/elementor.zip}"
NET=sr-e2e-net
DB=sr-e2e-db
WP=sr-e2e-wp
PORT=8099
CLI_IMG="wordpress:cli-php8.2"

# Elementor is fetched on the host (container egress is unreliable) and
# installed from a mounted file. Validate the archive — an interrupted
# download leaves a corrupt zip that PclZip rejects mid-import.
need_download=1
if [ -s "$ELEMENTOR_ZIP" ] && python3 -c "import zipfile,sys; sys.exit(0 if zipfile.ZipFile('$ELEMENTOR_ZIP').testzip() is None else 1)" 2>/dev/null; then
  need_download=0
fi
if [ "$need_download" = 1 ]; then
  rm -f "$ELEMENTOR_ZIP"
  for attempt in 1 2 3; do
    curl -fsSL -o "$ELEMENTOR_ZIP" https://downloads.wordpress.org/plugin/elementor.latest-stable.zip || { sleep 4; continue; }
    python3 -c "import zipfile,sys; sys.exit(0 if zipfile.ZipFile('$ELEMENTOR_ZIP').testzip() is None else 1)" 2>/dev/null && break
    echo "retry $attempt: downloaded elementor zip failed validation"
    sleep 4
  done
fi
[ -s "$ELEMENTOR_ZIP" ] || { echo "E2E FAILED: could not download a valid Elementor zip" >&2; exit 1; }

cleanup() {
  docker rm -f "$DB" "$WP" 2>/dev/null || true
  docker network rm "$NET" 2>/dev/null || true
  docker volume rm wproot 2>/dev/null || true
}
trap cleanup EXIT
cleanup

# cli image tag fallback
docker image inspect "$CLI_IMG" >/dev/null 2>&1 || CLI_IMG="wordpress:cli"

docker network create "$NET"

docker run -d --name "$DB" --network "$NET" \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=wp -e MYSQL_USER=wp -e MYSQL_PASSWORD=wp \
  mariadb:10.11
sleep 14

docker run -d --name "$WP" --network "$NET" -p "$PORT:80" \
  -e WORDPRESS_DB_HOST="$DB:3306" -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp -e WORDPRESS_DB_NAME=wp \
  -v wproot:/var/www/html \
  -v "$ROOT/wp-plugin/site-rebuilder-importer:/var/www/html/wp-content/plugins/site-rebuilder-importer:ro" \
  -v "$PKG:/tmp/pkg.zip:ro" \
  wordpress:php8.2-apache
sleep 10

cli() {
  if ! docker run --rm --network "$NET" --user 33:33 -e HOME=/tmp \
    -e WORDPRESS_DB_HOST="$DB:3306" -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp -e WORDPRESS_DB_NAME=wp \
    -v wproot:/var/www/html \
    -v "$ROOT/wp-plugin/site-rebuilder-importer:/var/www/html/wp-content/plugins/site-rebuilder-importer:ro" \
    -v "$PKG:/tmp/pkg.zip:ro" \
    -v "$ELEMENTOR_ZIP:/tmp/elementor.zip:ro" \
    -v "$ROOT/tests/wp:/e2e:ro" \
    "$CLI_IMG" "$@"; then
    echo "E2E FAILED at: wp $*" >&2
    exit 1
  fi
}

cli wp core install --url="http://localhost:$PORT" --title="SR E2E" \
  --admin_user=admin --admin_password=admin --admin_email=admin@example.com --skip-email

cli wp plugin install /tmp/elementor.zip --activate
cli wp plugin activate site-rebuilder-importer
cli wp plugin list

# Make sure Flexbox containers are active (default since 3.19; force anyway).
cli wp option update elementor_experiment-container active || true

cli wp eval-file /e2e/init-job.php
cli wp eval-file /e2e/run-import.php

echo '--- pages ---'
cli wp post list --post_type=page --fields=ID,post_title,post_name,post_status
echo '--- elementor library (header/footer templates) ---'
cli wp post list --post_type=elementor_library --fields=ID,post_title,post_name
echo '--- attachments ---'
cli wp post list --post_type=attachment --fields=ID,post_title,guid
echo '--- menus ---'
cli wp menu list --fields=term_id,name,slug

echo '--- elementor meta on the home page ---'
HOME_ID="$(cli wp post list --post_type=page --name=home --field=ID)"
echo "home page id: $HOME_ID"
cli wp post meta get "$HOME_ID" _elementor_edit_mode
cli wp post meta get "$HOME_ID" _elementor_template_type
cli wp eval "echo 'widgets on home: ' . preg_match_all('/\"widgetType\"/', (string) get_post_meta($HOME_ID, '_elementor_data', true)) . \"\n\";"
cli wp eval "echo 'asset urls remapped: ' . preg_match_all('/wp-content\/uploads/', (string) get_post_meta($HOME_ID, '_elementor_data', true)) . \"\n\";"

echo '--- frontend render ---'
sleep 3
HTML="$(curl -s "http://localhost:$PORT/?pagename=home")"
echo "$HTML" | grep -o 'We design websites that ship fast' | head -1
echo "$HTML" | grep -o 'elementor-widget-heading' | head -1
echo "$HTML" | grep -o 'elementor-widget-button' | head -1
echo "elementor-widget occurrences: $(echo "$HTML" | grep -c 'elementor-widget')"
echo "uploads image referenced: $(echo "$HTML" | grep -c 'wp-content/uploads')"

echo '--- kit styles ---'
cli wp eval "\$k = get_option('elementor_active_kit'); echo 'kit: ' . \$k . \"\n\"; \$d = (string) get_post_meta(\$k, '_elementor_data', true); echo 'body_typography_typography: ' . (strpos(\$d, 'body_typography_typography') !== false ? 'yes' : 'no') . \"\n\";"

echo 'E2E COMPLETE'
