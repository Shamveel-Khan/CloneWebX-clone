<?php
/**
 * E2E helper (wp eval-file): create the import job from /tmp/pkg.zip the same
 * way the admin flow does — using the plugin's own extraction code path.
 */

require_once ABSPATH . 'wp-admin/includes/file.php';

$uploads = wp_upload_dir();
$dest    = trailingslashit( $uploads['basedir'] ) . 'sri-import-1-' . time();

$result = SRI_Package::extract_zip( '/tmp/pkg.zip', $dest );
if ( is_wp_error( $result ) ) {
	echo 'UNZIP FAILED: ' . $result->get_error_message() . "\n";
	exit( 1 );
}

$package = json_decode( (string) file_get_contents( $dest . '/package.json' ), true ); // phpcs:ignore
if ( ! is_array( $package ) || empty( $package['pages'] ) ) {
	echo "BAD PACKAGE\n";
	exit( 1 );
}

update_option(
	'sri_job',
	array(
		'dir'       => $dest,
		'package'   => $package,
		'map'       => array(),
		'templates' => array(),
		'results'   => array(),
		'created'   => time(),
	),
	false
);

echo 'job ready: ' . $dest . ' (' . count( $package['pages'] ) . " pages)\n";
