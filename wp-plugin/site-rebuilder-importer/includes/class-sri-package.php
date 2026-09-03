<?php
/**
 * Package handling: unzip the uploaded export and create the import job.
 *
 * @package SiteRebuilder
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class SRI_Package {

	/**
	 * Move the uploaded ZIP, extract it and store the import job in options.
	 *
	 * @param array $file Entry from $_FILES.
	 * @return true|WP_Error
	 */
	public static function create_job_from_upload( $file ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';

		$moved = wp_handle_upload(
			$file,
			array(
				'test_form' => false,
				'test_type' => false,
				'mimes'     => array( 'zip' => 'application/zip' ),
			)
		);
		if ( ! is_array( $moved ) || empty( $moved['file'] ) ) {
			$msg = is_array( $moved ) && isset( $moved['error'] ) ? $moved['error'] : 'Could not store the uploaded file.';
			return new WP_Error( 'sri_upload', $msg );
		}

		$upload_dir = wp_upload_dir();
		$dest       = trailingslashit( $upload_dir['basedir'] ) . 'sri-import-' . get_current_user_id() . '-' . time();

		$unzipped = unzip_file( $moved['file'], $dest );
		wp_delete_file( $moved['file'] );
		if ( is_wp_error( $unzipped ) ) {
			self::rrmdir( $dest );
			return new WP_Error(
				'sri_unzip',
				'Could not extract the ZIP: ' . $unzipped->get_error_message() . ' (your host may require FTP credentials for file writes).'
			);
		}

		$pkg_path = $dest . '/package.json';
		if ( ! file_exists( $pkg_path ) ) {
			self::rrmdir( $dest );
			return new WP_Error( 'sri_package', 'package.json not found — is this a Site Rebuilder export?' );
		}
		$package = json_decode( (string) file_get_contents( $pkg_path ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		if ( ! is_array( $package ) || empty( $package['pages'] ) || ! is_array( $package['pages'] ) ) {
			self::rrmdir( $dest );
			return new WP_Error( 'sri_package', 'package.json is invalid or contains no pages.' );
		}

		$job = array(
			'dir'      => $dest,
			'package'  => $package,
			'map'      => array(),   // package asset path → media library URL.
			'templates' => array(),  // which → template post ID.
			'results'  => array(),
			'created'  => time(),
		);
		update_option( SRI_OPTION_JOB, $job, false );

		return true;
	}

	/**
	 * Recursively delete a directory (used for extracted packages).
	 *
	 * @param string $dir Absolute path.
	 */
	public static function rrmdir( $dir ) {
		if ( ! is_string( $dir ) || '' === $dir || ! is_dir( $dir ) ) {
			return;
		}
		// Defensive: only ever delete inside wp-uploads with our prefix.
		$upload_dir = wp_upload_dir();
		if ( 0 !== strpos( trailingslashit( $dir ), trailingslashit( $upload_dir['basedir'] ) ) ) {
			return;
		}
		if ( 0 !== strpos( basename( $dir ), 'sri-import-' ) ) {
			return;
		}
		$items = @scandir( $dir );
		if ( ! is_array( $items ) ) {
			return;
		}
		foreach ( array_diff( $items, array( '.', '..' ) ) as $item ) {
			$path = $dir . '/' . $item;
			if ( is_dir( $path ) ) {
				self::rrmdir( $path );
			} else {
				wp_delete_file( $path );
			}
		}
		@rmdir( $dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
	}
}
